# ClickHouse Fixture

`clickHouseClient` runs SQL against ClickHouse over its HTTP interface, the same way `databaseClient` runs SQL against PostgreSQL or MySQL. Use it to check the events and aggregates a backend wrote, to seed the rows a test needs, and to wait for rows an asynchronous pipeline (Kafka engine, materialized views, a batch loader) delivers. Values are always bound as typed parameters (`{name:Type}`), never built from strings.

---

## What It Does

- **`query()` returns plain objects:** `Int64`, `UInt64` and the wider integers come back as numbers, so `count()` compares with `toBe(3)`. Values beyond 2^53 come back as a JS `bigint`, never rounded. Arrays stay arrays and maps objects. Dates and DateTimes stay as ClickHouse writes them (`'2026-01-01 10:00:00'`).
- **`execute()`** runs anything else (DDL, `ALTER`, `INSERT ... SELECT`) and reports how many rows it wrote.
- **`insert()` is undone after the test:** the rows go in as `JSONEachRow` and are deleted again afterwards, picked out by `key`, else `id`, else every column the row sets. Dates are accepted as JS `Date` objects or any format ClickHouse can parse (`date_time_input_format=best_effort`), and `bigint` values go in exact.
- **Waiting:** `waitForRows()` and `waitForRow()` poll until the application has written what the test expects (and `until` passes). They fail with what is there instead.
- **Databases:**
  - `createDatabase()` makes one of the test's own, dropped afterwards. Rows in it need no undo.
  - With `createDatabase: true`, the configured database is created when it's missing, for local runs and containers. It's never dropped.
- **Readable failures:** an error names the statement, its parameters and ClickHouse's reason with its error type (`UNKNOWN_TABLE`, `BAD_QUERY_PARAMETER`, ...), without the server's stack trace.

---

## Setup

### Install

```bash
npm install --save-dev @clickhouse/client
```

[`@clickhouse/client`](https://github.com/ClickHouse/clickhouse-js) is ClickHouse's official Node.js client. It speaks HTTP, so it works with self-hosted ClickHouse and ClickHouse Cloud alike.

Then pick where the tests run:

```bash
# ClickHouse from the repo's compose file
docker compose -f compose.test.yaml up -d --wait clickhouse
PW_CLICKHOUSE_USERNAME=testuser PW_CLICKHOUSE_PASSWORD=testpass \
PW_CLICKHOUSE_DATABASE=analytics PW_CLICKHOUSE_CREATE_DATABASE=true npx playwright test

# Or let the test run start ClickHouse (needs Docker and testcontainers); the database is created
PW_CLICKHOUSE_CONTAINER=true PW_CLICKHOUSE_DATABASE=analytics npx playwright test

# Or a shared test server
PW_CLICKHOUSE_URL=https://clickhouse.test.example.com:8443 PW_CLICKHOUSE_DATABASE=analytics \
PW_CLICKHOUSE_USERNAME=tests PW_CLICKHOUSE_PASSWORD=... npx playwright test
```

`npx propmaster fixture add clickhouse` adds the package, the config block, the variables, the compose service and a starter test.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_CLICKHOUSE_URL` | HTTP(S) URL of the server | `http://localhost:8123` |
| `PW_CLICKHOUSE_USERNAME`, `PW_CLICKHOUSE_PASSWORD` | Credentials | `default`, no password |
| `PW_CLICKHOUSE_DATABASE` | Database for unqualified table names | `default` |
| `PW_CLICKHOUSE_CREATE_DATABASE` | `true` creates that database when it's missing | off (on with a container) |
| `PW_CLICKHOUSE_TIMEOUT` | Default wait for `waitForRows()`, in ms | `10000` |
| `PW_CLICKHOUSE_CONTAINER` | `true` starts ClickHouse in a container; an image name picks another version | off |

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "clickhouse": { "url": "http://localhost:8123", "database": "analytics", "createDatabase": true }
        },
        "dev": {
            "clickhouse": {
                "url": "https://clickhouse.dev.example.com:8443",
                "database": "analytics",
                "username": "tests",
                "settings": { "join_use_nulls": 1 }
            }
        }
    }
}
```

The password can come from a [secrets provider](./secrets): map it to `clickhouse.password`.

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import { ConfigLoader } from '@inluxc/propmaster';

const config = new ConfigLoader().load();

export default defineConfig({
    projects: [
        {
            name: 'integration',
            testDir: './tests/integration',
            use: { clickhouse: config.clickhouse, openapi: config.openapi },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `url` | `string` | `http://localhost:8123` | Credentials in the URL are taken out of it |
| `username`, `password` | `string` | `default`, empty | |
| `database` | `string` | `default` | |
| `createDatabase` | `boolean` | `false` | |
| `settings` | `Record<string, unknown>` | — | ClickHouse settings for every statement |
| `timeout` | `number` | `10000` | ms |
| `requestTimeout` | `number` | the driver's (`30000`) | ms |
| `container` | `boolean \| ContainerOptions` | off | See [Testcontainers](./testcontainers) |

---

## Usage

### Check what the application stored

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-CH-001] a purchase is recorded as an event', { tag: ['@TC-CH-001'] }, async ({ clickHouseClient, openApiClient, testData }) => {
    const userId = testData.unique('user');

    await test.step('Step 1: Buy through the API', async () => {
        await (openApiClient.client as any).createOrder(null, { userId, sku: 'SKU-1', qty: 2 });
    });

    await test.step('Step 2: Verify the event reached ClickHouse', async () => {
        const event = await clickHouseClient.waitForRow<{ kind: string; qty: number }>(
            'SELECT kind, qty FROM events WHERE user_id = {user:String}',
            { user: userId },
            { timeout: 30_000 },
        );
        expect(event).toEqual({ kind: 'purchase', qty: 2 });
    });
});
```

Match on a value unique to the test (`testData.unique()`): other tests and the application write to the same tables.

### Parameters and values

Placeholders are `{name:Type}`, with the values in an object by name. The type is ClickHouse's: `String`, `UInt64`, `DateTime64(3)`, `Array(String)`, ...

```typescript
await clickHouseClient.query(
    'SELECT * FROM events WHERE user_id = {user:String} AND at >= {since:DateTime64(3)} AND kind IN {kinds:Array(String)}',
    { user: userId, since: new Date(Date.now() - 60_000), kinds: ['view', 'purchase'] },
);
```

| ClickHouse | In rows | In parameters and inserts |
|---|---|---|
| `Int8`…`Int32`, `UInt8`…`UInt32`, `Float*`, `Decimal*` | `number` | `number` |
| `Int64`, `UInt64`, `Int128`, ... | `number`, or `bigint` beyond 2^53 | `number`, `bigint` or a decimal string |
| `String`, `LowCardinality(String)`, `UUID`, `Enum` | `string` | `string` |
| `Date`, `DateTime`, `DateTime64` | `string` (`'2026-01-01 10:00:00.000'`) | `Date`, or a string |
| `Array(T)`, `Map(K, V)`, `Tuple` | array, object, array | the same |
| `Nullable(T)` | `T` or `null` | `T` or `null` |

`{ raw: true }` gives the rows exactly as the server writes them, and `{ settings: { ... } }` adds settings to one statement, for example `{ final: 1 }` to read a `ReplacingMergeTree` after deduplication.

### Seed data, deleted afterwards

```typescript
await clickHouseClient.insert('events', [
    { id: testData.unique('ev'), user_id: userId, kind: 'view', at: new Date(), amount: 1 },
    { id: testData.unique('ev'), user_id: userId, kind: 'purchase', at: new Date(), amount: 30 },
]);
await clickHouseClient.insert('daily_totals', row, { key: ['user_id', 'day'] }); // what picks the rows out afterwards
await clickHouseClient.insert('dim_countries', countries, { keep: true });       // leave in place
```

After the test, each row is deleted with a lightweight `DELETE` (a synchronous mutation on `Memory` tables), picked out by:

1. `key`, when given;
2. else `id`, when the row has one and the table has that column;
3. else every column the row sets, except floats, maps, JSON and aggregate states, which `=` can't match reliably.

ClickHouse has no unique keys, so a row the application wrote with the same values is deleted too: give seeded rows a unique `id` (`testData.unique()`). Tables with engines that can't delete rows (`Log`, `TinyLog`, `StripeLog`, `Distributed`, ...) are refused before anything is written: pass `{ keep: true }`, or use a table in `createDatabase()`.

### Wait for rows the application writes

ClickHouse pipelines are often asynchronous: a Kafka engine table, a materialized view, `async_insert`, a loader that batches. Don't query once or sleep; poll:

```typescript
const rows = await clickHouseClient.waitForRows('SELECT * FROM events WHERE order_id = {id:String}', { id: orderId }, { count: 3 });
const total = await clickHouseClient.waitForRow<{ revenue: number }>(
    'SELECT sum(amount) AS revenue FROM events WHERE user_id = {user:String}',
    { user: userId },
    { until: (r) => r.revenue === 30, timeout: 30_000 },
);
expect(await clickHouseClient.count('events', { user_id: userId })).toBe(3);
```

On timeout the error shows the rows that are there, or how many there were.

### Databases and tables for local runs

```typescript
// A database of the test's own: dropped after the test, so its rows need no undo
const db = await clickHouseClient.createDatabase();             // propmaster_t0_9f2a1c0b
await clickHouseClient.execute(`CREATE TABLE ${db}.scratch (id UInt64, v String) ENGINE = MergeTree ORDER BY id`);
await clickHouseClient.insert(`${db}.scratch`, { id: 1, v: 'a' });

// The application's schema, once (kept)
await clickHouseClient.execute(`CREATE TABLE IF NOT EXISTS events (...) ENGINE = MergeTree ORDER BY (user_id, at)`);
await clickHouseClient.columns('events');                       // [{ name: 'id', type: 'String' }, ...]
```

Table names are `table` (in the configured database) or `database.table`.

### With the Steps class

```typescript
import { ClickHouseSteps } from '@inluxc/propmaster/steps';

const clickhouse = new ClickHouseSteps(clickHouseClient);
await clickhouse.insert('Seed a view', 'events', { id: testData.unique('ev'), user_id: userId, kind: 'view', at: new Date() });
await clickhouse.expectRow('Verify the purchase is recorded', 'SELECT * FROM events WHERE user_id = {user:String} AND kind = \'purchase\'', { user: userId }, { amount: 30 });
await clickhouse.expectRows('Verify three events', 'SELECT * FROM events WHERE user_id = {user:String}', { user: userId }, { count: 3 });
await clickhouse.expectCount('Verify one purchase', 'events', 1, { user_id: userId, kind: 'purchase' });
await clickhouse.expectNoRows('Verify nothing for another user', 'SELECT * FROM events WHERE user_id = {user:String}', { user: 'nobody' });
```

`expectRow()` keeps waiting until the row matches (`toMatchObject`), and on timeout shows the difference.

### Outside a test

`createClickHouseClient(config)` gives the same client for a global setup or a script, for example to create the schema once. Nothing is undone without a cleanup registry. Call `close()` when done:

```typescript
import { createClickHouseClient, ConfigLoader } from '@inluxc/propmaster';

const client = await createClickHouseClient({ ...new ConfigLoader().load().clickhouse, createDatabase: true });
try {
    for (const statement of schema) await client.execute(statement);
} finally {
    await client.close();
}
```

### API Reference

| Method | Returns | |
|---|---|---|
| `query<T>(sql, params?, { settings, raw }?)` | `Promise<T[]>` | |
| `execute(sql, params?, { settings }?)` | `Promise<{ writtenRows }>` | Not undone |
| `insert(table, rows, { key, keep, settings }?)` | `Promise<{ inserted }>` | Deleted after the test |
| `waitForRows<T>(sql, params?, { count = 1, until, timeout }?)` | `Promise<T[]>` | |
| `waitForRow<T>(sql, params?, { until, timeout }?)` | `Promise<T>` | |
| `count(table, where?)` | `Promise<number>` | `where`: column → value |
| `createDatabase(name?, { keep }?)` | `Promise<string>` | Dropped after the test unless it existed or `keep` |
| `dropDatabase(name)` | `Promise<void>` | |
| `columns(table)` | `Promise<{ name, type }[]>` | |
| `database` | `string` | The configured database |
| `driver` | `ClickHouseClient` (`@clickhouse/client`) | Streaming, other formats, `exec` |

---

## Lifecycle

1. **Setup:** the client connects per test (creating the configured database when asked) and checks the credentials and database with a query.
2. **Teardown:** the test's inserts are deleted, newest first, and the databases it created are dropped. Then the client closes.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`clickhouse`, `connect`) | The server can't be reached, the credentials were refused (`AUTHENTICATION_FAILED`), or the database doesn't exist (the message says to set `createDatabase`) |
| `FixtureOperationError` (`clickhouse`, `query` / `execute`) | ClickHouse refused the statement: a syntax error, an unknown table or column, a parameter of the wrong type (`BAD_QUERY_PARAMETER`) |
| `FixtureOperationError` (`clickhouse`, `insert`) | A name isn't a plain identifier, the `key` names a column the table doesn't have, the engine can't delete rows, or the server refused a row |
| `FixtureOperationError` (`clickhouse`, `waitForRows`) | Not enough matching rows before the timeout. The message shows the rows that are there |
| `FixtureOperationError` (`clickhouse`, `createDatabase`) | The server refused the database |
| `MissingPackageError` | `@clickhouse/client` isn't installed |
