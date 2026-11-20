/**
 * Neo4j Fixture — Example Test
 *
 * Demonstrates how to use the Neo4j client fixture to run parameterised Cypher
 * reads, writes and transactions against a Neo4j graph database.
 *
 * Isolation: every node created here carries the `PropmasterTest` label and a
 * `runId` property unique to this run. Tests only match on that run ID, and
 * `afterEach` detach-deletes everything tagged with it.
 *
 * Prerequisites:
 *   - Neo4j configured in environments.json or via PW_NEO4J_* environment variables
 *   - The target Neo4j server running and accessible
 *     (e.g. docker run -p 7687:7687 -e NEO4J_AUTH=neo4j/testpassword neo4j:5)
 */

import { randomUUID } from 'node:crypto';
import { test, expect, FixtureOperationError } from '../../src';

const RUN_ID = `propmaster-${randomUUID()}`;

test.describe('Neo4j Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test.afterEach(async ({ neo4jClient }) => {
        await test.step('Cleanup: delete nodes created by this run', async () => {
            await neo4jClient.write(
                'MATCH (n:PropmasterTest {runId: $runId}) DETACH DELETE n',
                { runId: RUN_ID },
            );
        });
    });

    test('[TC-NEO-001] create a node and read it back', { tag: ['@TC-NEO-001'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Create a Person node', async () => {
            const counters = await neo4jClient.write(
                'CREATE (:PropmasterTest:Person {runId: $runId, name: $name, age: $age})',
                { runId: RUN_ID, name: 'Alice', age: 30 },
            );
            expect(counters.nodesCreated).toBe(1);
            expect(counters.propertiesSet).toBe(3);
        });

        await test.step('Step 2: Read the node and verify its properties', async () => {
            const rows = await neo4jClient.run<{ name: string; age: number }>(
                'MATCH (p:PropmasterTest:Person {runId: $runId, name: $name}) RETURN p.name AS name, p.age AS age',
                { runId: RUN_ID, name: 'Alice' },
            );
            expect(rows).toEqual([{ name: 'Alice', age: 30 }]);
        });

        await test.step('Step 3: Verify Neo4j integers are returned as JS numbers', async () => {
            const [row] = await neo4jClient.run<{ total: number }>(
                'MATCH (p:PropmasterTest {runId: $runId}) RETURN count(p) AS total',
                { runId: RUN_ID },
            );
            expect(typeof row.total).toBe('number');
            expect(row.total).toBe(1);
        });
    });

    test('[TC-NEO-002] create a relationship and traverse it', { tag: ['@TC-NEO-002'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Create two people connected by KNOWS', async () => {
            const counters = await neo4jClient.write(
                `CREATE (a:PropmasterTest:Person {runId: $runId, name: $from})
                 CREATE (b:PropmasterTest:Person {runId: $runId, name: $to})
                 CREATE (a)-[:KNOWS {since: $since}]->(b)`,
                { runId: RUN_ID, from: 'Alice', to: 'Bob', since: 2020 },
            );
            expect(counters.nodesCreated).toBe(2);
            expect(counters.relationshipsCreated).toBe(1);
        });

        await test.step('Step 2: Traverse the relationship and verify the result', async () => {
            const rows = await neo4jClient.run<{ friend: string; since: number }>(
                `MATCH (:PropmasterTest {runId: $runId, name: $name})-[k:KNOWS]->(f:PropmasterTest)
                 RETURN f.name AS friend, k.since AS since`,
                { runId: RUN_ID, name: 'Alice' },
            );
            expect(rows).toEqual([{ friend: 'Bob', since: 2020 }]);
        });
    });

    test('[TC-NEO-003] update node properties', { tag: ['@TC-NEO-003'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Create a node', async () => {
            await neo4jClient.write(
                'CREATE (:PropmasterTest:Account {runId: $runId, email: $email, active: true})',
                { runId: RUN_ID, email: 'carol@example.com' },
            );
        });

        await test.step('Step 2: Deactivate the account and verify the counters', async () => {
            const counters = await neo4jClient.write(
                'MATCH (a:PropmasterTest:Account {runId: $runId, email: $email}) SET a.active = $active',
                { runId: RUN_ID, email: 'carol@example.com', active: false },
            );
            expect(counters.propertiesSet).toBe(1);
        });

        await test.step('Step 3: Verify the stored value changed', async () => {
            const [row] = await neo4jClient.run<{ active: boolean }>(
                'MATCH (a:PropmasterTest:Account {runId: $runId, email: $email}) RETURN a.active AS active',
                { runId: RUN_ID, email: 'carol@example.com' },
            );
            expect(row.active).toBe(false);
        });
    });

    test('[TC-NEO-004] delete nodes and relationships', { tag: ['@TC-NEO-004'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Create a connected pair of nodes', async () => {
            await neo4jClient.write(
                `CREATE (:PropmasterTest:Temp {runId: $runId, name: $a})-[:LINKS]->(:PropmasterTest:Temp {runId: $runId, name: $b})`,
                { runId: RUN_ID, a: 'x', b: 'y' },
            );
        });

        await test.step('Step 2: Detach-delete the nodes and verify the counters', async () => {
            const counters = await neo4jClient.write(
                'MATCH (t:PropmasterTest:Temp {runId: $runId}) DETACH DELETE t',
                { runId: RUN_ID },
            );
            expect(counters.nodesDeleted).toBe(2);
            expect(counters.relationshipsDeleted).toBe(1);
        });

        await test.step('Step 3: Verify no matching nodes remain', async () => {
            const rows = await neo4jClient.run(
                'MATCH (t:PropmasterTest:Temp {runId: $runId}) RETURN t',
                { runId: RUN_ID },
            );
            expect(rows).toHaveLength(0);
        });
    });

    test('[TC-NEO-005] commit several statements in one transaction', { tag: ['@TC-NEO-005'] }, async ({ neo4jClient }) => {
        let returned: number | undefined;

        await test.step('Step 1: Create an order and its line item in one transaction', async () => {
            returned = await neo4jClient.executeInTransaction(async (tx) => {
                await tx.run(
                    'CREATE (:PropmasterTest:Order {runId: $runId, orderId: $orderId})',
                    { runId: RUN_ID, orderId: 'ORD-1' },
                );
                const [row] = await tx.run<{ items: number }>(
                    `MATCH (o:PropmasterTest:Order {runId: $runId, orderId: $orderId})
                     CREATE (o)-[:CONTAINS]->(:PropmasterTest:Item {runId: $runId, sku: $sku})
                     RETURN count(*) AS items`,
                    { runId: RUN_ID, orderId: 'ORD-1', sku: 'SKU-42' },
                );
                return row.items;
            });
        });

        await test.step('Step 2: Verify the callback result is returned', async () => {
            expect(returned).toBe(1);
        });

        await test.step('Step 3: Verify both writes were committed', async () => {
            const rows = await neo4jClient.run<{ sku: string }>(
                'MATCH (:PropmasterTest:Order {runId: $runId})-[:CONTAINS]->(i:PropmasterTest:Item) RETURN i.sku AS sku',
                { runId: RUN_ID },
            );
            expect(rows).toEqual([{ sku: 'SKU-42' }]);
        });
    });

    test('[TC-NEO-006] roll back a transaction when the callback throws', { tag: ['@TC-NEO-006'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Write inside a transaction, then throw', async () => {
            await expect(
                neo4jClient.executeInTransaction(async (tx) => {
                    await tx.run(
                        'CREATE (:PropmasterTest:Order {runId: $runId, orderId: $orderId})',
                        { runId: RUN_ID, orderId: 'ORD-ROLLBACK' },
                    );
                    throw new Error('simulated failure');
                }),
            ).rejects.toThrow(FixtureOperationError);
        });

        await test.step('Step 2: Verify nothing was persisted', async () => {
            const rows = await neo4jClient.run(
                'MATCH (o:PropmasterTest:Order {runId: $runId, orderId: $orderId}) RETURN o',
                { runId: RUN_ID, orderId: 'ORD-ROLLBACK' },
            );
            expect(rows).toHaveLength(0);
        });
    });

    test('[TC-NEO-007] invalid Cypher raises FixtureOperationError', { tag: ['@TC-NEO-007'] }, async ({ neo4jClient }) => {
        await test.step('Step 1: Run a syntactically invalid query', async () => {
            const error = await neo4jClient.run('MATCH (n RETURN n').catch((e: unknown) => e);
            expect(error).toBeInstanceOf(FixtureOperationError);
            expect((error as FixtureOperationError).details.cypher).toBe('MATCH (n RETURN n');
        });
    });
});
