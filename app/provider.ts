/**
 * Mock payment provider (think "Stripe-lite").
 * - Bearer-key auth, one key per merchant (merchant isolation)
 * - Idempotency-Key support on POST /payments
 * - Asynchronous settlement: the final state arrives via signed webhook
 * - Refunds with over-refund protection
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readRaw, parseJson, send } from './http';
import { CARD_DECLINED, CARD_SLOW_SUCCESS, CARD_SUCCESS, WEBHOOK_SECRET } from './config';

type Status = 'pending' | 'succeeded' | 'failed';
interface Refund { id: string; amount: number }
interface WebhookEvent { id: string; type: string; data: Record<string, unknown> }
interface Payment {
  id: string;
  merchant: string;
  orderId: string;
  amount: number;
  currency: string;
  status: Status;
  failureReason?: string;
  refunds: Refund[];
  webhookUrl?: string;
  lastEvent?: WebhookEvent;
  deliveries: { eventId: string; type: string; status: number }[];
}

const MERCHANTS = new Map([
  ['sk_test_merchant_a', 'merchant_a'],
  ['sk_test_merchant_b', 'merchant_b'],
]);
const CURRENCIES = ['EUR', 'USD'];

export function createProvider(): http.Server {
  const payments = new Map<string, Payment>();
  const idempotency = new Map<string, { fingerprint: string; paymentId: string }>();

  const refunded = (p: Payment) => p.refunds.reduce((sum, r) => sum + r.amount, 0);
  const view = (p: Payment) => ({
    id: p.id,
    orderId: p.orderId,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    failureReason: p.failureReason ?? null,
    refundedAmount: refunded(p),
  });

  async function deliver(p: Payment, event: WebhookEvent): Promise<number | null> {
    if (!p.webhookUrl) return null;
    const body = JSON.stringify(event);
    const signature = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    try {
      const res = await fetch(p.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signature },
        body,
      });
      p.deliveries.push({ eventId: event.id, type: event.type, status: res.status });
      return res.status;
    } catch {
      p.deliveries.push({ eventId: event.id, type: event.type, status: -1 });
      return -1;
    }
  }

  function emit(p: Payment, type: string): Promise<number | null> {
    const event: WebhookEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type,
      data: {
        paymentId: p.id,
        orderId: p.orderId,
        amount: p.amount,
        currency: p.currency,
        refundedAmount: refunded(p),
      },
    };
    p.lastEvent = event;
    return deliver(p, event);
  }

  function settle(p: Payment, card: string): void {
    const delay = card === CARD_SLOW_SUCCESS ? 1500 : 150;
    setTimeout(() => {
      if (card === CARD_SUCCESS || card === CARD_SLOW_SUCCESS) {
        p.status = 'succeeded';
        void emit(p, 'payment.succeeded');
      } else {
        p.status = 'failed';
        p.failureReason = card === CARD_DECLINED ? 'card_declined' : 'invalid_card';
        void emit(p, 'payment.failed');
      }
    }, delay);
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://provider');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    // Test hook: which webhooks were delivered to the shop, and how did the shop answer?
    const deliveries = url.pathname.match(/^\/_test\/webhooks\/([^/]+)\/deliveries$/);
    if (method === 'GET' && deliveries) {
      const p = payments.get(deliveries[1]);
      if (!p) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { data: p.deliveries });
    }

    // Test hook: re-deliver the last webhook of a payment (simulates provider retries / duplicates)
    const replay = url.pathname.match(/^\/_test\/webhooks\/([^/]+)\/replay$/);
    if (method === 'POST' && replay) {
      const p = payments.get(replay[1]);
      if (!p?.lastEvent) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { status: await deliver(p, p.lastEvent) });
    }

    const apiKey = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const merchant = MERCHANTS.get(apiKey);
    if (!merchant) return send(res, 401, { error: 'unauthorized' });

    if (method === 'POST' && url.pathname === '/payments') {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key === '') return send(res, 400, { error: 'idempotency_key_required' });
      const body = parseJson(await readRaw(req));
      if (
        !body ||
        !Number.isInteger(body.amount) || body.amount <= 0 ||
        !CURRENCIES.includes(body.currency) ||
        typeof body.card !== 'string' ||
        typeof body.orderId !== 'string'
      ) {
        return send(res, 400, { error: 'invalid_request' });
      }

      const fingerprint = JSON.stringify([body.amount, body.currency, body.orderId, body.card]);
      const idemKey = `${merchant}:${key}`;
      const existing = idempotency.get(idemKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return send(res, 409, { error: 'idempotency_key_reused_with_different_request' });
        }
        return send(res, 200, view(payments.get(existing.paymentId)!));
      }

      const p: Payment = {
        id: `pay_${crypto.randomUUID()}`,
        merchant,
        orderId: body.orderId,
        amount: body.amount,
        currency: body.currency,
        status: 'pending',
        refunds: [],
        deliveries: [],
        webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
      };
      payments.set(p.id, p);
      idempotency.set(idemKey, { fingerprint, paymentId: p.id });
      settle(p, body.card);
      return send(res, 201, view(p));
    }

    if (method === 'GET' && url.pathname === '/payments') {
      const orderId = url.searchParams.get('orderId');
      const data = [...payments.values()]
        .filter((p) => p.merchant === merchant && (!orderId || p.orderId === orderId))
        .map(view);
      return send(res, 200, { data });
    }

    const m = url.pathname.match(/^\/payments\/([^/]+)(\/refunds)?$/);
    if (m) {
      const p = payments.get(m[1]);
      // Another merchant's payment is reported as "not found", never "forbidden"
      if (!p || p.merchant !== merchant) return send(res, 404, { error: 'not_found' });

      if (method === 'GET' && !m[2]) return send(res, 200, view(p));

      if (method === 'POST' && m[2]) {
        const body = parseJson(await readRaw(req));
        if (!body || !Number.isInteger(body.amount) || body.amount <= 0) {
          return send(res, 400, { error: 'invalid_request' });
        }
        if (p.status !== 'succeeded') return send(res, 409, { error: 'payment_not_refundable' });
        if (refunded(p) + body.amount > p.amount) return send(res, 422, { error: 'refund_exceeds_payment' });
        const refund: Refund = { id: `re_${crypto.randomUUID()}`, amount: body.amount };
        p.refunds.push(refund);
        setTimeout(() => void emit(p, 'payment.refunded'), 100);
        return send(res, 201, { id: refund.id, amount: refund.amount, refundedAmount: refunded(p) });
      }
    }

    return send(res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch(() => send(res, 500, { error: 'internal_error' }));
  });
}
