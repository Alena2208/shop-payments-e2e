import { APIRequestContext, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { MERCHANT_A_KEY, PROVIDER_URL, SHOP_URL, WEBHOOK_SECRET, CARDS } from './config';

type Items = { productId: string; quantity: number }[];

export const providerAuth = (key = MERCHANT_A_KEY) => ({ Authorization: `Bearer ${key}` });

export async function createOrder(request: APIRequestContext, items: Items = [{ productId: 'tee', quantity: 1 }]) {
  const res = await request.post(`${SHOP_URL}/api/orders`, { data: { items } });
  expect(res.status()).toBe(201);
  return res.json();
}

export function payOrder(
  request: APIRequestContext,
  orderId: string,
  card: string,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return request.post(`${SHOP_URL}/api/orders/${orderId}/pay`, {
    data: { card },
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export async function getOrder(request: APIRequestContext, orderId: string) {
  const res = await request.get(`${SHOP_URL}/api/orders/${orderId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

/** Payment state is asynchronous (webhook), so we poll instead of sleeping. */
export async function waitForOrderStatus(request: APIRequestContext, orderId: string, status: string) {
  await expect
    .poll(async () => (await getOrder(request, orderId)).status, {
      timeout: 10_000,
      message: `order ${orderId} should reach status "${status}"`,
    })
    .toBe(status);
  return getOrder(request, orderId);
}

export async function providerPaymentsFor(request: APIRequestContext, orderId: string) {
  const res = await request.get(`${PROVIDER_URL}/payments?orderId=${orderId}`, { headers: providerAuth() });
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<{ id: string; status: string; amount: number; currency: string }>;
}

/** Webhook deliveries of a payment, as reported by the mock provider's test hook. */
export async function webhookDeliveries(request: APIRequestContext, paymentId: string) {
  const res = await request.get(`${PROVIDER_URL}/_test/webhooks/${paymentId}/deliveries`);
  expect(res.status()).toBe(200);
  return (await res.json()).data as Array<{ eventId: string; type: string; status: number }>;
}

/** Creates an order and pays it with a good card, returns it in status "paid". */
export async function createPaidOrder(request: APIRequestContext, items?: Items) {
  const order = await createOrder(request, items);
  const res = await payOrder(request, order.id, CARDS.success);
  expect(res.status()).toBe(202);
  return waitForOrderStatus(request, order.id, 'paid');
}

export function signedWebhookHeaders(body: string) {
  const signature = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return { 'content-type': 'application/json', 'x-signature': signature };
}
