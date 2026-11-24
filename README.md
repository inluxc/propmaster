<p align="center"><img src="https://propmaster.dev/logo.svg" alt="Propmaster logo" width="96"></p>

# Propmaster (`@inluxc/propmaster`)

> *In theater, the **prop master** sources every prop, sets it out before the scene, and collects it afterwards, so each actor finds exactly what they need at the moment they need it. The audience never sees them, but without them, the show doesn't happen.*

**Propmaster** does the same for your [Playwright](https://playwright.dev/) tests. It sets up the infrastructure fixtures — API clients (REST, GraphQL, gRPC, WebSocket/SSE), databases, message queues, caches, mobile devices, OTP — so your tests can focus on the performance itself.

---

An extension toolkit for [Playwright Test](https://playwright.dev/) that adds ready-to-use fixtures for API, database, messaging, cache, mobile, and OTP testing. You keep your existing Playwright setup — Propmaster just gives you more fixtures to work with.

📖 **Documentation:** [propmaster.dev](https://propmaster.dev/)

## Installation

```bash
# Playwright is a peer dependency — you bring your own version
npm install --save-dev @playwright/test @inluxc/propmaster

# Then the driver for each fixture you use (all optional), e.g.:
npm install --save-dev openapi-client-axios pg kafkajs
```

| Fixture | Install |
|---|---|
| `openApiClient` | `openapi-client-axios` (`js-yaml` too, for YAML spec files; `ajv` and `ajv-formats` for contract checks) |
| `graphqlClient` | `graphql-request graphql` |
| `grpcClient` | `@grpc/grpc-js @grpc/proto-loader` |
| `realtimeClient` | `ws` (WebSocket; SSE needs nothing) |
| `databaseClient` | `pg` (PostgreSQL), `mysql2` (MySQL), `mssql` (MSSQL) or `better-sqlite3` (SQLite) |
| `mongoDbClient` | `mongodb` |
| `neo4jClient` | `neo4j-driver` |
| `cassandraClient` | `cassandra-driver` |
| `kafkaClient` | `kafkajs` (or `@confluentinc/kafka-javascript` with `PW_KAFKA_DRIVER=confluent`) |
| `amqpClient` | `amqplib` |
| `s3Client` | `@aws-sdk/client-s3` |
| `sqsClient` | `@aws-sdk/client-sqs` (`@aws-sdk/client-sns` too, for topics) |
| `dynamoDbClient` | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` |
| `searchClient` | nothing (uses `fetch`); needs Elasticsearch or OpenSearch |
| `redisClient` | `ioredis` |
| `otpClient` | `otplib` |
| `inboxClient` | nothing (uses `fetch`); needs a [Mailpit](https://mailpit.axllent.org/) server |
| `mockServer` | nothing (uses `fetch`); needs a [WireMock](https://wiremock.org/) server |
| `appiumDriver` | `webdriverio` (`gadsHub` needs nothing extra) |
| `container: true` on any backend ([Testcontainers](https://propmaster.dev/testcontainers)) | `testcontainers` |

A fixture whose driver is missing fails with a `MissingPackageError` naming the package to install. Propmaster has no runtime dependencies of its own.

## How It Works

Propmaster exports an extended `test` object built on top of `@playwright/test`. All standard Playwright fixtures (`page`, `request`, `context`, etc.) remain available. The package simply layers additional fixtures on top:

```typescript
// Instead of:
import { test, expect } from '@playwright/test';

// Use:
import { test, expect } from '@inluxc/propmaster';

// You still have access to `page`, `request`, etc.
test('browser test still works', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
});

// Plus new fixtures:
test('api test with OpenAPI client', async ({ openApiClient }) => {
  const { client } = openApiClient;
  const res = await (client as any).listUsers();
  expect(res.status).toBe(200);
});
```

---

## Project Layout

`npx propmaster init` scaffolds one folder per test type, each run as its own Playwright project from a single root config:

```
tests/
├── api/           # REST / GraphQL: no browser, device or service   → --project=api
├── integration/   # needs a database, broker or cache                → --project=integration
├── e2e/           # browser user journeys                            → --project='e2e-*'
├── mobile/        # Appium / GADS                                    → --project=mobile-android
└── support/       # page objects, fixtures, data, helpers
```

Already have tests? `init` moves nothing. `npx propmaster organize` shows where each test belongs by the fixtures it uses, and `--apply` moves them with `git mv` and fixes their imports. See [Project Layout](docs/guide/project-layout.md).

---

## Available Fixtures

| Fixture | Type | What it does | Docs |
|---------|------|--------------|------|
| `openApiClient` | `OpenApiClient` | Typed HTTP client generated from your OpenAPI spec | [Setup & Usage](docs/openapi-fixture.md) |
| `databaseClient` | `DatabaseClient` | Multi-dialect DB client (PostgreSQL, MySQL, MSSQL, SQLite) | [Setup & Usage](docs/database-fixture.md) |
| `kafkaClient` | `KafkaClient` | Kafka producer/consumer | [Setup & Usage](docs/kafka-fixture.md) |
| `amqpClient` | `AmqpClient` | RabbitMQ / AMQP: publish, listen on an exchange, consume, purge | [Setup & Usage](docs/amqp-fixture.md) |
| `s3Client` | `S3Client` | S3 objects under a per-test prefix: write, read, list, wait for a file | [Setup & Usage](docs/aws-fixture.md) |
| `sqsClient` | `SqsClient` | SQS send/receive/purge, SNS publish and listen on a topic | [Setup & Usage](docs/aws-fixture.md) |
| `dynamoDbClient` | `DynamoDbClient` | DynamoDB items as plain objects: put/get/update/query/scan, wait for an item; writes undone after the test | [Setup & Usage](docs/dynamodb-fixture.md) |
| `searchClient` | `SearchClient` | Elasticsearch / OpenSearch: index, search, count, wait for documents under a per-test index prefix | [Setup & Usage](docs/search-fixture.md) |
| `redisClient` | `RedisClient` | Redis client with pub/sub | [Setup & Usage](docs/redis-fixture.md) |
| `mongoDbClient` | `MongoDbClient` | MongoDB CRUD and aggregation client | [Setup & Usage](docs/mongodb-fixture.md) |
| `neo4jClient` | `Neo4jClient` | Neo4j Cypher reads, writes and transactions | [Setup & Usage](docs/neo4j-fixture.md) |
| `cassandraClient` | `CassandraClient` | Cassandra / ScyllaDB: parameterized CQL, rows as plain objects, wait for a row; inserts undone after the test | [Setup & Usage](docs/cassandra-fixture.md) |
| `graphqlClient` | `GraphQLClient` | GraphQL query/mutation client | [Setup & Usage](docs/graphql-fixture.md) |
| `grpcClient` | `GrpcClient` | gRPC unary and streaming calls from .proto files or server reflection, with status codes, metadata, deadlines and TLS | [Setup & Usage](docs/grpc-fixture.md) |
| `realtimeClient` | `RealtimeClient` | WebSocket and SSE: connect, send, wait for a matching message, the HTTP status of a refused connection | [Setup & Usage](docs/realtime-fixture.md) |
| `otpClient` | `OtpClient` | TOTP/HOTP generation and verification for 2FA testing | [Setup & Usage](docs/otp-fixture.md) |
| `inboxClient` | `InboxClient` | Reads the email your app sends (Mailpit): codes, verification and reset links | [Setup & Usage](docs/inbox-fixture.md) |
| `mockServer` | `MockServer` | Stubs the third-party APIs your backend calls (WireMock) and verifies the calls it made | [Setup & Usage](docs/mock-server-fixture.md) |
| `testData` | `TestData` | Factories with values unique across workers, plus custom cleanups; data inserted through the clients is removed after each test, pass or fail | [Test Data](docs/test-data.md) |
| `authToken`, `authHeaders`, `authRequest` | `string`, headers, `APIRequestContext` | OAuth/OIDC tokens per role, refreshed before expiry and sent by `openApiClient`/`graphqlClient`; `authRole` also picks a saved browser login | [Tokens & Roles](docs/auth.md) |
| `appiumDriver` | `AppiumDriver` (WebdriverIO `Browser`) | Appium session on any Appium server, grid, cloud farm or [GADS](https://github.com/shamanec/GADS) hub; ended on teardown | [Setup & Usage](docs/appium-fixture.md) |
| `gadsHub` | `GadsHubClient` | GADS hub status and device listing | [Setup & Usage](docs/appium-fixture.md#gads-preset) |

All standard Playwright fixtures (`page`, `request`, `context`, `browser`, `browserName`) remain fully available.

> For creating your own fixtures, see [Custom Fixtures](docs/custom-fixtures.md).

---

## Usage Examples

### Mixing Playwright's `page` with Propmaster fixtures

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Full-stack test', () => {
  test('create user via API, verify in browser', async ({ openApiClient, page }) => {
    // Use the API fixture to create data
    const { client } = openApiClient;
    const res = await (client as any).createUser(null, {
      name: 'Alice',
      email: 'alice@test.com',
    });
    expect(res.status).toBe(201);

    // Use Playwright's page fixture to verify in the UI
    await page.goto('/admin/users');
    await expect(page.getByText('alice@test.com')).toBeVisible();
  });
});
```

### OpenAPI Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Pet Store API', () => {
  test('list all pets', async ({ openApiClient }) => {
    const { client } = openApiClient;
    const response = await (client as any).listPets();

    expect(response.status).toBe(200);
    expect(response.data).toBeInstanceOf(Array);
  });

  test('create and fetch a pet', async ({ openApiClient }) => {
    const { client } = openApiClient;

    const created = await (client as any).createPet(null, {
      name: 'Buddy',
      species: 'dog',
    });
    expect(created.status).toBe(201);

    const fetched = await (client as any).getPet({ petId: created.data.id });
    expect(fetched.data.name).toBe('Buddy');
  });
});
```

### gRPC Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Orders service', () => {
  test('an unknown order is NOT_FOUND', async ({ grpcClient }) => {
    // No .proto files needed when the server offers reflection
    const order = await grpcClient.call('orders.v1.Orders/CreateOrder', { sku: 'p-1', quantity: 2 });
    expect(order.status).toBe('PENDING');

    const missing = await grpcClient.invoke('orders.v1.Orders/GetOrder', { id: 'nope' });
    expect(missing.codeName).toBe('NOT_FOUND');

    const updates = await grpcClient.serverStream('orders.v1.Orders/WatchOrder', { id: order.id }, { limit: 2 });
    expect(updates).toHaveLength(2);
  });
});
```

### WebSocket & SSE Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test('an order update reaches the live feed', async ({ realtimeClient, openApiClient }) => {
  const ws = await realtimeClient.connect('/live');             // relative to PW_REALTIME_URL
  await ws.send({ op: 'subscribe', orderId });
  await ws.waitForMessage({ op: 'subscribed', orderId });         // a JSON subset

  await (openApiClient.client as any).shipOrder({ id: orderId });
  const update = await ws.waitForMessage({ type: 'order.shipped', orderId });
  expect(update.json()).toMatchObject({ status: 'shipped' });

  const sse = await realtimeClient.subscribe('/orders/events');
  await sse.waitForMessage({ orderId }, { event: 'order.shipped' });

  await expect(realtimeClient.connect('/live', { auth: false })).rejects.toMatchObject({ status: 401 });
});
```

### Database Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Database Operations', () => {
  test('query users', async ({ databaseClient }) => {
    const rows = await databaseClient.query<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE active = $1',
      [true]
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('name');
  });

  test('insert a record', async ({ databaseClient }) => {
    const result = await databaseClient.execute(
      'INSERT INTO users (name, email) VALUES ($1, $2)',
      ['Bob', 'bob@example.com']
    );

    expect(result.affectedRows).toBe(1);
  });
});
```

### Kafka Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Kafka Messaging', () => {
  test('produce and consume a message', async ({ kafkaClient }) => {
    const payload = { userId: 42, action: 'signup' };

    await kafkaClient.produce('user-events', [
      { key: 'user-42', value: JSON.stringify(payload) },
    ]);

    const messages = await kafkaClient.consume('user-events', {
      count: 1,
      timeout: 10000,
      fromBeginning: false,
    });

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].value)).toMatchObject(payload);
  });
});
```

### RabbitMQ (AMQP) Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Order events', () => {
  test('placing an order publishes order.created', async ({ amqpClient, openApiClient }) => {
    // Listen first: a temporary queue bound to the exchange, so the app's own queues keep their copies
    const listener = await amqpClient.listen('orders', 'order.*');

    const { data: order } = await (openApiClient.client as any).createOrder(null, { sku: 'SKU-1' });

    const event = await listener.waitForMessage((m) => m.json<{ orderId: string }>().orderId === order.id);
    expect(event.routingKey).toBe('order.created');
  });
});
```

### AWS Clients (S3, SQS, SNS)

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Exports', () => {
  test('an export writes its file and announces it', async ({ s3Client, sqsClient, openApiClient }) => {
    // Listen first: a temporary queue subscribed to the topic, so the app's own subscribers keep their copies
    const listener = await sqsClient.listen('exports-events');
    const key = s3Client.key('orders.csv');   // under the test's own prefix, deleted afterwards

    await (openApiClient.client as any).startExport(null, { bucket: s3Client.bucket, key });

    const file = await s3Client.waitForObject(key, { timeout: 30_000 });
    expect(file.text()).toContain('id,total');
    await listener.waitForMessage((m) => m.json<{ key: string }>().key === key);
  });
});
```

Runs on Moto (`docker compose -f compose.test.yaml up -d --wait moto`), LocalStack or a real test account.

### DynamoDB Client

```typescript
test('placing an order stores it', async ({ dynamoDbClient, openApiClient, testData }) => {
  const customerId = testData.unique('customer');
  const { data } = await (openApiClient.client as any).placeOrder(null, { customerId, sku: 'A-1' });

  // Plain objects in and out; conditions too. Polls until the app has written it.
  const order = await dynamoDbClient.waitForItem('orders', { customerId, orderedAt: data.orderedAt });
  expect(order).toMatchObject({ status: 'open' });
  const open = await dynamoDbClient.query('orders', { status: 'open' }, { index: 'byStatus', filter: { customerId } });
  expect(open).toHaveLength(1);

  await dynamoDbClient.put('settings', { tenant: customerId, plan: 'pro' });   // deleted again after the test
});
```

### Search Client (Elasticsearch, OpenSearch)

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Catalogue search', () => {
  test('a new product becomes searchable', async ({ searchClient, openApiClient }) => {
    const sku = `sku-${Date.now()}`;
    await (openApiClient.client as any).createProduct(null, { sku, title: 'Trail running shoes' });

    // Indexing is eventually consistent: poll instead of sleeping
    const hit = await searchClient.waitForDocument('products', { term: { sku } });
    expect(hit.source).toMatchObject({ title: 'Trail running shoes' });
  });
});
```

Indices from `searchClient.indexName()` are the test's own and deleted afterwards; writes to other indices are undone.

### Redis Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Redis Cache', () => {
  test('set and get a value', async ({ redisClient }) => {
    await redisClient.set('session:abc', JSON.stringify({ userId: 1 }), 60);

    const value = await redisClient.get('session:abc');
    expect(JSON.parse(value!)).toEqual({ userId: 1 });
  });

  test('pub/sub messaging', async ({ redisClient }) => {
    const messagePromise = redisClient.subscribe('notifications', { timeout: 5000 });
    await redisClient.publish('notifications', 'Hello!');

    const received = await messagePromise;
    expect(received).toBe('Hello!');
  });
});
```

### Neo4j Client

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Social Graph', () => {
  test('create and traverse a relationship', async ({ neo4jClient }) => {
    const counters = await neo4jClient.write(
      'CREATE (:Person {name: $a})-[:KNOWS]->(:Person {name: $b})',
      { a: 'Alice', b: 'Bob' },
    );
    expect(counters.relationshipsCreated).toBe(1);

    const rows = await neo4jClient.run<{ friend: string }>(
      'MATCH (:Person {name: $name})-[:KNOWS]->(f) RETURN f.name AS friend',
      { name: 'Alice' },
    );
    expect(rows).toEqual([{ friend: 'Bob' }]);
  });
});
```

### Cassandra / ScyllaDB Client

```typescript
test('placing an order stores it', async ({ cassandraClient, openApiClient, testData }) => {
  const customerId = testData.unique('customer');
  await (openApiClient.client as any).placeOrder(null, { customerId, sku: 'A-1' });

  // Parameterized CQL; rows as plain objects. Polls until the app has written it.
  const order = await cassandraClient.waitForRow('SELECT * FROM orders WHERE customer_id = ?', [customerId]);
  expect(order).toMatchObject({ status: 'open' });

  await cassandraClient.insert('settings', { tenant: customerId, plan: 'pro' });   // deleted again after the test
});
```

Runs on ScyllaDB (`docker compose -f compose.test.yaml up -d --wait scylla`), Cassandra, or a test cluster.

### OTP Client (2FA/MFA Testing)

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Two-Factor Authentication', () => {
  test('generate and verify TOTP', async ({ otpClient }) => {
    const secret = otpClient.generateSecret();
    const token = await otpClient.generateTotp(secret);

    expect(token).toHaveLength(6);
    expect(await otpClient.verifyTotp(token, secret)).toBe(true);
  });

  test('generate key URI for QR provisioning', async ({ otpClient }) => {
    const secret = otpClient.generateSecret();
    const uri = otpClient.generateKeyUri('user@example.com', 'MyApp', secret);

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('MyApp');
  });
});
```

### Mobile Testing (Appium)

`appiumDriver` is a WebdriverIO `Browser` on an Appium session — local Appium, a grid, a cloud farm, or a GADS device farm (set `appium.gads`):

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Mobile App - Login', () => {
  test('user can log in', async ({ appiumDriver }) => {
    await appiumDriver.url('myapp://login');

    await appiumDriver.$('~email').setValue('user@example.com');
    await appiumDriver.$('~password').setValue('securepass123');
    await appiumDriver.$('~sign-in').click();

    await expect(appiumDriver.$('~welcome').isDisplayed()).resolves.toBe(true);
  });
});
```

### Browser Testing (standard Playwright — unchanged)

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Web App', () => {
  test('loads the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
```

---

## Extending Further — Custom Fixtures

You can layer your own fixtures on top of Propmaster the same way you would with `@playwright/test`:

```typescript
// my-fixtures.ts
import { test as base } from '@inluxc/propmaster';

export const test = base.extend<{ authToken: string }>({
  authToken: async ({ openApiClient }, use) => {
    // Use Propmaster's openApiClient to get a token
    const { client } = openApiClient;
    const res = await (client as any).login(null, {
      email: 'test@example.com',
      password: 'password',
    });
    await use(res.data.token);
  },
});

export { expect } from '@inluxc/propmaster';
```

```typescript
// my-test.spec.ts
import { test, expect } from './my-fixtures';

test('authenticated request', async ({ authToken, page }) => {
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${authToken}` });
  await page.goto('/protected');
  await expect(page).toHaveTitle(/Protected/);
});
```

---

## Configuration

### Environment Variables

All config uses the `PW_` prefix. Set `PW_ENVIRONMENT` to load the matching `.env.{environment}` file:

```bash
PW_ENVIRONMENT=dev npx playwright test
```

| Variable | Purpose |
|----------|---------|
| `PW_ENVIRONMENT` | Active environment (`local`, `dev`, `test`, `stg`, `prod`) |
| `PW_OPENAPI_SPEC_PATH` | Path or URL to OpenAPI spec |
| `PW_OPENAPI_BASE_URL` | API base URL |
| `PW_OPENAPI_VALIDATE_RESPONSES` / `PW_OPENAPI_VALIDATE_REQUESTS` | `true` or `warn`: check calls against the spec |
| `PW_DB_TYPE` | `postgresql`, `mysql`, `mssql`, `sqlite` |
| `PW_DB_HOST` / `PW_DB_PORT` / `PW_DB_NAME` | Database connection |
| `PW_DB_USERNAME` / `PW_DB_PASSWORD` | Database credentials |
| `PW_KAFKA_BROKERS` | Comma-separated broker list |
| `PW_KAFKA_DRIVER` | `kafkajs` (default) or `confluent` (Confluent's librdkafka client) |
| `PW_AMQP_URL` | RabbitMQ / AMQP broker URL (`amqp://user:pass@host:5672/vhost`), or `PW_AMQP_HOST`, `PW_AMQP_PORT`, `PW_AMQP_USERNAME`, `PW_AMQP_PASSWORD`, `PW_AMQP_VHOST` |
| `PW_AWS_ENDPOINT` / `PW_AWS_REGION` / `PW_AWS_S3_BUCKET` | AWS emulator URL (Moto, LocalStack), region and default bucket; credentials from `PW_AWS_ACCESS_KEY_ID`/`PW_AWS_SECRET_ACCESS_KEY`, `PW_AWS_PROFILE` or the standard AWS chain |
| `PW_AWS_DYNAMODB_TABLE_PREFIX` | Root of the per-test table names from `dynamoDbClient.tableName()` (default `propmaster-tests-`) |
| `PW_SEARCH_URL` / `PW_SEARCH_USERNAME` / `PW_SEARCH_PASSWORD` / `PW_SEARCH_API_KEY` | Elasticsearch / OpenSearch cluster |
| `PW_GRPC_ADDRESS` / `PW_GRPC_PROTO_FILES` / `PW_GRPC_AUTH_TOKEN` | gRPC server (`grpcs://` for TLS), its .proto files (leave out for server reflection) and token; TLS files in `PW_GRPC_TLS_CA`/`_CERT`/`_KEY` |
| `PW_REALTIME_URL` / `PW_REALTIME_AUTH_TOKEN` | Base URL for WebSocket and SSE connections (http(s) becomes ws(s)) and bearer token |
| `PW_REDIS_HOST` / `PW_REDIS_PORT` / `PW_REDIS_PASSWORD` | Redis connection |
| `PW_REDIS_KEY_PREFIX` | Key prefix for test isolation |
| `PW_NEO4J_URI` | Neo4j connection URI (`bolt://` or `neo4j://`) |
| `PW_NEO4J_USERNAME` / `PW_NEO4J_PASSWORD` | Neo4j credentials |
| `PW_NEO4J_DATABASE` | Neo4j database (default: server default) |
| `PW_CASSANDRA_CONTACT_POINTS` / `PW_CASSANDRA_LOCAL_DC` / `PW_CASSANDRA_KEYSPACE` | Cassandra / ScyllaDB nodes, data center and keyspace (`PW_CASSANDRA_CREATE_KEYSPACE=true` creates it); `PW_CASSANDRA_USERNAME`/`PW_CASSANDRA_PASSWORD` |
| `PW_APPIUM_SERVER_URL` | Appium server (or GADS hub) URL |
| `PW_APPIUM_PLATFORM` / `PW_APPIUM_UDID` / `PW_APPIUM_DEVICE_NAME` | Device selection |
| `PW_APPIUM_CAPABILITIES` | Extra capabilities as a JSON object |
| `PW_GADS_CLIENT_SECRET` / `PW_GADS_QUEUE_TIMEOUT` | GADS preset: client secret and device queue wait |
| `PW_OTP_SECRET` | Base32-encoded OTP secret |
| `PW_OTP_DIGITS` | Token length (default: 6) |
| `PW_OTP_PERIOD` | TOTP time step in seconds (default: 30) |

### `playwright.config.ts` — works as normal

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: 'https://api.example.com',
  },
  projects: [
    { name: 'api', testMatch: '**/api/**/*.spec.ts' },
    { name: 'browser', testMatch: '**/browser/**/*.spec.ts' },
  ],
});
```

---

## Secrets Management

Set `secrets.provider` in `environments.json` to `aws`, `vault`, `openbao`, `azure`, `gitlab` or `env-file`, and map secret keys to config fields with `keyMappings`. Or use the manager directly:

```typescript
import { SecretsManager, OpenBaoSecretsProvider } from '@inluxc/propmaster';

const manager = new SecretsManager();
// url/token fall back to PW_OPENBAO_* → BAO_* → VAULT_* env vars
manager.registerProvider(new OpenBaoSecretsProvider({ mountPath: 'secret/data/playwright' }));
const dbPassword = await manager.getSecret('db-password', 'openbao');
```

See [docs/secrets.md](docs/secrets.md) for every provider's options.

---

## Generating API Tests

`npx propmaster generate openapi` writes a starting set of tests from your OpenAPI spec: one file per tag in `tests/api/`, a test per operation and documented status code, with TestCaseIDs from `next-id` and `test.step()` blocks. Requests are built from the schema examples. 400 tests send a body without its required fields, and 404 tests use IDs that don't exist. Status codes the generator can't provoke become `test.fixme` with a TODO. It never overwrites a file; run it again after the spec changes to get tests for just the new operations. See [docs/guide/generate-api-tests.md](docs/guide/generate-api-tests.md).

---

## MCP Server for Coding Agents

`npx propmaster mcp` lets a coding agent (Claude Code, VS Code, Cursor, ...) see the backends while it writes or debugs tests. It can query the database, read MongoDB, Redis, Kafka and Neo4j, list the OpenAPI operations, and get the next free TestCaseID. It uses the project's `environments.json` and secrets, is read-only unless you pass `--allow-writes`, refuses production environments, and never shows credentials.

```bash
npx propmaster mcp setup           # writes the config for Claude Code, VS Code, Cursor, Windsurf or Zed (menu)
npx propmaster mcp setup --check   # starts the server as the editor would and lists its tools
```

See [docs/mcp-server.md](docs/mcp-server.md) for every tool and each editor's setup.

---

## Flaky Tests and Quarantine

The Propmaster reporter keeps each test's outcome across CI runs, keyed on its TestCaseID. `npx propmaster flaky` then ranks tests by how often they were flaky or failed. A known-flaky test can be quarantined in `quarantine.json`, with an owner and an issue: it keeps running and reporting, but doesn't fail the build, and `propmaster check` warns when an entry gets old.

```typescript
// playwright.config.ts
reporter: [['list'], ['@inluxc/propmaster/reporter']],   // writes .propmaster/test-history.json; cache it between CI runs
```

See [docs/flaky-tests.md](docs/flaky-tests.md).

---

## Coverage

`npx propmaster coverage` shows what the tests cover per layer of the pyramid (unit, integration, e2e): what each layer's tests touch (API operations, tables, topics, queues, routes, ...), the OpenAPI operations and status codes no test asserts, configured backends no test uses, tests that never ran or fail, and the code-coverage reports already in the project (LCOV, Istanbul, Cobertura, JaCoCo, Clover, OpenCover, Go, coverage.py, SimpleCov). The application can be in any language: its own tests in Python, Go, Java/Kotlin, C#, Ruby, PHP, Rust, Swift or Elixir count too. It reads files only. The MCP server has it as `coverage_report`, so an agent can weigh the gaps against the backends and the code before writing tests.

See [docs/coverage.md](docs/coverage.md).

---

## Running in CI

Integration tests run in GitHub Actions against real services started as containers. Each backend gets its own job, and all jobs run in parallel:

```yaml
test-redis:
  runs-on: ubuntu-latest
  container: node:24
  services:
    redis:
      image: redis:7
      options: --health-cmd "redis-cli ping" --health-interval 5s --health-retries 5
  env:
    CI: true
    PW_REDIS_HOST: redis          # the service name is the hostname
    PW_REDIS_PORT: "6379"
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/npm-install    # cached npm ci
    - run: npx playwright test --project=integration-redis
```

See [docs/ci.md](docs/ci.md) for a job per backend (PostgreSQL, MySQL, MSSQL, SQLite, Redis, MongoDB, Neo4j, Cassandra/ScyllaDB, Kafka, RabbitMQ, AWS, DynamoDB, Elasticsearch, OpenSearch, OpenAPI, GraphQL, gRPC, WebSocket/SSE, OTP, browsers), combining services in one job, and keeping CI fast.

No services to start at all: set `PW_<BACKEND>_CONTAINER=true` and each backend runs in a throwaway container started by the test run itself ([Testcontainers](docs/testcontainers.md)):

```bash
PW_DB_CONTAINER=true PW_KAFKA_CONTAINER=true npx playwright test --project=integration
```

Complete pipelines for other CI systems: [GitLab CI/CD](docs/ci-gitlab.md), [Jenkins](docs/ci-jenkins.md), [Azure Pipelines](docs/ci-azure-pipelines.md), [CircleCI](docs/ci-circleci.md) and [Bitbucket Pipelines](docs/ci-bitbucket.md). For anything else, or to run the same services locally, use [`compose.test.yaml`](compose.test.yaml):

```bash
docker compose -f compose.test.yaml up -d --wait postgres redis
```

---

## Publishing

```bash
npm run build
npm publish
```

## Changelog

What changed, newest first: [CHANGELOG.md](CHANGELOG.md), also on the site at [propmaster.dev/changelog](https://propmaster.dev/changelog).

---

## License

MIT
