# Neo4j Fixture

The `neo4jClient` fixture provides a Neo4j graph database client for running Cypher reads, writes and transactions. It uses the official [neo4j-driver](https://github.com/neo4j/neo4j-javascript-driver) and returns plain JS objects, with Neo4j Integers converted to numbers.

---

## What It Does

- Connects to Neo4j over `bolt://` or `neo4j://` and verifies connectivity on setup
- Runs read queries (`run`) with READ routing and returns each record as a plain object
- Runs write queries (`write`) with WRITE routing and returns update counters
- Runs several statements atomically with `executeInTransaction`
- Converts Neo4j Integers to JS numbers, and nodes/relationships/paths to plain objects
- Closes the driver on teardown

---

## Setup

### Install

The driver is an optional peer dependency. Install it in your project:

```bash
npm install --save-dev neo4j-driver
```

### Run it in a container

No Neo4j server to connect to? Set `PW_NEO4J_CONTAINER=true` (or `container: true` in config) and the fixture starts one with Testcontainers for the run, then removes it. Needs Docker and `npm install --save-dev testcontainers`. See [Testcontainers](./testcontainers).

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_NEO4J_URI` | Yes | Connection URI, e.g. `bolt://localhost:7687` |
| `PW_NEO4J_USERNAME` | Yes | Authentication username |
| `PW_NEO4J_PASSWORD` | Yes | Authentication password |
| `PW_NEO4J_DATABASE` | No | Target database (default: the server's default database) |

### Configuration via `environments.json`

```json
{
  "environments": {
    "local": {
      "neo4j": {
        "uri": "bolt://localhost:7687",
        "username": "neo4j",
        "password": "testpassword",
        "database": "neo4j",
        "connectionTimeout": 10000
      }
    }
  }
}
```

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import type { ConfigOptions } from '@inluxc/stagehand';

export default defineConfig<ConfigOptions>({
  projects: [
    {
      name: 'graph',
      testMatch: '**/graph/**/*.spec.ts',
      use: {
        neo4j: {
          uri: 'bolt://localhost:7687',
          username: 'neo4j',
          password: process.env.NEO4J_PASSWORD!,
        },
      },
    },
  ],
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `uri` | `string` | — | `bolt://` (single server) or `neo4j://` (routing/cluster) URI |
| `username` | `string` | — | Authentication username |
| `password` | `string` | — | Authentication password |
| `database` | `string` | server default | Database to run queries against |
| `connectionTimeout` | `number` | `10000` | Connection and acquisition timeout in ms |

### Local Server

```bash
docker run -p 7687:7687 -e NEO4J_AUTH=neo4j/testpassword neo4j:5
```

---

## Usage

```typescript
import { test, expect } from '@inluxc/stagehand';

test('create and query a relationship', async ({ neo4jClient }) => {
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

test('write atomically', async ({ neo4jClient }) => {
  await neo4jClient.executeInTransaction(async (tx) => {
    await tx.run('CREATE (:Order {id: $id})', { id: 'ORD-1' });
    await tx.run('MATCH (o:Order {id: $id}) CREATE (o)-[:CONTAINS]->(:Item {sku: $sku})', { id: 'ORD-1', sku: 'A' });
  }); // committed when the callback resolves, rolled back if it throws
});
```

Always pass values as parameters (`$name`) rather than interpolating them into the Cypher string.

### API Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `run<T>(cypher, params?)` | `Promise<T[]>` | Read query; each record via `record.toObject()`, Integers as numbers |
| `write(cypher, params?)` | `Promise<Neo4jWriteResult>` | Write query; returns `nodesCreated`, `relationshipsCreated`, `propertiesSet`, `nodesDeleted`, `relationshipsDeleted` |
| `executeInTransaction(fn)` | `Promise<R>` | Runs `fn(tx)` in one write transaction; `tx.run<T>(cypher, params?)` returns `T[]` |
| `close()` | `Promise<void>` | Closes the driver (done automatically on teardown) |

---

## Test Data Isolation

Neo4j has no key prefix equivalent, so tag every node your test creates and clean up by that tag. The example spec gives each node a `StagehandTest` label and a per-run `runId` property, and deletes them in `afterEach`:

```typescript
const RUN_ID = `stagehand-${randomUUID()}`;

test.afterEach(async ({ neo4jClient }) => {
  await neo4jClient.write('MATCH (n:StagehandTest {runId: $runId}) DETACH DELETE n', { runId: RUN_ID });
});
```

---

## Lifecycle

1. **Setup** — creates the driver and calls `driver.verifyConnectivity()`
2. **Use** — the test receives the `neo4jClient`
3. **Teardown** — closes the driver

---

## Error Handling

| Error | When |
|-------|------|
| `FixtureInitError('neo4j', 'connect', …)` | Server unreachable, bad credentials, or missing config. Includes `uri`, `database`, `timeout` and the driver's reason |
| `FixtureOperationError('neo4j', 'run' \| 'write' \| 'transaction', …)` | A Cypher statement or transaction failed. Includes the `cypher` statement and reason |
