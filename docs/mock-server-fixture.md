# Mock Server Fixture

The `mockServer` fixture stands in for the **third-party APIs your backend calls**: payment providers, email and SMS APIs, partner services. Stub their answers, including errors, slow responses and dropped connections, and check the calls your backend made. It drives [WireMock](https://wiremock.org/) through its admin API.

Playwright's `page.route()` only sees requests from the browser. `mockServer` covers the calls your **server** makes.

---

## What It Does

- Stubs requests by method, path (exact or pattern), query, headers and JSON body, with any status, JSON or text, headers and delay
- Sequences of answers (fail twice, then succeed) for testing retries, plus simulated connection faults
- Lists and verifies the calls made **since the test started**; a failed verify shows the closest calls that did arrive
- Removes the test's stubs when it ends
- Needs no package (uses Node's `fetch`); can start WireMock itself in a container (`PW_MOCK_CONTAINER=true`)

---

## Setup

### Install

Nothing extra. You need a WireMock server:

```bash
# Locally, with the repo's compose file (port 8089)
docker compose -f compose.test.yaml up -d --wait wiremock

# Or let the test run start one (needs Docker and testcontainers)
npm install --save-dev testcontainers
PW_MOCK_CONTAINER=true npx playwright test
```

### Point your backend at it

Configure the application under test to call WireMock instead of the real provider in its test environment, for example `PAYMENTS_API_URL=http://localhost:8089`. Paths stay the same: the app calls `http://localhost:8089/v1/charges`, and the test stubs `/v1/charges`. When the fixture starts WireMock itself, `mockServer.url` has the address.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_MOCK_URL` | Yes (unless container) | WireMock base URL, e.g. `http://localhost:8089` |
| `PW_MOCK_ADMIN_URL` | No | Admin API URL, when it differs from `PW_MOCK_URL` |
| `PW_MOCK_CONTAINER` | No | `true` (or an image) starts WireMock for the run; see [Testcontainers](./testcontainers) |

### Configuration

```json
{ "environments": { "local": { "mock": { "url": "http://localhost:8089" } } } }
```

or per project: `use: { mock: { url: 'http://localhost:8089' } }`.

---

## Usage

### Stub a provider and check the call

```typescript
import { randomUUID } from 'node:crypto';
import { test, expect } from '@inluxc/propmaster';

test('[TC-MCK-NNN] checkout charges the card once', { tag: ['@TC-MCK-NNN'] }, async ({ page, mockServer }) => {
    const orderId = randomUUID();

    await test.step('Step 1: Stub a successful charge for this order', async () => {
        await mockServer.stub(
            { method: 'POST', path: '/v1/charges', body: { metadata: { orderId } } },
            { status: 201, json: { id: 'ch_123', status: 'succeeded' } },
        );
    });

    await test.step('Step 2: Check out in the browser', async () => {
        await page.goto(`/checkout?order=${orderId}`);
        await page.getByRole('button', { name: 'Pay' }).click();
        await expect(page.getByText('Payment received')).toBeVisible();
    });

    await test.step('Step 3: Verify the backend charged exactly once', async () => {
        const [call] = await mockServer.verify({ method: 'POST', path: '/v1/charges', body: { metadata: { orderId } } }, { times: 1 });
        expect(call.json).toMatchObject({ amount: 4999, currency: 'eur' });
    });
});
```

### Failures, slowness and retries

```typescript
// Two outages, then success: does the backend retry?
await mockServer.stubSequence({ method: 'POST', path: '/v1/charges' }, [
    { status: 503, json: { error: 'unavailable' } },
    { status: 503, json: { error: 'unavailable' } },
    { status: 201, json: { id: 'ch_1' } },
]);

// A slow provider (does the backend time out gracefully?)
await mockServer.stub({ path: '/v1/rates' }, { json: { eur: 1 }, delayMs: 5_000 });

// A dropped connection
await mockServer.stub({ path: '/v1/rates' }, { fault: 'CONNECTION_RESET_BY_PEER' });

// The backend must NOT call the refunds API
await mockServer.verify({ method: 'POST', pathPattern: /^\/v1\/refunds/ }, { times: 0 });
```

### Matching

| Field | Matches |
|---|---|
| `method` | HTTP method (default: any) |
| `path` | The exact path, without the query string |
| `pathPattern` | A `RegExp` (matches anywhere in the path, as in JavaScript), or a string WireMock regex (must match the whole path) |
| `query`, `headers` | Exact values, or `RegExp`s (`i` and `s` flags honoured) |
| `body` | JSON the body must contain; extra fields and array order are ignored |
| `bodyContains` | A substring of the raw body |

### With the Steps class

```typescript
import { MockServerSteps } from '@inluxc/propmaster/steps';

const mocks = new MockServerSteps(mockServer);
await mocks.stub('Stub the charge', { method: 'POST', path: '/v1/charges' }, { status: 201, json: { id: 'ch_1' } });
await mocks.verifyCalled('Verify one charge', { method: 'POST', path: '/v1/charges' }, 1);
await mocks.verifyNotCalled('Verify no refund', { method: 'POST', path: '/v1/refunds' });
```

### API Reference

| Member | Returns | Description |
|--------|---------|-------------|
| `url` | `string` | Base URL to give the application |
| `stub(match, response)` | `Promise<Stub>` | Answers matching requests until the test ends; `stub.remove()` removes it earlier |
| `stubSequence(match, responses)` | `Promise<Stub>` | Answers in turn, then repeats the last one |
| `requests(match?)` | `Promise<RecordedRequest[]>` | Calls since the test started, oldest first |
| `verify(match, { times?, atLeast? })` | `Promise<RecordedRequest[]>` | Checks the count (default: at least one); fails listing the closest calls |

A `RecordedRequest` has `method`, `url`, `path`, `query`, `headers` (lower-case names), `body`, `json`, `date` and `matched`. A response takes `status`, `json` or `body`, `headers`, `delayMs` and `fault`.

---

## Parallel tests

Stubs live on one shared WireMock, so:

- **Each test's stubs are removed when it ends**, tagged with the test's ID.
- **`requests()` and `verify()` only see calls made since the test started**, measured on WireMock's own clock.
- **Match on a value unique to the test.** An order ID, an email or a customer ID in the body or query means parallel tests never answer or count each other's calls. The examples use `randomUUID()`.
- **When you can't** (an endpoint with no test-specific data), two parallel tests stubbing it differently will clash. Run those tests serially with `test.describe.configure({ mode: 'serial' })`.

The example suite runs correctly with 6 workers repeating each test 4 times against one WireMock.

---

## Lifecycle

1. **Setup:** loads the config, starts WireMock if `container` is set, checks its health, and reads its clock.
2. **Test:** stubs are tagged with the test.
3. **Teardown:** the test's stubs are removed. The request journal is shared and left as is.

## Error Handling

- **`FixtureInitError`:** config is missing, or WireMock isn't reachable.
- **`FixtureOperationError` (`stub`):** WireMock rejected the stub, for example an invalid regex.
- **`FixtureOperationError` (`verify`):** the count didn't match. The message gives the expected match, the count received, and up to five calls received since the test started, closest first.
