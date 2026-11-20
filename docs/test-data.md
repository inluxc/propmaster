# Test Data and Automatic Cleanup

Data a test creates through the Propmaster clients is **removed when the test ends, pass or fail**. You don't need `afterEach` cleanup for it. The `testData` fixture adds factories that build rows and documents with values unique across parallel workers.

```typescript
import { test, expect, defineFactory } from '@inluxc/propmaster';

const user = defineFactory('user', (f) => ({
    email: f.email('user'),   // user-t3-9f2a1c0b-1@example.test
    name: `User ${f.seq}`,
    active: true,
}));

test('[TC-API-NNN] a deactivated user can\'t log in', { tag: ['@TC-API-NNN'] }, async ({ databaseClient, testData, openApiClient }) => {
    const alice = testData.build(user, { active: false });

    await test.step('Step 1: Insert the user (deleted again after the test)', async () => {
        await databaseClient.insert('users', alice);
    });

    await test.step('Step 2: Verify the login is refused', async () => {
        const res = await (openApiClient.client as any).login(null, { email: alice.email }, { validateStatus: () => true });
        expect(res.status).toBe(403);
    });
});
```

---

## What is cleaned up

Each client records how to undo its own inserts. When the test ends, the undo actions run newest first, before the clients disconnect.

| Call | Undone by |
|---|---|
| `databaseClient.insert(table, rows)` | `DELETE` of each row, matched on `key`, else `id` when every row has one, else every inserted column |
| `mongoDbClient.insertOne` / `insertMany` | `deleteMany` by the inserted `_id`s |
| `redisClient.set(key, ...)` | `DEL` of a new key; a key that already existed gets its previous value back (without its TTL) |
| `neo4jClient.write(cypher, { runId })` | `MATCH (n {runId: $runId}) DETACH DELETE n`, once per run ID. `executeInTransaction` too, once the transaction has committed |
| `testData.cleanup(fn)` | Your own undo action, for data made another way |

**Not tracked:**
- **Raw SQL through `databaseClient.execute()`.** An arbitrary statement can't be undone reliably. Use `insert()`, or register the undo yourself with `testData.cleanup()`.
- **Updates and deletes** in every backend.
- **Neo4j writes without a `runId` parameter.**
- **Data your application creates.**

### Keeping data

- **One call:** pass `{ keep: true }`, for example `databaseClient.insert('users', row, { keep: true })`, `mongoDbClient.insertOne('cfg', doc, { keep: true })`, `redisClient.set(key, value, ttl, { keep: true })` or `neo4jClient.write(cypher, params, { keep: true })`.
- **A whole project, such as a setup project that seeds shared data:** set `use: { autoCleanup: false }`. Undo actions added with `testData.cleanup()` still run.

```typescript
// playwright.config.ts
projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts/, use: { autoCleanup: false } },
    { name: 'api', dependencies: ['seed'] },
],
```

### When cleanup fails

Every undo action runs, even when an earlier one fails. Then the test fails with a `FixtureOperationError` (`testData`, `cleanup`) that lists each action that failed and why, for example a foreign key that still references the row. Delete the referencing rows in the test, or insert the parent first: undo runs newest first, so children are deleted before their parents.

---

## Factories

```typescript
// tests/factories.ts: share factories between spec files
import { defineFactory } from '@inluxc/propmaster';

export const customer = defineFactory('customer', (f) => ({
    id: f.unique('cus'),        // cus-t3-9f2a1c0b-1
    email: f.email('customer'),
    name: f.faker.person.fullName(), // needs @faker-js/faker
    tier: 'free',
}));
```

```typescript
const c = testData.build(customer, { tier: 'pro' });                    // one object, overrides merged
const list = testData.buildMany(customer, 5, (c, i) => ({ tier: i ? 'free' : 'pro' }));
testData.define('order', (f) => ({ ref: f.unique('ord'), total: 10 })); // or register by name
const o = testData.build<{ ref: string; total: number }>('order');
```

`build` only creates the object. Store it with the client of your choice: `databaseClient.insert`, `mongoDbClient.insertOne`, or the API under test.

### The factory context

| Member | Value |
|---|---|
| `f.seq` | 1, 2, 3, ... per test, shared by every factory and `unique()` call in the test |
| `f.runId` | The test's run ID, e.g. `t3-9f2a1c0b` (worker index and 8 random hex digits) |
| `f.unique(prefix)` | `<prefix>-<runId>-<n>`, unique across parallel workers and runs |
| `f.email(prefix, domain?)` | `<prefix>-<runId>-<n>@example.test` |
| `f.faker` | [Faker](https://fakerjs.dev/), when `@faker-js/faker` is installed |

Faker values look realistic but aren't unique. Use `unique()` or `email()` for anything with a unique constraint. Faker is optional: install it with `npm install --save-dev @faker-js/faker`. A factory that reads `f.faker` without it throws a `MissingPackageError` with that command.

### testData members

| Member | Description |
|---|---|
| `runId` | The test's run ID. Pass it as `runId` in Neo4j writes so they're cleaned up |
| `unique(prefix?)`, `email(prefix?, domain?)` | Unique values, as in factories |
| `build(factory, overrides?)`, `buildMany(factory, n, overrides?)` | Build objects; `factory` is a factory or a name given to `define` |
| `define(name, build)` | Registers a factory for this test and returns it |
| `cleanup(fn)`, `cleanup(label, fn)` | Adds an undo action; it runs at the end of the test, newest first |
| `pendingCleanups` | Labels of the undo actions waiting to run |
| `flushCleanups()` | Runs them now instead of at the end of the test |
| `faker` | The Faker instance |

---

## Parallel tests

- **Unique values never collide.** Each test's run ID combines the worker index with random bits, so `unique()` and `email()` differ across workers, retries and CI runs.
- **Cleanup only touches what the test created:** the rows it inserted, the `_id`s it got back, the keys it set, the run ID it wrote with. Another test's data is safe as long as tests don't share keys. Build keys with `unique()`.
- **SQL rows with generated IDs** are deleted by matching every inserted column. Include a unique value (`f.email()`, `f.unique()`) so the delete can't match another test's row. Pass `{ key: 'email' }` when a column can't be compared with `=` (JSON, BLOB).

## Neo4j

Tag test nodes with the test's run ID:

```typescript
await neo4jClient.write('CREATE (:Person {runId: $runId, name: $name})', { runId: testData.runId, name: 'Alice' });
// at the end of the test: MATCH (n {runId: $runId}) DETACH DELETE n
```

Any string `runId` parameter is tracked, including one shared by every test in a file. In that case the first test to finish deletes the nodes for all of them. Use `testData.runId`, or pass `{ keep: true }`, when tests in a serial file build on each other's nodes.

## Custom cleanups

Use `testData.cleanup()` for data made outside the tracked clients: an API call, raw SQL, a browser flow.

```typescript
const res = await (openApiClient.client as any).createProject(null, { name: testData.unique('proj') });
testData.cleanup('delete the project', () => (openApiClient.client as any).deleteProject({ id: res.data.id }));
```

Custom cleanups share the stack with the tracked ones, so they run in reverse order with everything else, while the clients are still connected.
