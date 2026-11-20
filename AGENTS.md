# AI Agent Instructions — Playwright Framework Template

This document provides AI agents with the context needed to create, modify, and maintain tests in this Playwright framework template. Step-by-step recipes with copyable templates live in [SKILLS.md](SKILLS.md).

## Agent Workflow — Required Checks

These commands give you fast, machine-checkable feedback. Use them instead of checking conventions by hand:

```bash
npm run next-id -- API          # next free TestCaseID in a category, e.g. TC-API-005
npm run next-id -- API 3        # three sequential IDs
npm run lint:tests              # IDs, tags, uniqueness, test.step(), imports (specs + SKILLS.md/AGENTS.md samples)
npm run lint:tests -- --json    # same, as JSON: { ok, violations: [{ file, line, rule, test, message }] }
npm run verify                  # typecheck + lint:tests + unit + property tests — run before finishing any task
```

`lint:tests` exits non-zero on any violation and runs in CI. Each violation names the rule (`tc-id`, `tc-tag`, `tc-unique`, `test-step`, `import`) and the fix.

## Project Overview

A reusable Playwright test framework with an extensible fixture architecture for API, integration, browser, and mobile (Appium) testing. Tests are organized into Playwright projects, each with its own configuration and fixture set.

## Tech Stack

- **Runtime:** Node.js 22.12+
- **Test Framework:** Playwright Test (`@playwright/test ^1.65.1`)
- **Language:** TypeScript 7+
- **Mobile Testing:** Appium via WebdriverIO (`webdriverio ^9.33.1`) — local Appium, grids, cloud farms, and GADS device farms
- **API Testing:** OpenAPI Client Axios (`openapi-client-axios ^7.9.1`)
- **Database:** PostgreSQL (`pg`), MySQL (`mysql2`), MSSQL (`mssql`), SQLite (`better-sqlite3`)
- **Messaging:** KafkaJS (`kafkajs ^2.2.4`)
- **Cache:** ioredis (`ioredis ^6.0.0`)
- **MongoDB:** mongodb (`mongodb ^7.x`)
- **Neo4j:** neo4j-driver (`neo4j-driver ^6.3.2`)
- **GraphQL:** graphql-request (`graphql-request ^7.x`)
- **OTP/2FA:** otplib (`otplib ^13.6.0`)
- **Property Testing:** fast-check (`fast-check ^4.10.3`)
- **Env Loading:** built-in `.env` parser (`src/config/env-loader.ts`), no dependency

Every driver above is an **optional peer dependency** (and a devDependency here, for the self-tests). Propmaster has no runtime dependencies: importing it loads no driver, and each fixture loads its own on first use through `loadOptional()` in `src/fixtures/optional-package.ts`. A missing driver throws `MissingPackageError` with the install command. A new fixture must load its driver the same way (never a top-level value import) and add it to `peerDependencies`, `peerDependenciesMeta` and `FIXTURE_PACKAGES`.

## Project Structure

```
src/
├── index.ts                    # Main exports (test, expect, types, errors)
├── errors.ts                   # Error hierarchy (FrameworkError, FixtureInitError, etc.)
├── config/
│   ├── index.ts                # Config module exports
│   ├── loader.ts               # ConfigLoader — three-tier config resolution
│   ├── env-loader.ts           # EnvLoader — .env file loading
│   └── schema.ts               # TypeScript interfaces for all configs
├── fixtures/
│   ├── index.ts                # Fixture registry — composes all fixtures via test.extend()
│   ├── openapi.fixture.ts      # OpenAPI client fixture
│   ├── database.fixture.ts     # Database client fixture (pg/mysql/sqlite)
│   ├── graphql.fixture.ts      # GraphQL client fixture (queries, mutations, rawRequest)
│   ├── kafka.fixture.ts        # Kafka producer/consumer fixture
│   ├── mongodb.fixture.ts      # MongoDB client fixture (CRUD + aggregation)
│   ├── neo4j.fixture.ts        # Neo4j graph client fixture (Cypher read/write/transactions)
│   ├── redis.fixture.ts        # Redis client fixture
│   ├── otp.fixture.ts          # OTP (TOTP/HOTP) fixture for 2FA/MFA testing
│   └── appium.fixture.ts       # Appium fixture (WebdriverIO) with GADS device-farm preset
├── secrets/
│   ├── index.ts                # Secrets module exports
│   ├── provider.interface.ts   # SecretsProvider interface
│   ├── secrets-manager.ts      # SecretsManager orchestrator
│   └── providers/              # Provider implementations (aws, vault, openbao, gitlab, azure, env-file)
├── steps/                      # Reusable step classes (OpenApiSteps, DatabaseSteps, RedisSteps, ...)
│                               #   each method wraps its work in test.step() — prefer these in specs
├── annotations/                # Fixture-operation annotation recorder (redaction + truncation)
└── cli/                        # `propmaster` CLI: init (scaffolding), organize (sort tests by type),
                                #   check + next-id (test conventions); layout.ts = the scaffolded layout

docs/                           # Fixture guides + VitePress site (published to GitHub Pages)
├── .vitepress/config.mts       # Site nav/sidebar: add new pages here
├── guide/                      # Getting started, configuration, writing tests
└── *-fixture.md, ci*.md, ...   # One page per fixture/topic; ci-<system>.md per CI system

compose.test.yaml               # Every integration-test service with health checks (local runs, any CI)

scripts/
└── check-tests.mjs             # Back-compat wrapper; the checker is src/cli/check-tests.ts (`propmaster check` / `next-id`)

tests/
├── examples/                   # Reference test files for each fixture
│   ├── openapi.spec.ts
│   ├── browser.spec.ts
│   ├── database.spec.ts
│   ├── graphql.spec.ts
│   ├── kafka.spec.ts
│   ├── mongodb.spec.ts
│   ├── neo4j.spec.ts
│   ├── redis.spec.ts
│   ├── otp.spec.ts
│   ├── appium.spec.ts
│   └── gads.spec.ts
├── unit/                       # Framework self-tests (exempt from TestCaseID rules)
└── properties/                 # Framework property tests, *.prop.ts (exempt from TestCaseID rules)
```

## How to Write Tests

### Import Pattern

Always import `test` and `expect` from the framework's main entry point:

```typescript
import { test, expect } from '../../src';
// OR from the fixtures module directly:
import { test, expect } from '../../src/fixtures';
```

**Never** import directly from `@playwright/test` in test files — the framework's `test` object has all fixtures pre-registered.

### Test File Naming

| Project | Pattern | Location |
|---------|---------|----------|
| OpenAPI | `*.spec.ts` | `tests/examples/` or custom dir |
| GraphQL | `*.spec.ts` | `tests/examples/` or custom dir |
| Database | `*.spec.ts` | `tests/examples/` or custom dir |
| MongoDB | `*.spec.ts` | `tests/examples/` or custom dir |
| Neo4j | `*.spec.ts` | `tests/examples/` or custom dir |
| Kafka | `*.spec.ts` | `tests/examples/` or custom dir |
| Redis | `*.spec.ts` | `tests/examples/` or custom dir |
| Appium (incl. GADS) | `*.spec.ts` | `tests/examples/` or custom dir |
| Browser | `*.spec.ts` | `tests/examples/` or custom dir |
| Property | `*.prop.ts` | `tests/properties/` |

### Available Fixtures

Request fixtures by name in the test function signature:

| Fixture Name | Type | Description |
|---|---|---|
| `openApiClient` | `OpenApiClient` | Typed HTTP client from OpenAPI spec (`{ client, api }`) |
| `graphqlClient` | `GraphQLClient` | GraphQL client with `query`, `mutate`, `rawRequest`, `setAuthToken` |
| `databaseClient` | `DatabaseClient` | DB client with `query<T>(sql, params?)` and `execute(sql, params?)` |
| `mongoDbClient` | `MongoDbClient` | MongoDB with `find`, `findOne`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `aggregate` |
| `neo4jClient` | `Neo4jClient` | Neo4j with `run<T>(cypher, params?)`, `write(cypher, params?)`, `executeInTransaction(fn)`, `close()` |
| `kafkaClient` | `KafkaClient` | Kafka with `produce(topic, messages)` and `consume(topic, options?)` |
| `redisClient` | `RedisClient` | Redis with `get`, `set`, `del`, `publish`, `subscribe` |
| `otpClient` | `OtpClient` | OTP with `generateTotp`, `verifyTotp`, `generateHotp`, `verifyHotp`, `generateSecret`, `generateKeyUri` |
| `appiumDriver` | `AppiumDriver` (WebdriverIO `Browser`) | Appium session — `$('~id')`, `execute('mobile: ...')`, `takeScreenshot`, full WebdriverIO API; session deleted (device freed) on teardown. Works with local Appium, grids, cloud farms, and GADS (`appium.gads`) |
| `gadsHub` | `GadsHubClient` | GADS hub status and device listing (`status`, `listDevices`) — reserves nothing; needs `appium.gads` |

### Test Structure Pattern

```typescript
import { test, expect } from '../../src';

test.describe('Feature Name', () => {
    test('[TC-XXX-001] descriptive test name', { tag: ['@TC-XXX-001'] }, async ({ fixtureName }) => {
        await test.step('Step 1: Set up test data', async () => {
            // Arrange — set up test data
        });

        await test.step('Step 2: Perform the operation', async () => {
            // Act — perform the operation
        });

        await test.step('Step 3: Verify the result', async () => {
            // Assert — verify the result with expect()
        });
    });

    test('[TC-XXX-002] another test case', { tag: ['@TC-XXX-002'] }, async ({ fixtureName }) => {
        await test.step('Step 1: Prepare preconditions', async () => {
            // ...
        });

        await test.step('Step 2: Execute action', async () => {
            // ...
        });

        await test.step('Step 3: Assert expected outcome', async () => {
            // ...
        });
    });
});
```

> **Note:** Every test must include a unique `[TC-XXX-NNN]` at the start of the title, and a `{ tag: ['@TC-XXX-NNN'] }` options object as the second argument. Every test must use `test.step()` to break down the test into trackable steps. See "Test Case ID Convention" section for details.

### Fixture API Quick Reference

**OpenAPI Client:**
```typescript
const { client, api } = openApiClient;
const response = await (client as any).operationId(pathParams, body);
expect(response.status).toBe(200);
```

**Database Client:**
```typescript
// SELECT — returns typed rows
const rows = await databaseClient.query<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE active = $1', [true]
);
// INSERT/UPDATE/DELETE — returns { affectedRows: number }
const result = await databaseClient.execute(
    'INSERT INTO users (name) VALUES ($1)', ['Alice']
);
```

**Kafka Client:**
```typescript
await kafkaClient.produce('topic', [{ key: 'k', value: JSON.stringify(data) }]);
const messages = await kafkaClient.consume('topic', { count: 1, timeout: 10000, fromBeginning: true });
```

**Redis Client:**
```typescript
await redisClient.set('key', 'value', 60); // TTL in seconds (optional)
const val = await redisClient.get('key');   // returns string | null
await redisClient.del('key');               // returns number of keys removed
await redisClient.publish('channel', 'msg');
const msg = await redisClient.subscribe('channel', { timeout: 5000 });
```

**Appium (WebdriverIO):**
```typescript
// appiumDriver is a WebdriverIO Browser; assert with Playwright's expect
await appiumDriver.url('myapp://login');                                  // deep link
await appiumDriver.$('~email').setValue('a@b.com');                       // ~ = accessibility id
await appiumDriver.$('~login').click();
const title = appiumDriver.$('~welcome-title');
await title.waitForDisplayed({ timeout: 15_000 });
expect(await title.getText()).toContain('Welcome');
await appiumDriver.execute('mobile: activateApp', { bundleId: 'com.example.app', appId: 'com.example.app' });
await appiumDriver.execute('mobile: swipe', { direction: 'up' });       // any Appium `mobile:` command
const png = Buffer.from(await appiumDriver.takeScreenshot(), 'base64');
if (appiumDriver.isIOS) { /* platform branch */ }
// Other selectors: 'id=...', '//xpath', 'android=new UiSelector()...', '-ios predicate string:...', '-ios class chain:...'
```

**MongoDB Client:**
```typescript
// Find documents with options (limit, skip, sort, projection)
const users = await mongoDbClient.find<{ name: string }>('users', { active: true }, { limit: 10, sort: { name: 1 } });

// Find a single document (returns T | null)
const user = await mongoDbClient.findOne<{ name: string }>('users', { email: 'a@b.com' });

// Insert one — returns { insertedId, acknowledged }
const result = await mongoDbClient.insertOne('users', { name: 'Alice', active: true });

// Insert many — returns { insertedIds, insertedCount, acknowledged }
await mongoDbClient.insertMany('users', [{ name: 'A' }, { name: 'B' }]);

// Update — returns { matchedCount, modifiedCount, upsertedId, acknowledged }
await mongoDbClient.updateOne('users', { name: 'Alice' }, { $set: { active: false } });
await mongoDbClient.updateMany('users', { active: false }, { $set: { archived: true } });

// Delete — returns { deletedCount, acknowledged }
await mongoDbClient.deleteOne('users', { name: 'Alice' });
await mongoDbClient.deleteMany('users', { archived: true });

// Aggregation pipeline
const stats = await mongoDbClient.aggregate<{ _id: boolean; count: number }>(
    'users', [{ $group: { _id: '$active', count: { $sum: 1 } } }]
);
```

**Neo4j Client:**
```typescript
// Write — returns { nodesCreated, relationshipsCreated, propertiesSet, nodesDeleted, relationshipsDeleted }
const counters = await neo4jClient.write(
    'CREATE (:Person {name: $name, runId: $runId})', { name: 'Alice', runId }
);

// Read — returns record.toObject() rows; Neo4j Integers come back as JS numbers
const rows = await neo4jClient.run<{ name: string; total: number }>(
    'MATCH (p:Person {runId: $runId}) RETURN p.name AS name, count(*) AS total', { runId }
);

// Transaction — committed when the callback resolves, rolled back if it throws
await neo4jClient.executeInTransaction(async (tx) => {
    await tx.run('CREATE (:Order {id: $id})', { id: 'ORD-1' });
    await tx.run('MATCH (o:Order {id: $id}) CREATE (o)-[:CONTAINS]->(:Item)', { id: 'ORD-1' });
});

// Cleanup — tag test nodes with a unique run ID and detach-delete them in afterEach
await neo4jClient.write('MATCH (n {runId: $runId}) DETACH DELETE n', { runId });
```

**GADS (device farm preset):**
```typescript
// Same appiumDriver; config adds `gads` (PW_APPIUM_SERVER_URL=http://hub:10000 + PW_GADS_CLIENT_SECRET).
// The hub allocates a device by platform / udid / deviceName regex and frees it on teardown.
import { gadsSessionInfo } from '../../src';
const { udid, name, provider, controlUrl } = gadsSessionInfo(appiumDriver);

// gadsHub lists devices without reserving one
const free = (await gadsHub.listDevices({ platform: 'android' })).filter((d) => d.available);
```

**GraphQL Client:**
```typescript
// Query — returns typed data directly
const data = await graphqlClient.query<{ users: Array<{ id: string; name: string }> }>(`
    query { users { id name } }
`);

// Query with variables
const user = await graphqlClient.query<{ user: { id: string } }>(
    `query GetUser($id: ID!) { user(id: $id) { id name } }`,
    { id: '123' }
);

// Mutation
const created = await graphqlClient.mutate<{ createUser: { id: string } }>(
    `mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }`,
    { input: { name: 'Alice', email: 'alice@example.com' } }
);

// Raw request — returns { data, errors } (useful for testing error scenarios)
const response = await graphqlClient.rawRequest<{ user: null }>(`{ user(id: "bad") { id } }`);
expect(response.errors).toBeDefined();

// Dynamic auth and headers
graphqlClient.setAuthToken('bearer-token');
graphqlClient.setHeader('X-Custom', 'value');
await graphqlClient.query(`{ me { email } }`, undefined, { headers: { 'X-Request-ID': '123' } });
```

**OTP Client:**
```typescript
// Generate a new base32 secret
const secret = otpClient.generateSecret();

// TOTP — time-based one-time password
const token = await otpClient.generateTotp(secret);
const isValid = await otpClient.verifyTotp(token, secret);

// HOTP — counter-based one-time password
const hotpToken = await otpClient.generateHotp(0, secret);  // counter = 0
const hotpValid = await otpClient.verifyHotp(hotpToken, 0, secret);

// Generate otpauth:// URI for QR code provisioning
const uri = otpClient.generateKeyUri('user@example.com', 'MyApp', secret);
```

## Configuration System

### Three-Tier Precedence (highest → lowest)

1. **Project `use` block** in `playwright.config.ts`
2. **Environment variables** (`PW_*` prefix)
3. **`.env.{environment}` file**
4. **`environments.json`** file

Set active environment: `PW_ENVIRONMENT=dev`

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `PW_ENVIRONMENT` | Active environment (`local`, `dev`, `test`, `stg`, `prod`) |
| `PW_OPENAPI_SPEC_PATH` | OpenAPI spec path/URL |
| `PW_OPENAPI_BASE_URL` | API base URL |
| `PW_DB_TYPE` | `postgresql`, `mysql`, `mssql`, `sqlite` |
| `PW_DB_HOST`, `PW_DB_PORT`, `PW_DB_NAME` | Database connection |
| `PW_DB_USERNAME`, `PW_DB_PASSWORD` | Database credentials |
| `PW_KAFKA_BROKERS` | Comma-separated broker list |
| `PW_REDIS_HOST`, `PW_REDIS_PORT`, `PW_REDIS_PASSWORD` | Redis connection |
| `PW_REDIS_KEY_PREFIX` | Test key prefix for isolation |
| `PW_MONGODB_URI` | Full MongoDB connection URI (overrides host/port) |
| `PW_MONGODB_HOST`, `PW_MONGODB_PORT`, `PW_MONGODB_DATABASE` | MongoDB connection |
| `PW_MONGODB_USERNAME`, `PW_MONGODB_PASSWORD` | MongoDB credentials |
| `PW_NEO4J_URI` | Neo4j URI (`bolt://host:7687` or `neo4j://host:7687`) |
| `PW_NEO4J_USERNAME`, `PW_NEO4J_PASSWORD` | Neo4j credentials |
| `PW_NEO4J_DATABASE` | Neo4j database (optional; server default) |
| `PW_GRAPHQL_ENDPOINT` | GraphQL endpoint URL |
| `PW_GRAPHQL_AUTH_TOKEN` | Bearer token for GraphQL authorization |
| `PW_APPIUM_SERVER_URL` | Appium server URL (`http://127.0.0.1:4723`), grid/cloud URL, or GADS hub URL |
| `PW_APPIUM_PLATFORM` | `ios` or `android` (sets `platformName` and default automation engine) |
| `PW_APPIUM_UDID`, `PW_APPIUM_DEVICE_NAME` | Device selection (GADS: device name is a regex resolved to a UDID) |
| `PW_APPIUM_PLATFORM_VERSION`, `PW_APPIUM_AUTOMATION_NAME`, `PW_APPIUM_APP` | OS version, Appium engine, app to install |
| `PW_APPIUM_CAPABILITIES` | Extra capabilities as a JSON object |
| `PW_APPIUM_NEW_COMMAND_TIMEOUT`, `PW_APPIUM_SESSION_TIMEOUT` | Idle timeout (s), session-create timeout (ms) |
| `PW_GADS_CLIENT_SECRET` | Enables the GADS preset; client secret from GADS Admin → Client credentials |
| `PW_GADS_QUEUE_TIMEOUT` | GADS: seconds to wait for a free device |
| `PW_OTP_SECRET` | Base32-encoded OTP secret |
| `PW_OTP_DIGITS` | Token length (default: 6) |
| `PW_OTP_PERIOD` | TOTP time step in seconds (default: 30) |
| `PW_OTP_ALGORITHM` | Hash algorithm: `sha1`, `sha256`, `sha512` |
| `PW_OTP_ISSUER` | Issuer name for URI generation |
| `PW_OPENBAO_ADDR`, `PW_OPENBAO_TOKEN`, `PW_OPENBAO_NAMESPACE` | OpenBao secrets provider (`secrets.provider: "openbao"`); fall back to `BAO_*`, then `VAULT_*` |
| `PW_OPENBAO_MOUNT_PATH`, `PW_OPENBAO_KV_VERSION` | OpenBao KV path prefix (include `data` for KV v2) and engine version |
| `PW_OPENBAO_AUTH_METHOD`, `PW_OPENBAO_ROLE_ID`, `PW_OPENBAO_SECRET_ID`, `PW_OPENBAO_AUTH_ROLE`, `PW_OPENBAO_JWT_PATH` | OpenBao auth: `token`, `approle`, `kubernetes`, `jwt` |
| `PW_OPENBAO_CACERT`, `PW_OPENBAO_CLIENT_CERT`, `PW_OPENBAO_CLIENT_KEY`, `PW_OPENBAO_SKIP_VERIFY` | OpenBao TLS (also `BAO_*`; see [docs/secrets.md](docs/secrets.md#openbao)) |
| `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_NAMESPACE`, ... | HashiCorp Vault secrets provider (`secrets.provider: "vault"`); same names as OpenBao with the `VAULT_` prefix |

## Playwright Projects

Tests are matched to projects via `testMatch` patterns in `playwright.config.ts`:

| Project | testMatch | Fixtures Available |
|---|---|---|
| `openapi` | `**/examples/openapi.spec.ts` | `openApiClient` |
| `appium-android` | `**/examples/appium.spec.ts` | `appiumDriver` (local Appium, platform android) |
| `appium-ios` | `**/examples/appium.spec.ts` | `appiumDriver` (local Appium, platform ios) |
| `gads` | `**/examples/gads.spec.ts` | `appiumDriver`, `gadsHub` (GADS preset; 5-minute test timeout for device queueing) |
| `browser-chromium` | `**/examples/browser.spec.ts` | Standard Playwright `page` |
| `browser-firefox` | `**/examples/browser.spec.ts` | Standard Playwright `page` |
| `browser-webkit` | `**/examples/browser.spec.ts` | Standard Playwright `page` |
| `api-integration` | `**/examples/{database,kafka,redis,mongodb,neo4j}.spec.ts` | `databaseClient`, `kafkaClient`, `redisClient`, `mongoDbClient`, `neo4jClient` |
| `integration-database` | `**/examples/database.spec.ts` | `databaseClient` |
| `integration-kafka` | `**/examples/kafka.spec.ts` | `kafkaClient` |
| `integration-redis` | `**/examples/redis.spec.ts` | `redisClient` |
| `integration-mongodb` | `**/examples/mongodb.spec.ts` | `mongoDbClient` |
| `integration-neo4j` | `**/examples/neo4j.spec.ts` | `neo4jClient` |
| `otp` | `**/examples/otp.spec.ts` | `otpClient` |
| `property-tests` | `**/*.prop.ts` | None (uses fast-check) |
| `unit-tests` | `**/unit/**/*.spec.ts` | None (framework self-tests) |

## Error Handling

Use framework error classes for consistent diagnostics:

```typescript
import { FixtureInitError, FixtureOperationError } from '../../src';

// Setup/connection failures
throw new FixtureInitError('myFixture', 'connect', { host, port, reason: 'Connection refused' });

// Runtime operation failures
throw new FixtureOperationError('myFixture', 'query', { operation: 'fetchData', reason: error.message });
```

Error hierarchy: `FrameworkError` → `ConfigurationError`, `FixtureInitError`, `FixtureOperationError`, `SecretsError`, `DependencyError`, `MissingPackageError` (a fixture's driver isn't installed).

## Running Tests

```bash
npm test                                          # All tests
npx playwright test --project=openapi             # Single project
npx playwright test --project=api-integration     # Integration tests
npx playwright test --project=property-tests      # Property tests
npx playwright test --project=otp                 # OTP fixture (no service needed)
npx playwright test --project=unit-tests          # Framework unit tests
npm run test:tag -- @smoke                        # By tag
PW_ENVIRONMENT=dev npx playwright test            # Specific environment
npm run typecheck                                 # Type checking only
npm run lint:tests                                # Test conventions (IDs, tags, steps, imports)
npm run verify                                    # typecheck + lint:tests + unit + property tests
```

### Running in CI

`.github/workflows/integration-tests.yml` runs one job per backend, each with the service as a container and every job in parallel. When you add a fixture or a Playwright project that needs a service, add a matching job. [docs/ci.md](docs/ci.md) has a template for every backend. In short:

- Use `container: node:24` and the service name as the host (`PW_REDIS_HOST: redis`), never `localhost`.
- Give the service a `--health-cmd` so tests start only once it is ready.
- Set `CI: true`: the example specs skip themselves without it.
- Install with `uses: ./.github/actions/npm-install` (cached `npm ci`).
- Upload reports with `if: failure()`, and don't add `needs:` between jobs.
- Browser jobs run in `mcr.microsoft.com/playwright:v<@playwright/test version>-noble`; `typecheck` fails if the tag drifts.

To run integration tests locally, start the services with `docker compose -f compose.test.yaml up -d --wait <service>` and use `localhost` (variables per backend: [docs/ci-docker-compose.md](docs/ci-docker-compose.md)). Pipelines for GitLab, Jenkins, Azure Pipelines, CircleCI and Bitbucket are in `docs/ci-*.md`.

## Creating Custom Fixtures

1. Create `src/fixtures/my-custom.fixture.ts` with setup/use/teardown pattern
2. Register in `src/fixtures/index.ts` by importing and spreading
3. Use in tests by requesting the fixture name as a parameter

Pattern:
```typescript
export const myFixture = {
    myClient: async ({}, use: (client: MyClient) => Promise<void>) => {
        const client = await MyClient.connect(config);  // Setup
        await use(client);                               // Provide to test
        await client.disconnect();                       // Teardown
    },
};
```

## Test Case ID Convention

Every generated test **must** include a unique TestCaseID in both the test title and the tags. This ensures traceability and prevents duplicate identifiers across the entire test suite.

### Format

- **Pattern:** `TC-XXX-NNN` where `XXX` is a short category code and `NNN` is a zero-padded sequential number.
- **Category codes:** `API`, `DB`, `KFK`, `RDS`, `MDB`, `NEO`, `GQL`, `BRW`, `APM` (Appium), `GDS` (GADS), `OTP`, `INT`, `PROP`, or a custom short code for new domains. `MOB` is retired: the Mobilewright tests that used it were removed, so do not reuse it.
- **Placement:** The TestCaseID appears in square brackets at the beginning of the test title AND as a tag.

### Rules

1. **Uniqueness:** Each TestCaseID must be globally unique across ALL spec files in the project. Get IDs from `npm run next-id -- <CATEGORY>`; `npm run lint:tests` rejects duplicates.
2. **Title format:** `test('[TC-XXX-NNN] descriptive test name', { tag: ['@TC-XXX-NNN'] }, async ...)`
3. **Tag format:** Use Playwright's `{ tag: ['@TC-XXX-NNN'] }` options object as the second argument to `test()`.
4. **Sequential numbering:** Numbers increment within each category (e.g., `TC-API-001`, `TC-API-002`, ...).
5. **No reuse:** Never reuse a TestCaseID, even if the original test is deleted.
6. **Test steps are mandatory:** Every test must use `test.step()` to break the test body into discrete, labeled steps. Steps appear in Playwright reports and traces, enabling precise failure tracking.

### Test Steps

Every test body **must** be structured using `await test.step('Step N: description', async () => { ... })`. This provides:

- **Traceability:** Each step is visible in the HTML report, trace viewer, and CI logs.
- **Failure pinpointing:** When a test fails, the report shows exactly which step failed.
- **Documentation:** Steps serve as living documentation of the test procedure.

**Step naming convention:** `Step N: <verb phrase>` — use a clear action verb (e.g., "Navigate to login page", "Submit form with valid data", "Verify success message is displayed").

### Examples

```typescript
test.describe('API — Users — Positive', () => {
    test('[TC-API-001] GET /users — list all users returns 200', { tag: ['@TC-API-001'] }, async ({ openApiClient }) => {
        await test.step('Step 1: Send GET request to /users', async () => {
            const { client } = openApiClient;
            const response = await (client as any).listUsers();
            expect(response.status).toBe(200);
        });

        await test.step('Step 2: Verify response contains array of users', async () => {
            const { client } = openApiClient;
            const response = await (client as any).listUsers();
            expect(response.data).toBeInstanceOf(Array);
            expect(response.data.length).toBeGreaterThan(0);
        });
    });

    test('[TC-API-002] POST /users — create user with valid body returns 201', { tag: ['@TC-API-002'] }, async ({ openApiClient }) => {
        const { client } = openApiClient;
        let createdId: string;

        await test.step('Step 1: Send POST request with valid user data', async () => {
            const response = await (client as any).createUser(null, {
                name: 'Alice',
                email: 'alice@example.com',
            });
            expect(response.status).toBe(201);
            createdId = response.data.id;
        });

        await test.step('Step 2: Verify response contains created user with ID', async () => {
            expect(createdId).toBeDefined();
        });
    });
});

test.describe('Database — Orders', () => {
    test('[TC-DB-001] query active orders returns results', { tag: ['@TC-DB-001'] }, async ({ databaseClient }) => {
        await test.step('Step 1: Execute SELECT query for active orders', async () => {
            const rows = await databaseClient.query<{ id: number; status: string }>(
                'SELECT id, status FROM orders WHERE status = $1', ['active']
            );
            expect(rows.length).toBeGreaterThan(0);
        });

        await test.step('Step 2: Verify all returned rows have active status', async () => {
            const rows = await databaseClient.query<{ id: number; status: string }>(
                'SELECT id, status FROM orders WHERE status = $1', ['active']
            );
            for (const row of rows) {
                expect(row.status).toBe('active');
            }
        });
    });
});

test.describe('Browser — Login — Functional', () => {
    test('[TC-BRW-001] navigate to login and submit form', { tag: ['@TC-BRW-001'] }, async ({ page }) => {
        await test.step('Step 1: Navigate to login page', async () => {
            await page.goto('/login');
            await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
        });

        await test.step('Step 2: Fill in credentials', async () => {
            await page.getByLabel('Email').fill('user@example.com');
            await page.getByLabel('Password').fill('secret123');
        });

        await test.step('Step 3: Submit the form', async () => {
            await page.getByRole('button', { name: 'Sign In' }).click();
        });

        await test.step('Step 4: Verify redirect to dashboard', async () => {
            await expect(page).toHaveURL('/dashboard');
            await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
        });
    });
});
```

### How to Determine the Next ID

Don't grep by hand. Ask the checker, which scans every `*.spec.ts` and `*.prop.ts` file:

```bash
npm run next-id -- API        # → TC-API-005
npm run next-id -- BRW 7      # → seven sequential IDs, e.g. for a parameterized viewport test
npm run lint:tests -- --list-ids  # every ID in use, with file:line
```

For parameterized tests (generated in a loop), put an ID in each data row and build the title and tag from it:
``test(`[${c.id}] ...`, { tag: [`@${c.id}`] }, async () => { ... })``.

`next-id` only sees IDs that are still in the code. Never renumber or reuse the ID of a deleted test.

---

## Conventions

- Use `test.describe()` to group related tests
- Use `test.skip()` at describe level for tests requiring unavailable infrastructure
- Use parameterized queries (never string interpolation) for SQL
- Prefer `expect()` assertions from Playwright's built-in expect
- Keep test files focused on a single fixture or feature
- Use JSDoc comments with `@requirements` tags when applicable
- Property tests use `fast-check` and follow `*.prop.ts` naming
- **Every test must have a unique TestCaseID** — see "Test Case ID Convention" above
- **Every test must use `test.step()`** — break the test body into labeled steps for traceability in reports and traces
- **Assert expected failures explicitly** — for OpenAPI calls expected to return non-2xx, pass `{ validateStatus: () => true }` as the 3rd argument and assert `response.status`. Never use `try { call } catch { expect(...) }`, which passes silently if the call succeeds
- **Run `npm run verify` before finishing** — it is what CI runs
