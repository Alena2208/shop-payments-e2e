# Shop Payments E2E

![E2E tests](../../actions/workflows/e2e.yml/badge.svg)

Risk-based test suite for a **checkout & payments** flow, built with **Playwright + TypeScript**.
It does not stop at "the button works": every scenario verifies the **order state, payment state, amount and currency**
on both sides (shop and payment provider) and covers **failure modes**: retries, duplicate requests, duplicate webhooks, invalid signatures, merchant isolation.

> The system under test is a small demo shop and a mock payment provider (in `app/`, plain Node, no framework),
> so the whole project runs locally and in CI without any external accounts.

## Run it

```bash
npm install
npx playwright install chromium
npm test              # starts shop (:3000) and provider (:4000) automatically
npm run test:api      # API/integration tests only
npm run test:ui       # browser tests only
npm run report        # open the HTML report
```

## What is under test

```
 Browser ──► Shop (:3000) ──POST /payments (Idempotency-Key)──► Payment provider (:4000)
                 ▲                                                    │
                 └──────── signed webhooks (payment.succeeded, ───────┘
                           payment.failed, payment.refunded)
```

The payment result is **asynchronous**: the shop only learns the outcome from a signed webhook.
The order follows these paths:

- Success: `open → payment_pending → paid → partially_refunded → refunded`
- Declined card: `open → payment_pending → payment_failed → (new attempt, new idempotency key) → payment_pending → paid`
- Amount in the webhook differs from the order: `payment_pending → payment_mismatch` (needs manual review, never `paid`)

### Idempotency rules

| Situation | Provider | Shop |
|---|---|---|
| Same key, same request (retry after a timeout) | returns the same payment (200) | returns the current order state (200) |
| Same key, different request (e.g. other card or amount) | 409 | 409 |
| Different key while a payment is running or done | new payment (the provider does not know the order) | 409, so no second payment is started |
| Missing key | 400 | the shop generates one |

## Test strategy: right test at the right level

| Level | Files | Why here |
|---|---|---|
| **UI** | `tests/ui/` | Only what needs a browser: shopper journey, declined card + retry, double click on "Pay", empty cart. Each journey ends with a backend assertion. |
| **API / integration** | `tests/api/` | Everything else: validation, idempotency, isolation, refunds, webhooks. Fast, stable, no browser. |

### Risk-based coverage

| Risk | Covered by |
|---|---|
| Shopper is charged twice (double click, parallel requests, network retry) | `ui/checkout` double click; `api/orders` parallel pay → one 202 + one 409, exactly one payment at the provider; same-key retry returns current state; same key with another card → 409 |
| Wrong amount or currency charged | amount is computed server-side (client `amount` ignored); amount/currency asserted in shop **and** provider; signed event with a different amount → `payment_mismatch` |
| Order and payment state diverge | webhook-driven state; `payment_pending` is asserted while the webhook is still in flight; failed → retry → paid asserts provider has `[failed, succeeded]` |
| Forged or replayed webhooks | invalid / missing signature → 401, order unchanged; a replayed event (same event id) is acknowledged and ignored; refunds are applied as absolute totals, so a replay can never refund twice |
| Idempotency misuse at the provider | same key + same body → same payment; same key + different body → 409; missing key → 400 |
| Merchant isolation | the merchant is derived from the API key on the server; merchant B gets 404 on read, list and refund of merchant A's payment (creating payments is not covered yet) |
| Refund errors | partial refunds add up; over-refund → 422 at shop and provider; refund of failed / unpaid payment → 409 |
| Invalid input | zero / negative / fractional amounts and quantities, unknown product, unsupported currency, empty cart |

### Design decisions

- **Polling instead of sleeping.** Payment state is async, so tests use `expect.poll` on the real state.
  There is no fixed `sleep`: to prove that a late webhook is ignored, the test waits until the provider reports that
  the shop answered that webhook (`GET /_test/webhooks/:paymentId/deliveries`) and only then checks the order.
- **Deterministic test data.** The mock provider has its own test cards that select the outcome (`4242…` success, `4000…0002` declined, `4000…0077` slow success). They are not official numbers of any real provider.
  Every test creates its own order, so tests run in parallel and are independent.
- **Test hooks for webhooks.** The mock provider offers `POST /_test/webhooks/:paymentId/replay` (re-delivers the last webhook, the way a real provider retries) and `GET /_test/webhooks/:paymentId/deliveries` (what was delivered and how the shop answered).
- **Failure evidence.** Traces and screenshots are kept on failure and uploaded as a CI artifact.

## Project layout

```
app/                 demo shop + mock payment provider (system under test)
tests/api/           provider contract, order/payment integration, webhook tests
tests/ui/            shopper journeys in the browser
tests/support/       config and helpers (createOrder, payOrder, waitForOrderStatus, signed webhooks)
.github/workflows/   CI: runs everything on every push / PR, uploads the report
```

## Ideas for extending it

- Real provider sandbox (Stripe / PayPal): needs an adapter for that provider's API, auth and webhook signatures, plus separate contract tests. The current tests target the mock provider's API
- Contract tests from an OpenAPI spec
- Webhook retry with backoff when the shop returns 5xx
- Race between a refund request and a late `payment.succeeded` webhook
- Merchant isolation when creating payments, not only when reading and refunding them
