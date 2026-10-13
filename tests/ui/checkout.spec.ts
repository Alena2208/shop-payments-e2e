/**
 * Browser tests cover only what needs a browser: the shopper journey.
 * Every journey ends with a backend check of order and payment state.
 */
import { test, expect } from '@playwright/test';
import { CARDS, PROVIDER_URL } from '../support/config';
import { getOrder, providerAuth, providerPaymentsFor } from '../support/helpers';

test('shopper pays successfully: order and payment are correct in the backend', async ({ page, request }) => {
  await page.goto('/');

  await page.getByTestId('add-tee').click();
  await page.getByTestId('add-tee').click();
  await page.getByTestId('add-mug').click();
  await expect(page.getByTestId('total')).toHaveText('62.00 EUR');

  await page.getByTestId('place-order').click();
  await expect(page.getByTestId('order-id')).not.toHaveText('');
  const orderId = await page.getByTestId('order-id').innerText();

  await page.getByTestId('card-number').fill(CARDS.success);
  await page.getByTestId('pay-button').click();
  await expect(page.getByTestId('status')).toHaveText('Payment successful');

  const order = await getOrder(request, orderId);
  expect(order).toMatchObject({ status: 'paid', amount: 6200, currency: 'EUR', refundedAmount: 0 });

  const payment = await (await request.get(`${PROVIDER_URL}/payments/${order.paymentId}`, { headers: providerAuth() })).json();
  expect(payment).toMatchObject({ status: 'succeeded', amount: 6200, currency: 'EUR', orderId });
});

test('declined card shows an error, then the shopper succeeds with another card', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('add-mug').click();
  await page.getByTestId('place-order').click();
  await expect(page.getByTestId('order-id')).not.toHaveText('');
  const orderId = await page.getByTestId('order-id').innerText();

  await page.getByTestId('card-number').fill(CARDS.declined);
  await page.getByTestId('pay-button').click();
  await expect(page.getByTestId('status')).toHaveText('Payment failed');
  expect((await getOrder(request, orderId)).status).toBe('payment_failed');

  await page.getByTestId('card-number').fill(CARDS.success);
  await page.getByTestId('pay-button').click();
  await expect(page.getByTestId('status')).toHaveText('Payment successful');

  expect((await getOrder(request, orderId)).status).toBe('paid');
  const payments = await providerPaymentsFor(request, orderId);
  expect(payments.map((p) => p.status).sort()).toEqual(['failed', 'succeeded']);
});

test('double-clicking "Pay" results in exactly one payment', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('add-tee').click();
  await page.getByTestId('place-order').click();
  await expect(page.getByTestId('order-id')).not.toHaveText('');
  const orderId = await page.getByTestId('order-id').innerText();

  await page.getByTestId('card-number').fill(CARDS.success);
  await page.getByTestId('pay-button').dblclick();
  await expect(page.getByTestId('status')).toHaveText('Payment successful');

  expect(await providerPaymentsFor(request, orderId)).toHaveLength(1);
});

test('placing an order with an empty cart is not possible', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('place-order').click();
  await expect(page.getByTestId('status')).toHaveText('Cart is empty');
  await expect(page.getByTestId('order-id')).toBeHidden();
});

