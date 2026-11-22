# Realtime Fixture (WebSocket & SSE)

`realtimeClient` tests WebSocket and Server-Sent Events (SSE) APIs directly from a test, without a browser. Open a connection, send messages, wait for the one you expect, and check everything that arrived. It also covers checking that an action in one place reaches another client.

Playwright can already watch the sockets a page opens (`page.on('websocket')`). Use this fixture when the socket API itself is what you test: notifications, live updates, chat, a price feed.

---

## What It Does

- **WebSocket:** `connect(url)` opens a connection with your headers, subprotocols and bearer token. `send()` takes text, bytes or any value as JSON.
- **SSE:** `subscribe(url)` reads a `text/event-stream` response. Each event has its type (`event:`), `data`, `id` and `retry`.
- **Waiting without races:**
  - Every connection keeps what it received.
  - `waitForMessage()` returns the first matching message that no earlier wait returned, whether it already arrived or is still to come. So "send, then wait for the reply" can't miss a fast reply, and the same reply twice needs two waits.
  - Match on exact text, a RegExp, a JSON subset (`{ type: 'order.created', orderId }`) or any function.
- **Readable failures:**
  - A wait that times out lists what did arrive.
  - When the connection closes, a pending wait fails right away with the close code instead of running out its timeout.
  - A refused handshake throws `RealtimeError` with the HTTP `status` and the start of the `body`, so you can test that an anonymous connection gets 401.
- **One base URL for both:** relative URLs resolve against `realtime.url`. `connect()` switches http(s) to ws(s), and `subscribe()` switches back.
- **Cleanup:** connections still open when the test ends are closed.

---

## Setup

### Install

WebSockets go through the [`ws`](https://github.com/websockets/ws) package, an optional peer dependency. It sends headers, and when the server refuses the handshake it reports the status and body (Node's built-in `WebSocket` reports neither). SSE uses Node's built-in `fetch` and needs nothing.

```bash
npm install --save-dev ws
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_REALTIME_URL` | Base URL for relative URLs, e.g. `http://localhost:8080` | — |
| `PW_REALTIME_AUTH_TOKEN` | Bearer token, sent as `Authorization: Bearer …` on every connection | — |
| `PW_REALTIME_TIMEOUT` | Default wait for a message, in ms | `10000` |
| `PW_REALTIME_CONNECT_TIMEOUT` | Default wait for a connection to open, in ms | `10000` |

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "realtime": { "url": "http://localhost:8080" }
        },
        "dev": {
            "realtime": {
                "url": "https://api.dev.example.com",
                "headers": { "X-Tenant": "tests" },
                "timeout": 15000
            }
        }
    }
}
```

The token can come from a [secrets provider](./secrets): map it to `realtime.authToken`.

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import { ConfigLoader } from '@inluxc/propmaster';

const config = new ConfigLoader().load();

export default defineConfig({
    projects: [
        {
            name: 'api',
            testDir: './tests/api',
            use: { realtime: config.realtime, openapi: config.openapi },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `url` | `string` | — | Base URL. Absolute URLs passed to `connect()`/`subscribe()` don't need it |
| `headers` | `Record<string, string>` | — | Sent on every connection |
| `authToken` | `string` | — | Wins over the auth helpers' token |
| `timeout` | `number` | `10000` | Default wait for a message, ms |
| `connectTimeout` | `number` | `10000` | Default wait for a connection, ms |

---

## Usage

### WebSocket: send and wait for the reply

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-RT-001] an order update reaches the subscriber', { tag: ['@TC-RT-001'] }, async ({ realtimeClient, openApiClient }) => {
    const ws = await realtimeClient.connect('/live', { protocols: 'orders.v1' });

    await test.step('Step 1: Subscribe to the order', async () => {
        await ws.send({ op: 'subscribe', orderId });
        await ws.waitForMessage({ op: 'subscribed', orderId });
    });

    await test.step('Step 2: Change the order and wait for the update', async () => {
        await (openApiClient.client as any).shipOrder({ id: orderId });
        const update = await ws.waitForMessage({ type: 'order.shipped', orderId }, { timeout: 15_000 });
        expect(update.json()).toMatchObject({ status: 'shipped' });
    });
});
```

Other clients may share the server, so match on something unique to the test: an order ID, a `testData.unique()` value.

A matcher can be:

| Matcher | Matches |
|---|---|
| `'pong'` | The exact text |
| `/^order-\d+$/` | Text matching the pattern |
| `{ type: 'ack', id: 3 }` | Messages that parse as JSON and contain these fields and values (nested objects too; arrays element by element) |
| `(m) => m.binary && m.bytes.length > 0` | Anything |
| left out | The next message |

Each message has `data` (text), `binary`, `bytes` (a Buffer), `receivedAt` and `json()`.

### One client's action reaches another

```typescript
const alice = await realtimeClient.connect('/chat/room-1', { headers: { Authorization: `Bearer ${aliceToken}` } });
const bob = await realtimeClient.connect('/chat/room-1', { headers: { Authorization: `Bearer ${bobToken}` } });

await alice.send({ text: 'hi bob', clientId });
const received = await bob.waitForMessage({ text: 'hi bob', clientId });
expect(received.json()).toMatchObject({ from: 'alice' });
```

### Server-Sent Events

```typescript
const sse = await realtimeClient.subscribe('/orders/events', { lastEventId: '41' });

const created = await sse.waitForMessage({ orderId }, { event: 'order.created' });
const [first, second] = await sse.waitForMessages(2, undefined, { event: 'tick' });
expect(sse.lastEventId).toBe(second.id);
```

`{ event }` limits a wait to one event type. Events without an `event:` field have the type `message`. `status` and `headers` hold the stream response's.

### Closing, and checking the server closes

```typescript
const info = await ws.close(1000, 'done');        // the code and reason the server answered with
await expect(ws.send('late')).rejects.toThrow(/the connection closed/);

const kicked = await realtimeClient.connect('/live');
await kickUser();                                  // the server should drop the connection
expect(await kicked.waitForClose()).toEqual({ code: 4001, reason: 'kicked' });
```

### Auth, and a refused connection

With the [auth helpers](./auth) configured, every connection sends `Authorization: Bearer <token>` for the test's role, like `openApiClient` does. A header the test sets itself wins, and `realtime.authToken` wins over the auth helpers. `{ auth: false }` sends no token:

```typescript
import { RealtimeError } from '@inluxc/propmaster';

const error = await realtimeClient.connect('/live', { auth: false }).catch((e: unknown) => e);
expect(error).toBeInstanceOf(RealtimeError);
expect(error).toMatchObject({ status: 401 });
// "WebSocket connection to ws://localhost:8080/live failed: the server answered 401 Unauthorized instead of opening the connection: token expired"
```

`setAuthToken(token)` and `setHeader(name, value)` apply to every later connection in the test. Browsers can't send headers on a WebSocket, so some APIs take the token as a query parameter instead: put it in the URL.

### With the Steps class

```typescript
import { RealtimeSteps } from '@inluxc/propmaster/steps';

const realtime = new RealtimeSteps(realtimeClient);
const ws = await realtime.connect('Open the live feed', '/live');
await realtime.sendAndExpect('Verify subscribing is confirmed', ws, { op: 'subscribe', orderId }, { op: 'subscribed', orderId });
await realtime.expectNoMessage('Verify nothing arrives for other orders', ws, { orderId: 'someone-else' }, 2000);
await realtime.expectConnectRejected('Verify an anonymous connection is refused', '/live', 401, { auth: false });
await realtime.expectClosed('Verify the server drops a kicked user', ws, 4001);
```

`subscribe`, `expectEvent` and `expectSubscribeRejected` do the same for SSE. Each method is one `test.step()` in the report.

### Outside a test

`createRealtimeClient(config)` gives the same client for a global setup or a script. Call `closeAll()` when done:

```typescript
import { createRealtimeClient, ConfigLoader } from '@inluxc/propmaster';

const client = createRealtimeClient(new ConfigLoader().load().realtime);
try {
    const ws = await client.connect('/admin');
    await ws.send({ op: 'reset-test-tenant' });
    await ws.waitForMessage({ op: 'reset', ok: true });
} finally {
    await client.closeAll();
}
```

### API Reference

**`realtimeClient`**

| Method | Returns | |
|---|---|---|
| `connect(url?, { headers, protocols, timeout, auth })` | `WebSocketConnection` | `url` relative to `realtime.url`, or absolute |
| `subscribe(url?, { headers, lastEventId, timeout, auth })` | `SseConnection` | |
| `setHeader(name, value)` / `setAuthToken(token)` | `void` | For every later connection of this test |
| `closeAll()` | `void` | Done for you after the test |
| `url` | `string \| undefined` | The base URL |

**Both connections**

| Member | |
|---|---|
| `waitForMessage(matcher?, { timeout })` | The first matching message no earlier wait returned. SSE also takes `{ event }` |
| `waitForMessages(count, matcher?, { timeout })` | The next `count` matching messages, in order |
| `messages()` | Everything received so far, oldest first |
| `isOpen`, `url` | |

**`WebSocketConnection`:** `send(message)`, `close(code?, reason?)`, `waitForClose({ timeout })`, `protocol` (the subprotocol the server picked).

**`SseConnection`:** `close()`, `status`, `headers`, `lastEventId`.

---

## Lifecycle

1. **Setup:** the client is created per test. Nothing connects until `connect()` or `subscribe()`.
2. **Teardown:** connections still open are closed: WebSockets with code 1000 (cut off if the server doesn't answer within 2 s), SSE streams by stopping the read. Whatever the messages made the server do stays done: clean up what a test creates with [`testData.cleanup()`](./test-data).

The SSE client doesn't reconnect when the server ends the stream, as a browser would. A test sees the end instead: pending waits fail with "the server ended the stream". To test resuming, `subscribe()` again with `{ lastEventId: sse.lastEventId }`.

---

## Testing against a server

The repository's examples run against [echo-server](https://github.com/jmalloc/echo-server). It echoes WebSocket messages on any path, after a greeting, and streams SSE on `/.sse`: the request it received, then the time every second. It's in `compose.test.yaml`:

```bash
docker compose -f compose.test.yaml up -d --wait echo-server
PW_REALTIME_URL=http://localhost:8091 npx playwright test --project=realtime
```

The image has no shell, so it has no health check. It serves as soon as the container runs.

For a server with a certificate your machine doesn't trust (`wss://`, `https://`), point Node at its CA: `NODE_EXTRA_CA_CERTS=certs/dev-ca.pem`.

---

## Error Handling

| Error | When |
|---|---|
| `RealtimeError` (a `FixtureOperationError`, `realtime`, `connect` / `subscribe`) | The connection didn't open. `status` and `body` are set when the server answered with HTTP instead, e.g. 401. Otherwise the message says why: the server can't be reached, nothing answered in time, the server accepted none of the offered subprotocols, or the SSE response isn't `text/event-stream` |
| `FixtureOperationError` (`realtime`, `waitForMessage`) | Nothing matched in time, or the connection closed first. The message lists what arrived |
| `FixtureOperationError` (`realtime`, `send`) | The connection is closed |
| `FixtureOperationError` (`realtime`, `waitForClose`) | Still open after the timeout |
| `FixtureOperationError` (`realtime`, `json`) | `json()` on a message that isn't JSON |
| `FixtureOperationError` (`realtime`, `connect` / `subscribe`) | A relative URL with no `realtime.url`, or a scheme other than http(s)/ws(s) |
| `MissingPackageError` | `ws` isn't installed (WebSocket only; SSE needs nothing) |
