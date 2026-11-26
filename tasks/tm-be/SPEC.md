# Payment webhook receiver with a ledger

Build a payment webhook receiver. A payment provider sends signed events about payments. The receiver verifies them, applies them to a ledger of merchant balances exactly once, and serves the resulting state over HTTP.

## Deliverable

Implement the two starter files. Do not change any exported name, type or signature.

- `src/app.ts` exports `createApp` and the types below.
- `src/main.ts` exports `startServer` and runs it when executed.

Constraints:

- TypeScript on Bun. Use only native Bun and platform APIs: `Bun.serve`, `bun:sqlite`, Web Crypto or `node:crypto`. Add **no runtime dependencies**.
- `bunx tsc --noEmit` must pass.
- Several `App` instances, in one process or in several processes, may use the same `dbPath` at the same time. Every rule in this document must hold in that case too (see [Shared database](#shared-database)).

## Types and entry points

```ts
export type Currency = 'USD' | 'EUR' | 'JPY' | 'BHD';

export type FeeConfig = {
  percentBps: number;                    // integer, 0..10000
  fixedMinor: Record<Currency, number>;  // integer >= 0 for every currency
};

export type AppOptions = {
  dbPath: string;
  secret: string;
  fees: FeeConfig;
  now?: () => Date;
  hooks?: { beforeCommit?: (eventId: string) => void };
};

export type App = {
  fetch(request: Request): Promise<Response>;
  close(): void;
};

export function createApp(options: AppOptions): App;
```

### `createApp`

- `dbPath` is a filesystem path to a SQLite database file, or `":memory:"` for a private in-memory database. `createApp` creates the file and its schema when absent. Creating the file and schema must work when several instances start on the same new path at the same moment. State persists in the file: an instance created later on the same path sees everything earlier instances stored.
- `secret` is the webhook signing secret. Its UTF-8 bytes are the HMAC key.
- `fees` is used at capture time (see [Capture](#capture-and-fee)). `createApp` throws an `Error` if `fees` violates the invariants of `FeeConfig` (including a missing currency key).
- `now` supplies the current time and is used only for the signature freshness check. It defaults to `() => new Date()`.
- `hooks.beforeCommit` is described in [Atomicity](#atomicity).
- `app.fetch(request)` handles one request and always resolves to a `Response`; it never rejects.
- `app.close()` releases the database. Calling it more than once is allowed and does nothing after the first call.

### `src/main.ts`

`startServer(env)` reads configuration from `env`, creates the app and serves `app.fetch` with `Bun.serve`. It returns `{ port, stop }`: `port` is the port actually listening, and `stop()` stops the server and closes the app.

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | TCP port; `0` picks a free port | `3000` |
| `DB_PATH` | database file path | `./ledger.db` |
| `WEBHOOK_SECRET` | signing secret | required |
| `FEES_JSON` | JSON text of a `FeeConfig` | required |

When `WEBHOOK_SECRET` or `FEES_JSON` is missing, or `FEES_JSON` is not valid JSON or not a valid `FeeConfig`, or `PORT` is not an integer 0..65535, `startServer` throws an `Error` whose message names the offending variable. When `src/main.ts` is run as the entry point (`bun run src/main.ts`), it calls `startServer(process.env)`; on a thrown error it prints the message to stderr and exits with a non-zero code. Importing the module has no side effects.

Example `FEES_JSON`:

```json
{"percentBps":290,"fixedMinor":{"USD":30,"EUR":25,"JPY":0,"BHD":300}}
```

## Money

All amounts are integers in minor units. Supported currencies and their minor-unit exponents (decimal places):

| Currency | Exponent |
|---|---|
| USD | 2 |
| EUR | 2 |
| JPY | 0 |
| BHD | 3 |

The exponent describes what a minor unit means; no arithmetic in this service depends on it. Currency codes are case-sensitive: `"usd"` is not supported. Any currency string not in the table is rejected with 422 `unsupported_currency`.

"Integer" in this document means a JSON number whose value is a whole number inside the JavaScript safe-integer range. Event amounts are at most `9007199254740991`. Balances are signed integers; totals beyond ±9007199254740991 need not be supported.

## Routing

| Path | Methods | 
|---|---|
| `/webhooks` | `POST` |
| `/balances/:merchantId` | `GET` |
| `/payments/:paymentId` | `GET` |

- A path that matches none of the paths above → 404 `not_found`. A trailing slash makes a path unmatched. `:merchantId` and `:paymentId` are exactly one non-empty path segment; they are percent-decoded before use. The query string is ignored.
- A matched path with any other method → 405 `method_not_allowed`.
- Routing is decided before anything else is examined (signature, body).

## Responses

Every response has `Content-Type: application/json` and a JSON body.

Success bodies:

| Status | Body |
|---|---|
| 200 | `{ "status": "processed" }` |
| 200 | `{ "status": "ignored" }` |
| 200 | `{ "status": "duplicate" }` |
| 202 | `{ "status": "deferred" }` |

Every non-2xx response has exactly the body `{ "code": string, "message": string }` and no other keys. `message` is a human-readable non-empty string with no stack trace or internal detail.

| Status | `code` |
|---|---|
| 400 | `invalid_input` |
| 401 | `invalid_signature` |
| 401 | `stale_signature` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `event_conflict` |
| 422 | `unsupported_currency` |
| 422 | `refund_exceeds_capture` |
| 500 | `internal_error` |

Any unexpected failure inside the receiver answers 500 `internal_error`.

## POST /webhooks

A request is handled in this order; the first step that fails decides the response.

1. Signature (401).
2. Body parsing and validation (400, then 422 `unsupported_currency`).
3. Idempotency (200 `duplicate`, 409).
4. Applying the event (200, 202, 422 `refund_exceeds_capture`).

### 1. Signature

The request carries the header `Webhook-Signature` (header name is case-insensitive):

```
Webhook-Signature: t=<unix seconds>,v1=<signature>
```

- `<unix seconds>`: 1 to 15 decimal digits.
- `<signature>`: exactly 64 lowercase hexadecimal characters, the HMAC-SHA256 of the string `"<t>.<raw body>"` with key = UTF-8 bytes of `secret`, hex-encoded in lowercase. `<t>` is the digits exactly as written in the header. `<raw body>` is the request body bytes exactly as received, decoded as UTF-8.
- The header value must have exactly this shape: `t=` part first, a single comma, then the `v1=` part, no spaces, no other parts. The signature comparison must be constant-time.

Outcomes:

- Header missing, not of that shape, or the signature does not match → 401 `invalid_signature`.
- Signature matches but `|now − t| > 300` (seconds; `now` is `options.now()` converted to seconds, fractions kept) → 401 `stale_signature`. A difference of exactly 300 is accepted.

The signature is checked before the body is parsed, so an unsigned or wrongly signed request never reveals anything about its body.

**Worked example.** With `secret = "whsec_example"`, `t = 1700000000` and this exact body (104 bytes, no trailing newline):

```
{"id":"evt_1","type":"payment.captured","createdAt":"2023-11-14T22:13:20Z","data":{"paymentId":"pay_1"}}
```

the signed string is `1700000000.{"id":"evt_1",...}` and the header is:

```
Webhook-Signature: t=1700000000,v1=c4774e8bfe5b84c1dee1146183d174d483187b06388692e3c6d912805c0ad8ea
```

Accepted when `now` is within 300 seconds of `1700000000`; answers 401 `stale_signature` otherwise.

### 2. Body

The body must be UTF-8 JSON containing an object, otherwise 400 `invalid_input`. Fields not listed below are allowed and ignored by validation.

```json
{ "id": "evt_123", "type": "payment.authorized", "createdAt": "2023-11-14T22:13:20Z", "data": { } }
```

- `id`: non-empty string.
- `type`: one of `payment.authorized`, `payment.captured`, `payment.failed`, `payment.refunded`. Any other value (or a non-string) → 400.
- `createdAt`: string in RFC 3339 `date-time` form: `YYYY-MM-DDTHH:MM:SS`, optional fraction `.d+`, then `Z` or `±HH:MM`. Uppercase `T` and `Z` only. It must be a real calendar date and time (month 01–12, valid day for the month and year, hour 00–23, minute 00–59, second 00–59, offset hour 00–23 and offset minute 00–59). It is validated and stored; it has no other effect.
- `data`: an object, shaped by `type`. All ids below (`paymentId`, `merchantId`, `refundId`) are non-empty strings.

| `type` | `data` |
|---|---|
| `payment.authorized` | `{ paymentId, amountMinor, currency, splits }` |
| `payment.captured` | `{ paymentId }` |
| `payment.failed` | `{ paymentId }` |
| `payment.refunded` | `{ paymentId, refundId, amountMinor }` |

- `amountMinor`: integer, `1 <= amountMinor <= 9007199254740991`.
- `currency` (authorized only): a string. A non-string → 400. A string that is not a supported currency → 422 `unsupported_currency`, checked only after the whole body passed every 400 check above.
- `splits` (authorized only): array of 1 to 10 objects `{ merchantId, weightBps }`. `weightBps` is an integer `0..10000` and the weights sum to exactly `10000`. The `merchantId` values within one `splits` array are pairwise different. Violations → 400.

Any violation of this section is 400 `invalid_input` (except the 422 case above). A rejected request has no effect: nothing is stored and the event `id` stays unused.

### 3. Idempotency

Every event `id` takes effect at most once. Every event answered 200 or 202 (`processed`, `ignored`, `deferred`) is recorded under its `id` together with its body. For a request whose body passed validation:

- `id` already recorded and the new body is identical to the recorded body → 200 `{ "status": "duplicate" }`, no effect.
- `id` already recorded and the body differs → 409 `event_conflict`, no effect.

"Identical" means equal as parsed JSON values: whitespace and key order do not matter, numbers compare by value, and extra fields count. The signature (`t` and `v1`) is not part of the comparison.

Idempotency is checked before the event is applied: a repeat of a refund that already took effect answers `duplicate`, never `refund_exceeds_capture`.

### 4. Applying an event

#### Payment lifecycle

```
authorized ──► captured ──► (refunds, any number, while refundable amount remains)
    └───────► failed
```

`captured` and `failed` are final. A payment exists from the moment its `payment.authorized` event is applied. A payment's amount and currency are those of its authorization; its capture amount is the authorization `amountMinor`.

Result of an event, by the payment's current state:

| Event | no such payment | `authorized` | `captured` | `failed` |
|---|---|---|---|---|
| `payment.authorized` | create it → `processed` | `ignored` | `ignored` | `ignored` |
| `payment.captured` | `deferred` | capture → `processed` | `ignored` | `ignored` |
| `payment.failed` | `deferred` | fail → `processed` | `ignored` | `ignored` |
| `payment.refunded` | `deferred` | `deferred` | refund → `processed` (or 422) | `ignored` |

- `ignored`: the event changes no payment or ledger data, and answers 200 `{ "status": "ignored" }`. Its id is recorded (see Idempotency).
- `deferred`: the event is stored and answers 202 `{ "status": "deferred" }`. Its id is recorded. It changes no payment or ledger data until released.
- The `payment.refunded` amount check (below) happens only when a refund is applied, never when it is deferred.

#### Capture and fee

On capture of a payment with amount `A` in currency `C`, using the app's `fees`:

```
percentFee = roundHalfEven(A × percentBps / 10000)     // exact rational value, ties to the even integer
fee        = min(percentFee + fixedMinor[C], A)
net        = A − fee
```

`roundHalfEven` rounds the exact value to the nearest integer; a value exactly halfway between two integers goes to the even one. Examples with `percentBps = 1000`: `A=25` → 2.5 → **2**; `A=35` → 3.5 → **4**; `A=5` → 0.5 → **0**; `A=15` → 1.5 → **2**; `A=131` → 13.1 → **13**.

The payment's `feeMinor` becomes `fee`. Then `net` is split among the payment's `splits` (below) and each merchant's balance in currency `C` is increased by their share. Every merchant in `splits` gets a ledger entry for `C` at capture, even when the share is 0.

#### Largest-remainder split

To split an amount `T` (the `net` at capture, or the refund amount) over splits `w[0..n-1]` (`weightBps`, in list order):

1. `share[i] = floor(T × w[i] / 10000)`.
2. `remainder[i] = (T × w[i]) mod 10000`.
3. `leftover = T − sum(share)`.
4. Order the splits by `remainder` descending; ties by list position ascending (earlier first). Add 1 to the share of the first `leftover` splits in that order.

Shares are non-negative and sum exactly to `T`. Each refund is split on its own amount; shares are not corrected against earlier refunds.

**Worked example.** `percentBps = 1000`, `fixedMinor.USD = 17`. A USD payment `pay_1` of `131` with splits `m_a: 3333`, `m_b: 3333`, `m_c: 3334` is captured:

- `percentFee = roundHalfEven(131 × 1000 / 10000) = roundHalfEven(13.1) = 13`; `fee = min(13 + 17, 131) = 30`; `net = 101`.
- `T × w`: `336633`, `336633`, `336734` → floors `33, 33, 33` (sum 99), remainders `6633, 6633, 6734`, `leftover = 2`.
- Order: `m_c` (6734), then `m_a` (6633, earlier than `m_b` on the tie), then `m_b`. The first 2 get +1 → shares `m_a = 34`, `m_b = 33`, `m_c = 34`.
- Balances afterwards: `m_a` 34, `m_b` 33, `m_c` 34 (USD). `GET /payments/pay_1` shows `feeMinor: 30`.

A refund of `50` on `pay_1` splits as `T × w`: `166650`, `166650`, `166700` → floors `16, 16, 16`, remainders `6650, 6650, 6700`, `leftover = 2` → `m_c`, then `m_a` → shares `17, 16, 17`. Balances afterwards: `m_a` 17, `m_b` 17, `m_c` 17. The `fee` of 30 is not returned. `refundedMinor` is `50`.

A fee that reaches the cap: `percentBps = 1000`, `fixedMinor.USD = 30`, `A = 20` → `min(2 + 30, 20) = 20`, so `net = 0` and every share is 0 (each merchant still gets a ledger entry with balance 0).

#### Refund

A `payment.refunded` event applied to a `captured` payment with amount `A` and already-refunded total `R`:

- `amountMinor > A − R` → 422 `refund_exceeds_capture`. Nothing is stored and the event `id` stays unused. `amountMinor == A − R` is allowed.
- Otherwise `refundedMinor` becomes `R + amountMinor`, the amount is split with the largest-remainder split over the payment's splits, and each merchant's balance in the payment's currency is **decreased** by their share. Balances may become negative. The fee is not returned. `refundId` is stored and has no other effect: event `id` alone decides idempotency.

#### Deferred events and release

A deferred event is applied automatically, in the same request, as soon as its precondition holds:

- After a payment is created by `payment.authorized`, and after any later state change of a payment, the receiver looks at the deferred events of that `paymentId` in the order they were received (the order they were first accepted). Each one is run through the table above against the payment's current state, in that order. This repeats from the start of the list until a full pass applies nothing new.
- A deferred event that, when run, would be `processed` takes effect as `processed`. One that would be `ignored` is discarded with no effect. One that is still `deferred` stays deferred. A released refund whose amount is greater than `A − R` at that moment is discarded with no effect (no error is reported anywhere).
- Released events are removed from the deferred list. Their ids stay recorded, so a repeat of one answers `duplicate` (identical body) or `event_conflict`.
- The response to the request that triggered the release is the response for that request's own event (for example 200 `processed` for the authorization).

Example: `payment.refunded` (id `e3`), then `payment.captured` (`e2`), then `payment.authorized` (`e1`) for the same new payment. The first two answer 202 `deferred`. The authorization answers 200 `processed` and, in that same request: the payment is created; `e3` is run first and stays deferred (not yet captured); `e2` is run and captures; the pass repeats, `e3` is run and applies the refund. Afterwards the payment is `captured` with its refund applied.

#### Atomicity

All data changes of one request (the recorded event, the payment, the ledger, and every deferred event released by it) commit together or not at all.

`options.hooks.beforeCommit`, when given, is called exactly once per request that would change stored data (an answer of 200 `processed`, 200 `ignored` or 202 `deferred`), with the event's `id`, after all of the request's changes have been made and immediately before they commit. It is not called for any other answer. If it throws, the request's changes are rolled back, the answer is 500 `internal_error`, and stored data is exactly as it was before the request — including that the event `id` is not recorded, so sending the same event again is handled as new.

## Reads

Reads have no signature requirement.

### GET /balances/:merchantId

200:

```json
{ "merchantId": "m_a", "balances": { "USD": 34 } }
```

`balances` has one key per currency in which the merchant has a ledger entry, with the current balance as an integer (possibly negative or 0). A merchant with no ledger entry in any currency → 404 `not_found`. A merchant that only appears in the `splits` of payments that are not yet captured has no ledger entry.

### GET /payments/:paymentId

200:

```json
{ "paymentId": "pay_1", "status": "captured", "amountMinor": 131, "currency": "USD", "feeMinor": 30, "refundedMinor": 50 }
```

- `status`: `"authorized"`, `"captured"` or `"failed"`.
- `feeMinor`: `null` until captured, then the fee.
- `refundedMinor`: sum of applied refunds, `0` when none.

A payment that does not exist (including one that only has deferred events) → 404 `not_found`.

## Shared database

Any number of `App` instances, in one process or in several, may use one `dbPath` at once, and requests may arrive at them concurrently. The outcome must be the same as if the requests had run one at a time in some order, each fully before the next. In particular:

- Concurrent requests with the same event `id` and identical bodies: exactly one is `processed` (or `ignored` / `deferred`), the others answer `duplicate`.
- Concurrent requests with the same event `id` and different bodies: exactly one takes effect, the others answer 409 `event_conflict`.
- Concurrent events for one payment never lose or double-apply a balance change.
- A request never fails because another instance is using the database at the same moment: it waits its turn.
