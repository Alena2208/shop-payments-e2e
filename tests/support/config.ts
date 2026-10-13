export const SHOP_URL = process.env.SHOP_URL ?? 'http://127.0.0.1:3000';
export const PROVIDER_URL = process.env.PROVIDER_URL ?? 'http://127.0.0.1:4000';
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'whsec_test_secret';

export const MERCHANT_A_KEY = 'sk_test_merchant_a';
export const MERCHANT_B_KEY = 'sk_test_merchant_b';

export const CARDS = {
  success: '4242424242424242',
  declined: '4000000000000002',
  slowSuccess: '4000000000000077', // webhook arrives after ~1.5s, useful for async-state tests
} as const;
