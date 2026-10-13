/**
 * Demo shop: storefront + order API + webhook receiver.
 * The order state is driven by signed, de-duplicated webhooks from the payment provider.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRaw, parseJson, send } from './http';
import { PROVIDER_URL, SHOP_PROVIDER_KEY, SHOP_URL, WEBHOOK_SECRET } from './config';

const PRODUCTS = [
  { id: 'tee', name: 'T-Shirt', price: 2500 },
  { id: 'mug', name: 'Mug', price: 1200 },
];

type OrderStatus =
  | 'open' | 'payment_pending' | 'paid' | 'payment_failed'
  | 'payment_mismatch' | 'partially_refunded' | 'refunded';

interface Order {
  id: string;
  status: OrderStatus;
  amount: number;
  currency: 'EUR';
  paymentId: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null; // hash of the pay request that used idempotencyKey
  refundedAmount: number;
  processedEvents: Set<string>;
}

const view = (o: Order) => ({
  id: o.id,
  status: o.status,
  amount: o.amount,
  currency: o.currency,
  paymentId: o.paymentId,
  refundedAmount: o.refundedAmount,
});

export function createShop(): http.Server {
  const orders = new Map<string, Order>();
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

  const providerHeaders = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${SHOP_PROVIDER_KEY}`,
    ...extra,
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://shop');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(html);
    }
    if (method === 'GET' && url.pathname === '/api/products') return send(res, 200, PRODUCTS);

    // --- create order: the amount is always computed server-side ---
    if (method === 'POST' && url.pathname === '/api/orders') {
      const body = parseJson(await readRaw(req));
      const items = body?.items;
      if (!Array.isArray(items) || items.length === 0) return send(res, 400, { error: 'invalid_items' });
      let amount = 0;
      for (const item of items) {
        const product = PRODUCTS.find((p) => p.id === item?.productId);
        if (!product || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
          return send(res, 400, { error: 'invalid_items' });
        }
        amount += product.price * item.quantity;
      }
      const order: Order = {
        id: `ord_${crypto.randomUUID()}`,
        status: 'open',
        amount,
        currency: 'EUR',
        paymentId: null,
        idempotencyKey: null,
        requestFingerprint: null,
        refundedAmount: 0,
        processedEvents: new Set(),
      };
      orders.set(order.id, order);
      return send(res, 201, view(order));
    }

    // --- provider webhooks: verify signature, de-duplicate, apply state transition ---
    if (method === 'POST' && url.pathname === '/webhooks/payments') {
      const raw = await readRaw(req);
      const received = Buffer.from(String(req.headers['x-signature'] ?? ''));
      const expected = Buffer.from(
        'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      );
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return send(res, 401, { error: 'invalid_signature' });
      }
      const event = parseJson(raw);
      if (!event?.id || !event?.data?.orderId) return send(res, 400, { error: 'invalid_event' });

      const order = orders.get(event.data.orderId);
      if (!order) return send(res, 404, { error: 'unknown_order' });
      if (order.processedEvents.has(event.id)) return send(res, 200, { duplicate: true });
      order.processedEvents.add(event.id);
      if (order.paymentId !== event.data.paymentId) return send(res, 200, { ignored: true });

      switch (event.type) {
        case 'payment.succeeded':
          if (order.status === 'payment_pending') {
            const matches = event.data.amount === order.amount && event.data.currency === order.currency;
            order.status = matches ? 'paid' : 'payment_mismatch';
          }
          break;
        case 'payment.failed':
          if (order.status === 'payment_pending') order.status = 'payment_failed';
          break;
        case 'payment.refunded':
          if (['paid', 'partially_refunded', 'refunded'].includes(order.status)) {
            // absolute value from the provider => applying the same event twice is harmless
            order.refundedAmount = Number(event.data.refundedAmount);
            order.status = order.refundedAmount >= order.amount ? 'refunded' : 'partially_refunded';
          }
          break;
      }
      return send(res, 200, { ok: true });
    }

    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)(\/pay|\/refund)?$/);
    if (orderMatch) {
      const order = orders.get(orderMatch[1]);
      if (!order) return send(res, 404, { error: 'not_found' });

      if (method === 'GET' && !orderMatch[2]) return send(res, 200, view(order));

      // --- pay ---
      if (method === 'POST' && orderMatch[2] === '/pay') {
        const body = parseJson(await readRaw(req));
        if (!body || typeof body.card !== 'string' || body.card === '') {
          return send(res, 400, { error: 'card_required' });
        }
        const key = String(req.headers['idempotency-key'] ?? crypto.randomUUID());

        const fingerprint = crypto.createHash('sha256').update(body.card).digest('hex');

        // Same key as the attempt we already know => safe retry, return current state.
        // The same key with a DIFFERENT request is a client bug and must not be accepted silently.
        if (order.status !== 'open' && order.idempotencyKey === key) {
          if (order.requestFingerprint !== fingerprint) {
            return send(res, 409, { error: 'idempotency_key_reused_with_different_request' });
          }
          return send(res, 200, view(order));
        }
        // Anything but open / failed means a payment is running or done => never start a second one
        if (order.status !== 'open' && order.status !== 'payment_failed') {
          return send(res, 409, { error: 'order_not_payable', status: order.status });
        }

        // The state is switched BEFORE the first await, so concurrent requests cannot both pass
        order.status = 'payment_pending';
        order.idempotencyKey = key;
        order.requestFingerprint = fingerprint;
        order.paymentId = null;
        try {
          const r = await fetch(`${PROVIDER_URL}/payments`, {
            method: 'POST',
            headers: providerHeaders({ 'idempotency-key': key }),
            body: JSON.stringify({
              amount: order.amount,
              currency: order.currency,
              orderId: order.id,
              card: body.card,
              webhookUrl: `${SHOP_URL}/webhooks/payments`,
            }),
          });
          if (!r.ok) {
            order.status = 'payment_failed';
            return send(res, 502, { error: 'provider_error' });
          }
          order.paymentId = ((await r.json()) as { id: string }).id;
          return send(res, 202, view(order));
        } catch {
          order.status = 'payment_failed';
          return send(res, 502, { error: 'provider_unreachable' });
        }
      }

      // --- refund ---
      if (method === 'POST' && orderMatch[2] === '/refund') {
        if (order.status !== 'paid' && order.status !== 'partially_refunded') {
          return send(res, 409, { error: 'order_not_refundable', status: order.status });
        }
        const body = parseJson(await readRaw(req));
        if (!body || !Number.isInteger(body.amount) || body.amount <= 0) {
          return send(res, 400, { error: 'invalid_amount' });
        }
        if (body.amount > order.amount - order.refundedAmount) {
          return send(res, 422, { error: 'refund_exceeds_remaining_amount' });
        }
        const r = await fetch(`${PROVIDER_URL}/payments/${order.paymentId}/refunds`, {
          method: 'POST',
          headers: providerHeaders(),
          body: JSON.stringify({ amount: body.amount }),
        });
        if (!r.ok) return send(res, 502, { error: 'provider_error' });
        return send(res, 202, view(order)); // final state arrives via webhook
      }
    }

    return send(res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch(() => send(res, 500, { error: 'internal_error' }));
  });
}
