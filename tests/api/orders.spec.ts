/**
 * Shop <-> provider integration: order amounts, double-payment protection,
 * retries, failure recovery and refunds. Final state is verified on BOTH sides.
 */
import { test, expect } from '@playwright/test';
import { CARDS, SHOP_URL } from '../support/config';
import {
  createOrder, createPaidOrder, getOrder, payOrder, providerPaymentsFor, waitForOrderStatus,
} from '../support/helpers';

test.describe('order creation', () => {
  test('the amount is computed on the server, a client-supplied amount is ignored', async ({ request }) => {
    const res = await request.post(`${SHOP_URL}/api/orders`, {
      data: { items: [{ productId: 'tee', quantity: 2 }, { productId: 'mug', quantity: 1 }], amount: 1 },
    });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'open', amount: 6200, currency: 'EUR' });
  });

  for (const [name, items] of [
    ['empty cart', []],
    ['unknown product', [{ productId: 'nope', quantity: 1 }]],
    ['zero quantity', [{ productId: 'tee', quantity: 0 }]],
    ['negative quantity', [{ productId: 'tee', quantity: -1 }]],
    ['fractional quantity', [{ productId: 'tee', quantity: 1.5 }]],
  ] as const) {
    test(`rejects ${name}`, async ({ request }) => {
      const res = await request.post(`${SHOP_URL}/api/orders`, { data: { items } });
      expect(res.status()).toBe(400);
    });
  }
});

test.describe('payment outcome', () => {
  test('successful payment: order is paid with the right amount and currency on both sides', async ({ request }) => {
    const order = await createPaidOrder(request, [{ productId: 'mug', quantity: 3 }]);

    expect(order).toMatchObject({ status: 'paid', amount: 3600, currency: 'EUR', refundedAmount: 0 });
    const payments = await providerPaymentsFor(request, order.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: order.paymentId, status: 'succeeded', amount: 3600, currency: 'EUR' });
  });

  test('declined card: order is payment_failed and can be paid again with a new attempt', async ({ request }) => {
    const order = await createOrder(request);

    expect((await payOrder(request, order.id, CARDS.declined)).status()).toBe(202);
    await waitForOrderStatus(request, order.id, 'payment_failed');

    expect((await payOrder(request, order.id, CARDS.success)).status()).toBe(202);
    const paid = await waitForOrderStatus(request, order.id, 'paid');

    const payments = await providerPaymentsFor(request, order.id);
    expect(payments.map((p) => p.status).sort()).toEqual(['failed', 'succeeded']);
    expect(paid.paymentId).toBe(payments.find((p) => p.status === 'succeeded')!.id);
  });

  test('retrying a failed attempt with the SAME key does not start a new payment', async ({ request }) => {
    const order = await createOrder(request);
    const key = 'retry-key-' + order.id;

    await payOrder(request, order.id, CARDS.declined, key);
    await waitForOrderStatus(request, order.id, 'payment_failed');

    const retry = await payOrder(request, order.id, CARDS.declined, key);
    expect(retry.status()).toBe(200);
    expect((await getOrder(request, order.id)).status).toBe('payment_failed');
    expect(await providerPaymentsFor(request, order.id)).toHaveLength(1);
  });
});

test.describe('duplicate payment protection', () => {
  test('two parallel pay requests with different keys: exactly one wins, only one payment exists', async ({ request }) => {
    const order = await createOrder(request);

    const [a, b] = await Promise.all([
      payOrder(request, order.id, CARDS.success),
      payOrder(request, order.id, CARDS.success),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([202, 409]);

    await waitForOrderStatus(request, order.id, 'paid');
    expect(await providerPaymentsFor(request, order.id)).toHaveLength(1);
  });

  test('a retry with the same idempotency key (e.g. network timeout) returns the current state', async ({ request }) => {
    const order = await createOrder(request);
    const key = 'pay-key-' + order.id;

    expect((await payOrder(request, order.id, CARDS.success, key)).status()).toBe(202);
    const retry = await payOrder(request, order.id, CARDS.success, key);
    expect(retry.status()).toBe(200);

    await waitForOrderStatus(request, order.id, 'paid');
    expect(await providerPaymentsFor(request, order.id)).toHaveLength(1);
  });

  test('the same idempotency key with a different card is rejected and creates no second payment', async ({ request }) => {
    const order = await createOrder(request);
    const key = 'reuse-key-' + order.id;

    expect((await payOrder(request, order.id, CARDS.success, key)).status()).toBe(202);
    const conflicting = await payOrder(request, order.id, CARDS.declined, key);
    expect(conflicting.status()).toBe(409);

    await waitForOrderStatus(request, order.id, 'paid'); // the original payment is unaffected
    expect(await providerPaymentsFor(request, order.id)).toHaveLength(1);
  });

  test('an already paid order cannot be paid with a different key', async ({ request }) => {
    const order = await createPaidOrder(request);
    const res = await payOrder(request, order.id, CARDS.success);
    expect(res.status()).toBe(409);
    expect(await providerPaymentsFor(request, order.id)).toHaveLength(1);
  });
});

test.describe('refunds', () => {
  test('partial then full refund moves the order through the right states', async ({ request }) => {
    const order = await createPaidOrder(request); // 2500
    const refund = (amount: number) => request.post(`${SHOP_URL}/api/orders/${order.id}/refund`, { data: { amount } });

    expect((await refund(1000)).status()).toBe(202);
    expect(await waitForOrderStatus(request, order.id, 'partially_refunded')).toMatchObject({ refundedAmount: 1000 });

    expect((await refund(2000)).status()).toBe(422); // only 1500 left

    expect((await refund(1500)).status()).toBe(202);
    expect(await waitForOrderStatus(request, order.id, 'refunded')).toMatchObject({ refundedAmount: 2500 });
  });

  test('an unpaid order cannot be refunded', async ({ request }) => {
    const order = await createOrder(request);
    const res = await request.post(`${SHOP_URL}/api/orders/${order.id}/refund`, { data: { amount: 100 } });
    expect(res.status()).toBe(409);
  });
});
