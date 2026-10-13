import { createProvider } from './provider';
import { createShop } from './shop';
import { PROVIDER_PORT, SHOP_PORT } from './config';

createProvider().listen(PROVIDER_PORT, '127.0.0.1', () =>
  console.log(`mock payment provider on http://127.0.0.1:${PROVIDER_PORT}`),
);
createShop().listen(SHOP_PORT, '127.0.0.1', () =>
  console.log(`demo shop on http://127.0.0.1:${SHOP_PORT}`),
);
