/**
 * Contract tests for the payment provider API: auth, idempotency, merchant isolation, refunds.
 * These run on API level on purpose - no browser is needed to verify them.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import crypto from 'node:crypto';
import { CARDS, MERCHANT_A_KEY, MERCHANT_B_KEY, PROVIDER_URL } from '../support/config';
import { providerAuth } from '../support/helpers';

const newPayment = (overrides: Record<string, unknown> = {}) => ({
  amount: 2500,
  currency: 'EUR',
  card: CARDS.success,
  orderId: `ord_${crypto.randomUUID()}`,
  ...overrides,
});

const createPayment = (request: APIRequestContext, data: object, idempotencyKey = crypto.randomUUID(), apiKey = MERCHANT_A_KEY) =>
  request.post(`${PROVIDER_URL}/payments`, {
    data,
    headers: { ...providerAuth(apiKey), 'idempotency-key': idempotencyKey },
  });

async function waitForPayment(request: APIRequestContext, id: string, status: string) {
  await expect
    .poll(async () => (await (await request.get(`${PROVIDER_URL}/payments/${id}`, { headers: providerAuth() })).json()).status)
    .toBe(status);
}

test.describe('authentication', () => {
  test('rejects requests without an API key', async ({ request }) => {
    const res = await request.post(`${PROVIDER_URL}/payments`, {
      data: newPayment(),
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('rejects an unknown API key', async ({ request }) => {
    const res = await createPayment(request, newPayment(), crypto.randomUUID(), 'sk_test_unknown');
    expect(res.status()).toBe(401);
  });
});

test.describe('request validation', () => {
  test('requires an Idempotency-Key header', async ({ request }) => {
    const res = await request.post(`${PROVIDER_URL}/payments`, { data: newPayment(), headers: providerAuth() });
    expect(res.status()).toBe(400);
  });

  for (const [name, override] of [
    ['negative amount', { amount: -100 }],
    ['zero amount', { amount: 0 }],
    ['fractional amount', { amount: 10.5 }],
    ['unsupported currency', { currency: 'XYZ' }],
  ] as const) {
    test(`rejects ${name}`, async ({ request }) => {
      const res = await createPayment(request, newPayment(override));
      expect(res.status()).toBe(400);
    });
  }
});

test.describe('idempotency', () => {
  test('the same key and body returns the same payment and creates no duplicate', async ({ request }) => {
    const body = newPayment();
    const key = crypto.randomUUID();

    const first = await createPayment(request, body, key);
    const second = await createPayment(request, body, key);

    expect(first.status()).toBe(201);
    expect(second.status()).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);

    const list = await request.get(`${PROVIDER_URL}/payments?orderId=${body.orderId}`, { headers: providerAuth() });
    expect((await list.json()).data).toHaveLength(1);
  });

  test('the same key with a different amount is rejected', async ({ request }) => {
    const key = crypto.randomUUID();
    const orderId = `ord_${crypto.randomUUID()}`;
    expect((await createPayment(request, newPayment({ orderId }), key)).status()).toBe(201);

    const res = await createPayment(request, newPayment({ orderId, amount: 9900 }), key);
    expect(res.status()).toBe(409);
  });
});

test.describe('merchant isolation', () => {
  test("merchant B cannot read or list merchant A's payment", async ({ request }) => {
    const body = newPayment();
    const created = await (await createPayment(request, body)).json();

    const read = await request.get(`${PROVIDER_URL}/payments/${created.id}`, { headers: providerAuth(MERCHANT_B_KEY) });
    expect(read.status()).toBe(404);

    const list = await request.get(`${PROVIDER_URL}/payments?orderId=${body.orderId}`, { headers: providerAuth(MERCHANT_B_KEY) });
    expect((await list.json()).data).toEqual([]);
  });

  test("merchant B cannot refund merchant A's payment", async ({ request }) => {
    const created = await (await createPayment(request, newPayment())).json();
    await waitForPayment(request, created.id, 'succeeded');

    const res = await request.post(`${PROVIDER_URL}/payments/${created.id}/refunds`, {
      data: { amount: 100 },
      headers: providerAuth(MERCHANT_B_KEY),
    });
    expect(res.status()).toBe(404);
  });
});

test.describe('refunds', () => {
  test('partial refunds add up and can never exceed the payment amount', async ({ request }) => {
    const created = await (await createPayment(request, newPayment({ amount: 2500 }))).json();
    await waitForPayment(request, created.id, 'succeeded');
    const refund = (amount: number) =>
      request.post(`${PROVIDER_URL}/payments/${created.id}/refunds`, { data: { amount }, headers: providerAuth() });

    const first = await refund(1000);
    expect(first.status()).toBe(201);
    expect((await first.json()).refundedAmount).toBe(1000);

    expect((await refund(1501)).status()).toBe(422); // 1000 + 1501 > 2500
    expect((await refund(1500)).status()).toBe(201); // exactly the remainder
    expect((await refund(1)).status()).toBe(422);
  });

  test('a failed payment cannot be refunded', async ({ request }) => {
    const created = await (await createPayment(request, newPayment({ card: CARDS.declined }))).json();
    await waitForPayment(request, created.id, 'failed');

    const res = await request.post(`${PROVIDER_URL}/payments/${created.id}/refunds`, {
      data: { amount: 100 },
      headers: providerAuth(),
    });
    expect(res.status()).toBe(409);
  });
});
