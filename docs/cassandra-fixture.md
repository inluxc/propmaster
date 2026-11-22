# Cassandra / ScyllaDB Fixture

`cassandraClient` runs CQL against Cassandra or ScyllaDB, the same way `databaseClient` runs SQL. Use it to check what a backend stored, to seed the rows a test needs, and to wait for rows a worker or consumer writes. Statements are always prepared with bound parameters, never built from strings.

---

## What It Does

- **`query()` returns plain objects:** UUIDs, timeuuids, inet addresses, dates, times, decimals and durations come back as strings. `bigint` and `varint` come back as numbers, or as a JS `bigint` beyond 2^53, so they stay exact. Sets and lists come back as arrays, maps as objects, and every page is read.
- **`execute()`** runs anything else and says whether a lightweight transaction (`IF NOT EXISTS`, `IF version = ?`) was applied.
- **`insert()` is undone after the test:** a new row is deleted, and an overwritten one gets its previous values back. That works in the application's own tables too, so a test can seed what it needs and leave the table as it found it.
- **Waiting:** `waitForRows()` and `waitForRow()` poll until the application has written what the test expects (and `until` passes). They fail with what is there instead.
- **Keyspaces:**
  - `createKeyspace()` makes one of the test's own, dropped afterwards.
  - With `createKeyspace: true`, the configured keyspace is created when it's missing, for local runs and containers. It's never dropped.
- **Readable failures:** an error names the statement, its parameters and the server's reason. A node that can't be reached lists every contact point with its error, and a wrong data center lists the ones the cluster has.

---

## Setup

### Install

```bash
npm install --save-dev cassandra-driver
```

[`cassandra-driver`](https://github.com/datastax/nodejs-driver) is the DataStax driver. It works with Apache Cassandra and ScyllaDB.

Then pick where the tests run:

```bash
# ScyllaDB from the repo's compose file
docker compose -f compose.test.yaml up -d --wait scylla
PW_CASSANDRA_KEYSPACE=shop PW_CASSANDRA_CREATE_KEYSPACE=true npx playwright test

# Or let the test run start ScyllaDB (needs Docker and testcontainers); the keyspace is created
PW_CASSANDRA_CONTAINER=true PW_CASSANDRA_KEYSPACE=shop npx playwright test

# Or Apache Cassandra in the container instead (ready in about a minute, against ScyllaDB's seconds)
PW_CASSANDRA_CONTAINER=cassandra:5 PW_CASSANDRA_KEYSPACE=shop npx playwright test

# Or a shared test cluster
PW_CASSANDRA_CONTACT_POINTS=cass-1.test,cass-2.test PW_CASSANDRA_LOCAL_DC=eu-west-1 \
  PW_CASSANDRA_KEYSPACE=shop PW_CASSANDRA_USERNAME=tests PW_CASSANDRA_PASSWORD=... npx playwright test
```

::: tip Why ScyllaDB
ScyllaDB speaks the same CQL protocol as Cassandra and is ready in a few seconds. A Cassandra container takes about a minute and much more memory. For the CQL that applications use, tests behave the same on both. Switch to `cassandra:5` when the application relies on behaviour specific to Cassandra or to its version.
:::

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_CASSANDRA_CONTACT_POINTS` | Nodes, comma-separated: `host` or `host:port` | `localhost` |
| `PW_CASSANDRA_PORT` | Port for contact points without one | `9042` |
| `PW_CASSANDRA_LOCAL_DC` | The data center of the contact points | `datacenter1` |
| `PW_CASSANDRA_KEYSPACE` | Keyspace for unqualified table names | — |
| `PW_CASSANDRA_CREATE_KEYSPACE` | `true` creates that keyspace when it's missing | off (on with a container) |
| `PW_CASSANDRA_USERNAME`, `PW_CASSANDRA_PASSWORD` | Password authentication | — |
| `PW_CASSANDRA_CONSISTENCY` | Default consistency: `localQuorum`, `one`, `quorum`, … | the driver's (`localOne`) |
| `PW_CASSANDRA_TIMEOUT` | Default wait for `waitForRows()`, in ms | `10000` |
| `PW_CASSANDRA_CONTAINER` | `true` starts ScyllaDB in a container; an image name (`cassandra:5`) picks another | off |

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "cassandra": { "contactPoints": ["localhost"], "keyspace": "shop", "createKeyspace": true }
        },
        "dev": {
            "cassandra": {
                "contactPoints": ["cass-1.dev.example.com", "cass-2.dev.example.com"],
                "localDataCenter": "eu-west-1",
                "keyspace": "shop",
                "username": "tests",
                "consistency": "localQuorum"
            }
        }
    }
}
```

The password can come from a [secrets provider](./secrets): map it to `cassandra.password`.

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
            use: { cassandra: config.cassandra, openapi: config.openapi },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `contactPoints` | `string[]` | `['localhost']` | |
| `port` | `number` | `9042` | |
| `localDataCenter` | `string` | `datacenter1` | Must match the cluster's |
| `keyspace` | `string` | — | |
| `createKeyspace` | `boolean` | `false` | |
| `replication` | `Record<string, string \| number>` | `{ class: 'NetworkTopologyStrategy', replication_factor: 1 }` | For keyspaces the fixture creates |
| `username`, `password` | `string` | — | |
| `consistency` | `string` | the driver's | |
| `timeout` | `number` | `10000` | ms |
| `requestTimeout`, `connectTimeout` | `number` | `12000`, `10000` | ms |
| `container` | `boolean \| ContainerOptions` | off | See [Testcontainers](./testcontainers) |

---

## Usage

### Check what the application stored

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-CAS-001] placing an order stores it', { tag: ['@TC-CAS-001'] }, async ({ cassandraClient, openApiClient, testData }) => {
    const customerId = testData.unique('customer');

    await test.step('Step 1: Place an order', async () => {
        const response = await (openApiClient.client as any).placeOrder(null, { customerId, sku: 'A-1', qty: 2 });
        expect(response.status).toBe(201);
    });

    await test.step('Step 2: Verify the order row', async () => {
        const order = await cassandraClient.waitForRow('SELECT * FROM orders WHERE customer_id = ?', [customerId]);
        expect(order).toMatchObject({ status: 'open', qty: 2, total: '19.80' });
    });
});
```

Match on something unique to the test, like a `testData.unique()` customer ID: other tests and workers share the table.

### Parameters and values

```typescript
await cassandraClient.query('SELECT * FROM orders WHERE customer_id = ? AND ordered_at > ?', [customerId, since]);
await cassandraClient.query('SELECT * FROM orders WHERE customer_id = :customer', { customer: customerId });   // named
await cassandraClient.query('SELECT * FROM orders WHERE customer_id = ?', [customerId], { consistency: 'quorum' });
await cassandraClient.query('SELECT id FROM orders WHERE customer_id = ?', [customerId], { raw: true });       // driver types (Uuid, Long, ...)
```

Pass values as plain JS: a string for `uuid`, `inet`, `decimal` and `date`, a `Date` for `timestamp`, an array for `list` and `set`, an object for `map`, and a number or `bigint` for integers. The driver converts them using the prepared statement's column types.

| CQL type | `query()` returns |
|---|---|
| `text`, `varchar`, `ascii`, `boolean`, `int`, `smallint`, `tinyint`, `float`, `double` | as is |
| `bigint`, `counter`, `varint` | `number`, or `bigint` beyond 2^53 |
| `uuid`, `timeuuid`, `inet`, `date`, `time`, `decimal`, `duration` | `string` |
| `timestamp` | `Date` |
| `blob` | `Buffer` |
| `list`, `set`, `tuple` | array |
| `map`, UDT | object |
| a column with no value | `null` |

### Seed data, undone afterwards

```typescript
await cassandraClient.insert('orders', { customer_id: customerId, ordered_at: new Date(), status: 'open' });   // deleted after the test
await cassandraClient.insert('settings', { tenant: 'acme', plan: 'trial' });   // overwrote a row: put back after the test
await cassandraClient.insert('products', products);                            // many rows
await cassandraClient.insert('countries', { code: 'PT' }, { keep: true });     // left in place
await cassandraClient.insert('sessions', { user_id, session_id }, { ttl: 60 });  // USING TTL 60
```

Every row needs its whole primary key. To undo an insert, the fixture reads the row as it is just before the insert (`SELECT JSON`), and after the test writes it back (`INSERT JSON`), or deletes it if it was new. TTLs and write times are not restored. `execute()` and `batch()` are not undone: for an `UPDATE` or `DELETE` a test makes, register `testData.cleanup()`.

### Wait for rows the application writes

```typescript
// The first row, once its status is shipped
const order = await cassandraClient.waitForRow('SELECT * FROM orders WHERE customer_id = ?', [customerId], {
    until: (o) => o.status === 'shipped',
    timeout: 30_000,
});

// Three events for an order
const events = await cassandraClient.waitForRows('SELECT * FROM order_events WHERE order_id = ?', [orderId], { count: 3 });
```

### Lightweight transactions

```typescript
const { applied } = await cassandraClient.execute('UPDATE accounts SET balance = ?, version = ? WHERE id = ? IF version = ?', [80, 2, id, 1]);
expect(applied).toBe(false);   // someone else updated it first

const { applied: created } = await cassandraClient.insert('accounts', { id, balance: 100 }, { ifNotExists: true });  // → 0 or 1
```

Read the result with `{ consistency: 'serial' }` to see the latest committed value.

### Keyspaces and tables for local runs

```typescript
test.beforeAll(async ({ cassandraClient }) => {
    // The configured keyspace (created when createKeyspace is on); the application's tables in it
    await cassandraClient.execute(`CREATE TABLE IF NOT EXISTS orders (
        customer_id text, ordered_at timestamp, status text, total decimal,
        PRIMARY KEY ((customer_id), ordered_at)
    ) WITH CLUSTERING ORDER BY (ordered_at DESC)`);
});

// A keyspace of the test's own, dropped after it
const ks = await cassandraClient.createKeyspace();                 // propmaster_t0_9f2a1c0b
await cassandraClient.execute(`CREATE TABLE ${ks}.scratch (id int PRIMARY KEY, v text)`);
await cassandraClient.insert(`${ks}.scratch`, { id: 1, v: 'a' });
```

Write `keyspace.table` for a table outside the session keyspace. `useKeyspace(name)` changes the session keyspace for the rest of the test. Keyspaces the fixture creates use `NetworkTopologyStrategy` with one replica, which both Cassandra and ScyllaDB accept. (ScyllaDB's tablets refuse `SimpleStrategy`.) Set `replication` for anything else.

### With the Steps class

```typescript
import { CassandraSteps } from '@inluxc/propmaster/steps';

const cassandra = new CassandraSteps(cassandraClient);
await cassandra.insert('Seed the customer', 'customers', { id: customerId, tier: 'gold' });
await cassandra.expectRow('Verify the order is shipped', 'SELECT * FROM orders WHERE customer_id = ?', [customerId], { status: 'shipped' }, { timeout: 30_000 });
await cassandra.expectRows('Verify three events', 'SELECT * FROM order_events WHERE order_id = ?', [orderId], { count: 3 });
await cassandra.expectNoRows('Verify the draft is gone', 'SELECT * FROM drafts WHERE id = ?', [draftId]);
await cassandra.execute('Lock the account', 'UPDATE accounts SET locked = true WHERE id = ? IF locked = false', [id]);
await cassandra.expectNotApplied('Verify a second lock is refused', 'UPDATE accounts SET locked = true WHERE id = ? IF locked = false', [id]);
```

`expectRow()` keeps waiting until the row matches (`toMatchObject`), and on timeout shows the difference.

### Outside a test

`createCassandraClient(config)` gives the same client for a global setup or a script, for example to create the schema once. Nothing is undone without a cleanup registry. Call `close()` when done:

```typescript
import { createCassandraClient, ConfigLoader } from '@inluxc/propmaster';

const client = await createCassandraClient({ ...new ConfigLoader().load().cassandra, createKeyspace: true });
try {
    for (const statement of schema) await client.execute(statement);
} finally {
    await client.close();
}
```

### API Reference

| Method | Returns | |
|---|---|---|
| `query<T>(cql, params?, { consistency, fetchSize, raw }?)` | `Promise<T[]>` | Every page |
| `execute(cql, params?, { consistency }?)` | `Promise<{ applied }>` | Not undone |
| `batch([{ cql, params }], { logged = true, consistency }?)` | `Promise<{ applied }>` | Not undone |
| `insert(table, rows, { ttl, ifNotExists, keep }?)` | `Promise<{ applied }>` | How many rows were applied. Undone |
| `waitForRows<T>(cql, params?, { count = 1, until, timeout }?)` | `Promise<T[]>` | |
| `waitForRow<T>(cql, params?, { until, timeout }?)` | `Promise<T>` | |
| `createKeyspace(name?, { replication, keep }?)` | `Promise<string>` | Dropped after the test unless it existed or `keep` |
| `useKeyspace(name)`, `dropKeyspace(name)` | `Promise<void>` | |
| `primaryKey(table)` | `Promise<{ partitionKeys, clusteringKeys }>` | |
| `keyspace` | `string \| undefined` | The session keyspace |
| `driver` | `cassandra.Client` | For anything else |

---

## Lifecycle

1. **Setup:** the driver connects (and creates the configured keyspace when asked) per test.
2. **Teardown:** the test's inserts are undone, newest first, and the keyspaces it created are dropped. Then the driver shuts down.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`cassandra`, `connect`) | No node answered (each contact point is listed with its error), the data center doesn't match, the credentials were refused, or the keyspace doesn't exist (the message says to set `createKeyspace`) |
| `FixtureOperationError` (`cassandra`, `query` / `execute` / `batch`) | The server refused the statement: a syntax error, an unknown table or column, a reserved word used as a name (`token`, `key`, …), a missing `ALLOW FILTERING` |
| `FixtureOperationError` (`cassandra`, `insert`) | A row lacks part of its primary key, a name isn't a plain identifier, or the server refused the insert |
| `FixtureOperationError` (`cassandra`, `waitForRows`) | Not enough matching rows before the timeout. The message shows the rows that are there |
| `FixtureOperationError` (`cassandra`, `createKeyspace`) | The server refused the keyspace or its replication |
| `MissingPackageError` | `cassandra-driver` isn't installed |
