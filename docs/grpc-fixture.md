# gRPC Fixture

`grpcClient` calls gRPC services from a test, the way `openApiClient` calls REST ones: unary and streaming calls, metadata, deadlines, TLS and tokens, and failures that come back as the gRPC status code and the server's message.

---

## What It Does

- **Finds the services for you.** From `.proto` files, or from the server itself through [server reflection](https://grpc.io/docs/guides/reflection/) when it offers it. With reflection, a test needs no proto files at all. With both, the proto files win and reflection covers the rest.
- **All four call types:** `call()` for unary methods, `serverStream()` (every message, collected into an array once the stream ends), `clientStream()` and `bidiStream()`.
- **Messages are plain objects** with the field names from the `.proto` file. 64-bit integers and enums come back as strings (`'9007199254740993'`, `'BOOK'`), and unset fields have their default value, so `toEqual` sees the whole message.
- **Readable failures.** A non-OK status throws `GrpcError` with `code`, `codeName` (`NOT_FOUND`), `statusDetails` and `trailers`. `invoke()` returns the status instead of throwing, for tests that expect a failure. An unknown method, a missing service or a server that can't be reached each say so, listing what is there.
- **A deadline on every call** (10 s by default), metadata per call or on every call, TLS with your CA or a client certificate, and the [auth helpers'](./auth) bearer token.

---

## Setup

### Install

The driver is an optional peer dependency:

```bash
npm install --save-dev @grpc/grpc-js @grpc/proto-loader
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_GRPC_ADDRESS` | Server address: `host:port`, or `grpcs://host:port` for TLS | — (required) |
| `PW_GRPC_PROTO_FILES` | `.proto` files, comma-separated. Leave out to use server reflection only | — |
| `PW_GRPC_INCLUDE_DIRS` | Folders that `import` statements are resolved against, comma-separated | — |
| `PW_GRPC_REFLECTION` | `false` to use only the proto files | `true` |
| `PW_GRPC_AUTH_TOKEN` | Bearer token, sent as `authorization: Bearer …` metadata | — |
| `PW_GRPC_TIMEOUT` | Deadline per call, in ms | `10000` |
| `PW_GRPC_TLS` | `true` for TLS with the system's CAs (or use a `grpcs://` address) | off |
| `PW_GRPC_TLS_CA` | CA certificate to trust: a PEM file or the PEM text | — |
| `PW_GRPC_TLS_CERT`, `PW_GRPC_TLS_KEY` | Client certificate and key, for mutual TLS | — |
| `PW_GRPC_TLS_SERVER_NAME` | Name to check the certificate against, when it isn't the address | — |
| `PW_GRPC_TLS_SKIP_VERIFY` | `true` accepts any certificate. For test servers only | `false` |

Any of the `PW_GRPC_TLS_*` variables turns TLS on. Relative paths are resolved against the directory you run Playwright from.

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "grpc": { "address": "localhost:50051" }
        },
        "dev": {
            "grpc": {
                "address": "grpcs://orders.dev.example.com:443",
                "protoFiles": ["protos/orders/v1/orders.proto"],
                "includeDirs": ["protos"],
                "metadata": { "x-tenant": "tests" },
                "timeout": 15000
            }
        }
    }
}
```

The token and certificates can come from a [secrets provider](./secrets): map them to `grpc.authToken`, `grpc.tls.ca`, `grpc.tls.cert` or `grpc.tls.key`. The certificate settings take the PEM text as well as a file path.

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
            use: { grpc: config.grpc, openapi: config.openapi },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `address` | `string` | — | Required. `grpcs://` turns TLS on |
| `protoFiles` | `string[]` | — | |
| `includeDirs` | `string[]` | — | |
| `reflection` | `boolean` | `true` | Look up services the proto files don't define |
| `tls` | `boolean \| { ca, cert, key, serverName, insecureSkipVerify }` | plaintext | |
| `authToken` | `string` | — | Wins over the auth helpers' token |
| `metadata` | `Record<string, string>` | — | Sent on every call |
| `timeout` | `number` | `10000` | Deadline per call, ms. `0` for none |
| `loaderOptions` | `object` | `{ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }` | [@grpc/proto-loader options](https://www.npmjs.com/package/@grpc/proto-loader): how messages map to objects |
| `channelOptions` | `Record<string, string \| number>` | — | gRPC channel options, e.g. `grpc.max_receive_message_length` |

---

## Usage

Methods are named `package.Service/Method`, as in the `.proto` file (`package.Service.Method` works too).

### Unary calls

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-GRPC-001] an order can be read back', { tag: ['@TC-GRPC-001'] }, async ({ grpcClient }) => {
    let orderId = '';

    await test.step('Step 1: Create the order', async () => {
        const created = await grpcClient.call('orders.v1.Orders/CreateOrder', { sku: 'p-1', quantity: 2 });
        orderId = created.id;
    });

    await test.step('Step 2: Verify it reads back with its status', async () => {
        const order = await grpcClient.call('orders.v1.Orders/GetOrder', { id: orderId });
        expect(order).toMatchObject({ id: orderId, status: 'PENDING', quantity: 2 });
    });
});
```

Give the response a type when it helps: `grpcClient.call<Order>('orders.v1.Orders/GetOrder', { id })`.

### Expected failures

`call()` throws on a non-OK status. When the failure is what the test checks, use `invoke()`, which returns the status:

```typescript
const result = await grpcClient.invoke('orders.v1.Orders/GetOrder', { id: 'no-such-order' });
expect(result.codeName).toBe('NOT_FOUND');
expect(result.details).toContain('no-such-order');
expect(result.trailers['x-error-code']).toBe('ORDER_MISSING');   // trailing metadata
```

Or check the thrown error:

```typescript
import { GrpcError } from '@inluxc/propmaster';

await expect(grpcClient.call('orders.v1.Orders/CancelOrder', { id }))
    .rejects.toMatchObject({ codeName: 'FAILED_PRECONDITION' });
```

A failing call's message reads `gRPC orders.v1.Orders/GetOrder failed: 5 NOT_FOUND: order no-such-order not found`, with any trailers the server sent.

### Streaming

```typescript
// Server streaming: every message once the stream ends, or the first N
const events = await grpcClient.serverStream('orders.v1.Orders/WatchOrder', { id }, { limit: 3 });
expect(events.map((e) => e.status)).toEqual(['PENDING', 'PAID', 'SHIPPED']);

// Client streaming: send several requests, get one response
const summary = await grpcClient.clientStream('inventory.v1.Inventory/Import', [{ sku: 'a', count: 1 }, { sku: 'b', count: 4 }]);

// Bidirectional: send the requests, close, collect the responses
const replies = await grpcClient.bidiStream('chat.v1.Chat/Talk', [{ text: 'hi' }, { text: 'bye' }]);
```

With `limit`, the call is cancelled once that many messages have arrived, which is how to test a stream that never ends on its own. A stream that fails partway throws a `GrpcError` whose `messages` holds what arrived before the failure.

### Metadata, deadlines and tokens

```typescript
grpcClient.setMetadata('x-tenant', 'acme');           // every later call
grpcClient.setAuthToken(adminToken);                   // authorization: Bearer …

const result = await grpcClient.invoke('orders.v1.Orders/GetOrder', { id }, {
    metadata: { 'x-request-id': requestId, 'trace-bin': Buffer.from(traceId) },   // this call only
    timeout: 30_000,                                                               // this call's deadline
});
expect(result.metadata['x-served-by']).toBeDefined();  // response headers
```

Past its deadline, a call ends with `DEADLINE_EXCEEDED`. Keys ending in `-bin` carry binary values. With the [auth helpers](./auth) configured, the test role's token is sent as `authorization` metadata, unless a call or `grpc.authToken` sets one.

### Finding out what a server offers

```typescript
await grpcClient.services();                            // ['orders.v1.Orders', ...]
await grpcClient.methods('orders.v1.Orders');           // [{ name, kind: 'unary' | 'serverStream' | ..., requestType, responseType }]
await grpcClient.loadProtos('protos/vendor/payments.proto', { includeDirs: ['protos'] });   // more proto files, for this test
```

### With the Steps class

```typescript
import { GrpcSteps } from '@inluxc/propmaster/steps';

const grpc = new GrpcSteps(grpcClient);
const order = await grpc.call('Create an order', 'orders.v1.Orders/CreateOrder', { sku: 'p-1', quantity: 1 });
await grpc.expectResponse('Verify the order is pending', 'orders.v1.Orders/GetOrder', { id: order.id }, { status: 'PENDING' });
await grpc.expectStatus('Verify an unknown order is NOT_FOUND', 'orders.v1.Orders/GetOrder', { id: 'nope' }, 'NOT_FOUND');
await grpc.serverStream('Verify the watch sends three updates', 'orders.v1.Orders/WatchOrder', { id: order.id }, { limit: 3, count: 3 });
```

Each method is one `test.step()` in the report.

### Outside a test

`createGrpcClient(config)` gives the same client for a global setup or a script. Close it when done:

```typescript
import { createGrpcClient, ConfigLoader } from '@inluxc/propmaster';

const client = createGrpcClient(new ConfigLoader().load().grpc!);
try {
    await client.call('admin.v1.Admin/ResetTestTenant', { tenant: 'tests' });
} finally {
    client.close();
}
```

### API Reference

| Method | Returns | |
|---|---|---|
| `call(method, request?, { metadata, timeout })` | response | Unary. Throws `GrpcError` on a non-OK status |
| `invoke(method, request?, { metadata, timeout, limit })` | `{ ok, code, codeName, details, response, messages, metadata, trailers }` | Any method kind; never throws for a status. Pass an array of requests for client or bidirectional streams |
| `serverStream(method, request?, { metadata, timeout, limit })` | messages | |
| `clientStream(method, requests, { metadata, timeout })` | response | |
| `bidiStream(method, requests, { metadata, timeout })` | messages | Sends every request, closes, collects |
| `services()` | `string[]` | From the proto files and reflection |
| `methods(service)` | `GrpcMethodInfo[]` | `path`, `name`, `kind`, `requestType`, `responseType` |
| `loadProtos(files, { includeDirs })` | `void` | |
| `setMetadata(key, value)` / `setAuthToken(token)` | `void` | For every later call of this test |
| `address` | `string` | The server address |

---

## Lifecycle

1. **Setup:** the client is created per test. Nothing connects until the first call. Proto files are parsed once per worker; reflection runs once per service per test.
2. **Teardown:** the channel is closed. A gRPC call changes whatever the service does with it, so there's nothing for the fixture to undo: clean up what a test creates with [`testData.cleanup()`](./test-data), e.g. `testData.cleanup('delete order', () => grpcClient.call('orders.v1.Orders/DeleteOrder', { id }))`.

---

## Testing against a server

The repository's examples run against [grpcbin](https://github.com/moul/grpcbin), a test server with reflection, streaming methods, status codes on demand and a TLS port. It's in `compose.test.yaml`:

```bash
docker compose -f compose.test.yaml up -d --wait grpcbin    # plaintext on 9000, TLS (self-signed) on 9001
PW_GRPC_ADDRESS=localhost:9000 npx playwright test
```

The image is amd64 only; Docker on Apple silicon runs it emulated.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`grpc`, `connect`) | No `address` configured |
| `GrpcError` (a `FixtureOperationError`, `grpc`, `call` / `serverStream` / ...) | The call ended with a non-OK status: `code`, `codeName`, `statusDetails`, `trailers`, `messages` |
| `FixtureOperationError` (`grpc`, `reflection`) | The service isn't in the proto files and reflection can't find it. The message says why: the server can't be reached, it doesn't offer reflection (list its proto files instead), or it doesn't know the service, with the services it does know |
| `FixtureOperationError` (`grpc`, `call`) | An unknown method (the message lists the service's methods), or the wrong function for the method's kind, e.g. `call()` on a server-streaming method |
| `FixtureOperationError` (`grpc`, `loadProtos`) | A proto file is missing or doesn't parse |
| `MissingPackageError` | `@grpc/grpc-js` or `@grpc/proto-loader` isn't installed |
