/**
 * Asynchronous state changes and webhook handling:
 * signature checks, duplicate deliveries, state while the payment is still pending, amount mismatch.
 */
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { CARDS, PROVIDER_URL, SHOP_URL } from '../support/config';
import {
  createOrder, createPaidOrder, getOrder, payOrder, signedWebhookHeaders, waitForOrderStatus, webhookDeliveries,
} from '../support/helpers';

const event = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, data });

test.describe('signature verification', () => {
  test('a webhook with an invalid signature is rejected and changes nothing', async ({ request }) => {
    const order = await createOrder(request);
    const body = event('payment.succeeded', {
      paymentId: 'pay_fake', orderId: order.id, amount: order.amount, currency: 'EUR', refundedAmount: 0,
    });

    const res = await request.post(`${SHOP_URL}/webhooks/payments`, {
      data: body,
      headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
    });

    expect(res.status()).toBe(401);
    expect((await getOrder(request, order.id)).status).toBe('open');
  });

  test('a webhook without a signature is rejected', async ({ request }) => {
    const res = await request.post(`${SHOP_URL}/webhooks/payments`, {
      data: event('payment.succeeded', { orderId: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('asynchronous state', () => {
  test('the order stays payment_pending until the webhook arrives, then becomes paid', async ({ request }) => {
    const order = await createOrder(request);

    const res = await payOrder(request, order.id, CARDS.slowSuccess);
    expect(res.status()).toBe(202);
    expect((await getOrder(request, order.id)).status).toBe('payment_pending');

    await waitForOrderStatus(request, order.id, 'paid');
  });

  test('a signed event with a different amount marks the order as payment_mismatch', async ({ request }) => {
    const order = await createOrder(request); // 2500
    const { paymentId } = await (await payOrder(request, order.id, CARDS.slowSuccess)).json();

    const body = event('payment.succeeded', {
      paymentId, orderId: order.id, amount: 1, currency: 'EUR', refundedAmount: 0,
    });
    const res = await request.post(`${SHOP_URL}/webhooks/payments`, { data: body, headers: signedWebhookHeaders(body) });
    expect(res.status()).toBe(200);
    expect((await getOrder(request, order.id)).status).toBe('payment_mismatch');

    // The real (slow) webhook is delivered afterwards. We wait until the provider reports that the shop
    // ANSWERED it (no fixed sleep), and only then check that it did not flip the order to "paid".
    await expect
      .poll(async () => (await webhookDeliveries(request, paymentId)).some((d) => d.type === 'payment.succeeded' && d.status === 200))
      .toBe(true);
    expect((await getOrder(request, order.id)).status).toBe('payment_mismatch');
  });
});

test.describe('duplicate deliveries', () => {
  test('replaying the payment webhook does not change a paid order', async ({ request }) => {
    const order = await createPaidOrder(request);

    const replay = await request.post(`${PROVIDER_URL}/_test/webhooks/${order.paymentId}/replay`);
    expect((await replay.json()).status).toBe(200); // acknowledged, so the provider stops retrying

    expect(await getOrder(request, order.id)).toMatchObject({ status: 'paid', refundedAmount: 0 });
  });

  test('replaying the refund webhook does not refund twice', async ({ request }) => {
    const order = await createPaidOrder(request);
    await request.post(`${SHOP_URL}/api/orders/${order.id}/refund`, { data: { amount: 1000 } });
    await waitForOrderStatus(request, order.id, 'partially_refunded');

    for (let i = 0; i < 2; i++) {
      const replay = await request.post(`${PROVIDER_URL}/_test/webhooks/${order.paymentId}/replay`);
      expect((await replay.json()).status).toBe(200);
    }

    expect(await getOrder(request, order.id)).toMatchObject({ status: 'partially_refunded', refundedAmount: 1000 });
  });
});
