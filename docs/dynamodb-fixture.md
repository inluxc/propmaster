# DynamoDB Fixture

`dynamoDbClient` checks what a backend stores in DynamoDB, and writes the items a test needs. Items go in and come out as plain objects, and so do conditions and filters. There are no expression strings, `#name` placeholders or `{ S: '…' }` values to write. It runs against an emulator ([Moto](https://github.com/getmoto/moto), LocalStack, DynamoDB Local) or a real test account, with the same `aws` config as the [S3 and SQS fixtures](./aws-fixture).

---

## What It Does

- **Plain objects:** `put`, `get`, `update`, `delete`, `query` and `scan` take and return objects. Numbers come back as numbers, maps as objects, lists as arrays and sets as `Set`.
- **Conditions as objects:**
  - `{ status: 'open', total: { '>': 10 } }` works as a key condition, a filter or a write condition.
  - Every operator DynamoDB has: `=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `beginsWith`, `contains`, `exists`, `in`.
  - Dotted names are paths into maps (`'address.city'`).
- **Undone after the test:** a new item is deleted, and an overwritten or updated one gets its previous content back. That works in the application's own tables too, so a test can seed what it needs and leave the table as it found it.
- **Waiting:**
  - `waitForItem()` polls until the application has written an item, or until it has the state you expect.
  - `waitForQuery()` waits for a number of items.
  - Both fail with what is there instead.
- **Tables for local runs:**
  - `createTable()` makes a table from a short definition (`{ key: { customerId: 'S', orderedAt: 'N' } }`), with indexes, TTL and a stream, and waits until it's active.
  - `tableName()` gives a name of the test's own.
  - A table the test created is deleted afterwards.
- **Readable failures:** a failed call names the table and key, and shows the condition with the real names and values (`version = 3`). A missing table says which region and endpoint were asked.

---

## Setup

### Install

```bash
npm install --save-dev @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

`@aws-sdk/lib-dynamodb` is the AWS document client: it turns plain objects into DynamoDB's typed attribute values and back.

Then pick where the tests run:

```bash
# Moto from the repo's compose file, on LocalStack's port 4566
docker compose -f compose.test.yaml up -d --wait moto
PW_AWS_ENDPOINT=http://localhost:4566 npx playwright test

# Or let the test run start Moto (needs Docker and testcontainers)
PW_AWS_CONTAINER=true npx playwright test

# Or DynamoDB Local
docker run -d -p 8000:8000 amazon/dynamodb-local
PW_AWS_ENDPOINT=http://localhost:8000 npx playwright test

# Or a real test account: credentials from the standard AWS chain
PW_AWS_REGION=eu-west-1 PW_AWS_PROFILE=tests npx playwright test
```

### Environment Variables

The [AWS variables](./aws-fixture#environment-variables) (`PW_AWS_ENDPOINT`, `PW_AWS_REGION`, credentials, `PW_AWS_CONTAINER`) apply here too. On top of them:

| Variable | Description | Default |
|---|---|---|
| `PW_AWS_DYNAMODB_TABLE_PREFIX` | Root of the per-test table names from `tableName()` | `propmaster-tests-` |
| `PW_AWS_TIMEOUT` | Default wait for `waitForItem()` and `waitForQuery()`, in ms | `10000` |

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "aws": { "endpoint": "http://localhost:4566" }
        },
        "dev": {
            "aws": { "region": "eu-west-1", "profile": "tests", "dynamodb": { "tablePrefix": "ci-" } }
        }
    }
}
```

Pass `use: { aws: config.aws }` in `playwright.config.ts`, as for [S3 and SQS](./aws-fixture#configuration-via-playwright-config-ts).

---

## Usage

### Check what the application stored

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-DDB-001] placing an order stores it', { tag: ['@TC-DDB-001'] }, async ({ dynamoDbClient, openApiClient, testData }) => {
    const customerId = testData.unique('customer');
    let orderedAt = 0;

    await test.step('Step 1: Place an order', async () => {
        const response = await (openApiClient.client as any).placeOrder(null, { customerId, sku: 'A-1', qty: 2 });
        expect(response.status).toBe(201);
        orderedAt = response.data.orderedAt;
    });

    await test.step('Step 2: Verify the order item', async () => {
        const order = await dynamoDbClient.waitForItem('orders', { customerId, orderedAt });
        expect(order).toMatchObject({ status: 'open', lines: [{ sku: 'A-1', qty: 2 }] });
    });
});
```

Match on something unique to the test, like a `testData.unique()` customer ID: other tests and workers share the table.

### Wait for a state change

`until` keeps waiting while the item exists but isn't there yet:

```typescript
const shipped = await dynamoDbClient.waitForItem('orders', key, { until: (o) => o.status === 'shipped', timeout: 30_000 });

// A key the application picks (an event ID): wait for the query instead
const [event] = await dynamoDbClient.waitForQuery('events', { orderId, type: { beginsWith: 'payment.' } }, { index: 'byOrder' });
const all = await dynamoDbClient.waitForQuery('events', { orderId }, { index: 'byOrder', count: 3 });
```

### Seed data, undone afterwards

```typescript
await dynamoDbClient.put('settings', { tenant, plan: 'pro', limits: { users: 5 } });   // deleted after the test
await dynamoDbClient.update('settings', { tenant: 'acme' }, { plan: 'trial' });        // put back as it was after the test
await dynamoDbClient.putMany('products', products);
await dynamoDbClient.put('countries', { code: 'PT' }, { keep: true });                  // left in place
```

To undo a write, the fixture reads the item's current content just before the write, and puts it back after the test, or deletes the item if it was new. `delete()` is not undone. Set `use: { autoCleanup: false }` on a project to turn the undo off.

### Query and scan

```typescript
const orders = await dynamoDbClient.query<Order>('orders', { customerId });                                       // sort-key order
const recent = await dynamoDbClient.query<Order>('orders', { customerId, orderedAt: { '>=': since } }, { descending: true, limit: 10 });
const open = await dynamoDbClient.query<Order>('orders', { status: 'open' }, { index: 'byStatus', filter: { total: { '>': 100 } } });
const count = await dynamoDbClient.count('orders', { customerId }, { filter: { status: { in: ['open', 'paid'] } } });
const flagged = await dynamoDbClient.scan('orders', { filter: { 'review.flagged': true } });                      // reads the whole table
```

A query or scan follows every page until it has `limit` items, or all of them. Reads are strongly consistent by default, so a test reads what it just wrote. Global indexes can't be read consistently, so queries on them aren't.

| Comparison | Example |
|---|---|
| equals | `{ status: 'open' }`, or `{ '=': value }` for a map whose only field is an operator name |
| `<>` `<` `<=` `>` `>=` | `{ total: { '>': 10 } }` |
| `between` | `{ orderedAt: { between: [from, to] } }` |
| `beginsWith` | `{ sk: { beginsWith: 'ORDER#' } }` |
| `contains` | `{ tags: { contains: 'gift' } }` (a string, set or list) |
| `exists` | `{ deletedAt: { exists: false } }` |
| `in` | `{ status: { in: ['open', 'paid'] } }` (filters and conditions only) |

For anything else, pass an expression with its own names and values: `{ expression: 'size(#l) > :n', names: { '#l': 'lines' }, values: { ':n': 2 } }`.

### Conditional writes

```typescript
await dynamoDbClient.put('accounts', { id, balance: 100, version: 1 }, { ifNotExists: true });
await dynamoDbClient.update('accounts', { id }, { balance: 80, version: 2 }, { condition: { version: 1 } });
await dynamoDbClient.delete('accounts', { id }, { condition: { balance: 0 } });

// A refused write throws FixtureOperationError with ConditionalCheckFailedException in the message
await expect(dynamoDbClient.put('accounts', { id, balance: 0 }, { ifNotExists: true })).rejects.toThrow(/ConditionalCheckFailedException/);
```

`update()` sets the attributes you pass and returns the whole item after the change. Key attributes in `changes` are left out, since DynamoDB can't change them. Pass `{ remove: ['field'] }` to remove attributes, or an expression for `ADD` and `DELETE`:

```typescript
await dynamoDbClient.update('counters', { id }, { expression: 'ADD #c :one', names: { '#c': 'count' }, values: { ':one': 1 } });
```

### Tables for local runs

```typescript
test.beforeEach(async ({ dynamoDbClient }) => {
    // The application's table, created on an emulator if it's missing; kept between tests
    await dynamoDbClient.createTable('orders', {
        key: { customerId: 'S', orderedAt: 'N' },                 // partition key, then sort key
        indexes: { byStatus: { status: 'S', orderedAt: 'N' } },   // global secondary indexes
        localIndexes: { byTotal: { customerId: 'S', total: 'N' } },
        ttl: 'expiresAt',
        stream: 'NEW_AND_OLD_IMAGES',
    }, { keep: true });
});

// A table of the test's own, deleted after it
const table = dynamoDbClient.tableName('orders');                 // propmaster-tests-t0-9f2a1c0b-orders
await dynamoDbClient.createTable(table, { key: { id: 'S' } });
```

`createTable()` does nothing when the table already exists, and then never deletes it. New tables are on demand (pay per request), and indexes project every attribute. On a real account, have the tables created by your infrastructure code and use `createTable()` only against emulators.

### With the Steps class

```typescript
import { DynamoDbSteps } from '@inluxc/propmaster/steps';

const dynamo = new DynamoDbSteps(dynamoDbClient);
await dynamo.put('Seed the customer', 'customers', { id: customerId, tier: 'gold' });
await dynamo.expectItem('Verify the order is shipped', 'orders', { customerId, orderedAt }, { status: 'shipped' }, { timeout: 30_000 });
await dynamo.expectQuery('Verify three events were stored', 'events', { orderId }, { index: 'byOrder', count: 3 });
await dynamo.expectCount('Verify one open order', 'orders', { customerId }, 1, { filter: { status: 'open' } });
await dynamo.expectNoItem('Verify the draft was removed', 'drafts', { id: draftId });
await dynamo.expectConditionFailed('Verify a duplicate is refused', () => dynamoDbClient.put('accounts', { id }, { ifNotExists: true }));
```

`expectItem()` keeps waiting until the item matches (`toMatchObject`), and on timeout shows the difference.

### Outside a test

`createDynamoDbClient(config)` gives the same client for a global setup or a script. Nothing is undone without a cleanup registry. Call `close()` when done:

```typescript
import { createDynamoDbClient, ConfigLoader } from '@inluxc/propmaster';

const client = await createDynamoDbClient(new ConfigLoader().load().aws ?? {});
try {
    await client.createTable('orders', { key: { customerId: 'S', orderedAt: 'N' } });
    await client.putMany('countries', [{ code: 'PT' }, { code: 'ES' }]);
} finally {
    client.close();
}
```

### API Reference

| Method | Returns | |
|---|---|---|
| `put(table, item, { ifNotExists, condition, keep }?)` | `Promise<void>` | Replaces an item with the same key. Undone |
| `putMany(table, items, { keep }?)` | `Promise<void>` | Each undone like `put()` |
| `get<T>(table, key, { consistent = true }?)` | `Promise<T \| null>` | |
| `update<T>(table, key, changes, { remove, condition, keep }?)` | `Promise<T>` | The item after the change; creates it if missing. Undone |
| `delete<T>(table, key, { condition }?)` | `Promise<T \| null>` | The removed item. Not undone |
| `query<T>(table, keyCondition, { index, filter, limit, descending, consistent }?)` | `Promise<T[]>` | |
| `scan<T>(table, { index, filter, limit, consistent }?)` | `Promise<T[]>` | |
| `count(table, keyCondition, { index, filter, consistent }?)` | `Promise<number>` | |
| `waitForItem<T>(table, key, { until, timeout }?)` | `Promise<T>` | |
| `waitForQuery<T>(table, keyCondition, { count = 1, index, filter, timeout }?)` | `Promise<T[]>` | |
| `createTable(table, definition, { keep }?)` | `Promise<void>` | Deleted after the test unless it existed or `keep` |
| `deleteTable(table)`, `tableExists(table)`, `tableKey(table)` | | `tableKey` → `{ partitionKey, sortKey? }` |
| `tableName(name)`, `tablePrefix` | `string` | |
| `sdk`, `documentClient` | AWS SDK clients | For anything else, such as transactions |

---

## Lifecycle

1. **Setup:** one AWS SDK client per test. Nothing is sent until the first call.
2. **Teardown:** the test's writes are undone, newest first, then the tables it created are deleted. A table that existed before the test is never deleted. Then the client is destroyed.

The first write to a table reads its key schema (`DescribeTable`) to know which attributes identify an item. A role that runs the tests needs `dynamodb:DescribeTable` as well as the item permissions.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`aws`, `connect`) | No region, or only one of the two access keys |
| `FixtureOperationError` (`dynamodb`, `put` / `get` / `update` / `delete` / `query` / `scan` / `count`) | The table doesn't exist, a condition failed (`ConditionalCheckFailedException`), an item lacks its key attributes, or DynamoDB rejected the call |
| `FixtureOperationError` (`dynamodb`, `waitForItem`) | Nothing matched before the timeout. The message shows the item or items that are there |
| `FixtureOperationError` (`dynamodb`, `createTable`) | A mistake in the definition, or the table didn't become active within 60 s |
| `MissingPackageError` | `@aws-sdk/client-dynamodb` or `@aws-sdk/lib-dynamodb` isn't installed |
