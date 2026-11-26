# Budget API

A small HTTP JSON API that tracks per-category monthly spending budgets for users. Build it in this folder.

## Stack and files

- Runtime: Bun. Use native Bun only: `Bun.serve` and `bun:sqlite`. No runtime dependencies (`package.json` has none and must stay that way).
- Language: TypeScript, strict. `bun run typecheck` (`tsc --noEmit`) must pass.
- The starter files `src/app.ts` and `src/main.ts` hold the exported signatures. Keep these exports with exactly these names and types. You may add more files under `src/`.

### `src/app.ts`

```ts
export type CreateAppOptions = {
  dbPath: string;
  now?: () => Date;
};

export type App = {
  fetch(request: Request): Promise<Response>;
  close(): void;
};

export function createApp(options: CreateAppOptions): App;
```

- `createApp` opens (and creates if missing) the SQLite database at `dbPath` and creates its schema if missing. `dbPath` is any path `bun:sqlite` accepts, including `":memory:"`.
- All data lives in that SQLite database. Data persists across `createApp` instances opened on the same `dbPath`: after `close()`, a new `createApp` on the same file sees every user, budget and spend created before.
- `now` is the clock. It defaults to the real current time (`() => new Date()`). It is called once per request that needs the current time; each call may return a different value.
- `fetch(request)` handles one HTTP request and always resolves to a `Response`. It never rejects.
- `close()` closes the database. `fetch` is not called after `close()`.

### `src/main.ts`

```ts
export function startServer(): ReturnType<typeof Bun.serve>;
```

- `startServer()` calls `createApp` and serves it with `Bun.serve`, passing each request to `app.fetch`.
- Port: env `PORT` (a decimal integer); default `3000`.
- Database path: env `DB_PATH`; default `budget.db`.
- Running `bun src/main.ts` starts the server.

## Conventions

- Requests and responses are JSON. Every response with a body has header `Content-Type: application/json`.
- Request bodies are parsed as JSON regardless of the request's `Content-Type` header.
- IDs are positive integers. Users and spends each have their own id sequence: the first user created has id `1`, the next `2`, and so on; the same for spends. Ids are never reused and continue across `createApp` instances on the same database.
- All money amounts are integer cents (JSON numbers).
- Unknown fields in a request body are ignored.
- A JSON number counts as an integer when its value is a whole number (`5`, `5.0` and `5e0` are all the integer 5). Numbers given as strings are not numbers.
- String length is counted in Unicode code points. Strings are stored and returned exactly as sent (no trimming, no case change).
- Query strings are ignored. Paths are matched exactly as sent: a trailing slash, or any extra or missing segment, makes the path an unknown route. Path segments are compared as raw text (no percent-decoding).
- Every string anywhere in the body must be well-formed Unicode: a string containing an unpaired UTF-16 surrogate (for example the JSON escape "\ud800" on its own) is invalid → 400 invalid_input.

## Data rules

| Field | Rule |
|---|---|
| `name` | string, 1–100 characters |
| `timeZone` | string naming an IANA time zone that `Intl.DateTimeFormat(undefined, { timeZone })` accepts, e.g. `Europe/Paris`, `America/New_York`, `UTC`. Offset-style values such as `+02:00` are invalid, and so is the empty string |
| `category` | string, 1–50 characters, each character one of `a`–`z`, `0`–`9`, `-` |
| `limitCents` | integer, 1 to 1,000,000,000 inclusive |
| `amountCents` | integer, 1 to 1,000,000,000 inclusive |
| `spentAt` | RFC 3339 timestamp that includes an offset: `YYYY-MM-DDTHH:MM:SS`, optionally followed by `.` and 1–9 digits, then either `Z` or `+HH:MM` / `-HH:MM`. `T` and `Z` are uppercase. The date and time must exist: month 01–12, a day valid for that month and year (leap years apply), hour 00–23, minute 00–59, second 00–59 (no leap second `60`), offset hour 00–23, offset minute 00–59 |

A request body must be a JSON object. A body that is empty, is not valid JSON, or is JSON but not an object (array, string, number, boolean, `null`) is invalid. A required field that is missing, or whose value is `null` or of the wrong type, is invalid.

## Routes

A route's path shape is `/users`, `/users/{userId}/budgets`, `/users/{userId}/spends` or `/users/{userId}/budgets/{category}/summary`, where `{userId}` and `{category}` are any non-empty text without `/`. A path with one of these shapes is a known path; any other path is an unknown route.

A `{userId}` is valid only if it is written in decimal digits with no sign and no leading zeros (`1`, `42`), and is a positive integer no greater than 9007199254740991. Any other `{userId}` text (`abc`, `0`, `-1`, `01`, `1.5`) names no user.

### `POST /users`

Request:

```json
{ "name": "Ada", "timeZone": "Europe/Paris" }
```

Response `201`:

```json
{ "id": 1, "name": "Ada", "timeZone": "Europe/Paris" }
```

Creates a user. Names need not be unique.

### `POST /users/{userId}/budgets`

Request:

```json
{ "category": "groceries", "limitCents": 50000 }
```

Response `201`:

```json
{ "category": "groceries", "limitCents": 50000 }
```

Creates a monthly budget for that user and category. The limit applies to every calendar month; there is one budget per user and category and it cannot be changed or deleted. A second budget for the same category for the same user fails with `409 budget_exists`. Different users may each have a budget for the same category.

### `POST /users/{userId}/spends`

Request:

```json
{ "category": "groceries", "amountCents": 1250, "spentAt": "2026-03-14T18:30:00+01:00" }
```

Response `201`:

```json
{ "id": 1, "category": "groceries", "amountCents": 1250, "spentAt": "2026-03-14T18:30:00+01:00" }
```

Records a spend for that user. `spentAt` is returned exactly as sent. If the user has no budget for `category`, it fails with `422 no_budget` and nothing is stored. `spentAt` may be any valid timestamp, in the past or the future; it is not checked against `now()`.

### `GET /users/{userId}/budgets/{category}/summary`

Response `200`:

```json
{
  "category": "groceries",
  "month": "2026-03",
  "limitCents": 50000,
  "spentCents": 12500,
  "remainingCents": 37500,
  "daysLeft": 18,
  "dailyAllowanceCents": 2083
}
```

All times below are evaluated in the user's `timeZone`. A spend's `spentAt` denotes an instant (its offset is only used to locate that instant); the instant is then viewed in the user's time zone.

- `month`: the calendar month, as `YYYY-MM`, that contains `now()`.
- `spentCents`: the sum of `amountCents` of that user's spends in `{category}` whose instant falls inside that same calendar month (from the first instant of the month's first day, up to but not including the first instant of the next month). `0` when there are none.
- `remainingCents`: `limitCents - spentCents`. It is negative when the budget is exceeded.
- `daysLeft`: the number of calendar days from the day containing `now()` through the last day of that month, both included. On the last day of the month it is `1`. It counts calendar days, not 24-hour periods.
- `dailyAllowanceCents`: `floor(remainingCents / daysLeft)` when `remainingCents > 0`, otherwise `0`.

If `{category}` is not a category the user has a budget for (including text that is not a valid category), the response is `404 not_found`.

## Errors

Every non-2xx response has exactly this body, with exactly these two keys:

```json
{ "code": "invalid_input", "message": "timeZone is not a valid IANA time zone" }
```

`code` is one of the values below. `message` is a non-empty human-readable string whose wording is free.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_input` | the body is empty, malformed JSON, not an object, or any field fails its rule |
| 404 | `not_found` | the path is an unknown route; the user does not exist; a summary's budget does not exist |
| 405 | `method_not_allowed` | the path is a known path but the method is not the one listed for it (`POST` for `/users`, `/users/{userId}/budgets` and `/users/{userId}/spends`; `GET` for the summary path). Every other method, `HEAD` and `OPTIONS` included, gets 405 on a known path |
| 409 | `budget_exists` | the budget already exists for that user and category |
| 422 | `no_budget` | a spend names a category the user has no budget for |
| 500 | `internal_error` | any other unexpected failure; the body never contains a stack trace or internal details |

### Order of checks

A request is checked in this order, and the first failure decides the response:

1. Path: unknown route → `404 not_found`.
2. Method: wrong method on a known path → `405 method_not_allowed`.
3. User: `{userId}` names no existing user → `404 not_found`.
4. Body: any invalid body or field → `400 invalid_input`. (Summary requests have no body.)
5. Business rule: `409 budget_exists`, `422 no_budget`, or for a summary an unknown budget → `404 not_found`.

A request that fails validation changes no data.
