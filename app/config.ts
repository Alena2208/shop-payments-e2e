export const SHOP_PORT = Number(process.env.SHOP_PORT ?? 3000);
export const PROVIDER_PORT = Number(process.env.PROVIDER_PORT ?? 4000);
export const SHOP_URL = process.env.SHOP_URL ?? `http://127.0.0.1:${SHOP_PORT}`;
export const PROVIDER_URL = process.env.PROVIDER_URL ?? `http://127.0.0.1:${PROVIDER_PORT}`;

export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'whsec_test_secret';
// API key the shop (merchant A) uses against the provider
export const SHOP_PROVIDER_KEY = 'sk_test_merchant_a';

// Test cards understood by the mock provider
export const CARD_SUCCESS = '4242424242424242';
export const CARD_DECLINED = '4000000000000002';
export const CARD_SLOW_SUCCESS = '4000000000000077'; // succeeds, but webhook arrives after ~1.5s
