/**
 * Unit tests for test data factories and automatic cleanup (src/test-data/):
 * the cleanup registry, factories and unique values, the SQL it generates,
 * and each backend's tracking wrapper against in-memory fakes. The last
 * group runs the real fixtures against SQLite to check that data is gone
 * after a test, pass or fail.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as fixtureTest } from '../../src';
import { MissingPackageError } from '../../src/errors';
import {
    CleanupRegistry,
    TestData,
    buildDelete,
    buildInsert,
    defineFactory,
    keyColumns,
    newRunId,
    trackDatabase,
    trackMongo,
    trackNeo4j,
    trackRedis,
} from '../../src/test-data';
import type { DatabaseConnection } from '../../src/fixtures/database.fixture';
import type { MongoDbClient } from '../../src/fixtures/mongodb.fixture';
import type { RedisClient } from '../../src/fixtures/redis.fixture';
import type { Neo4jClient } from '../../src/fixtures/neo4j.fixture';

test.describe('test data — cleanup registry', () => {
    test('runs newest first, keeps going past failures, then reports them all', async () => {
        const registry = new CleanupRegistry();
        const ran: string[] = [];
        registry.add('a', () => ran.push('a'));
        registry.add('b', () => {
            throw new Error('boom');
        });
        registry.add('c', async () => ran.push('c'));
        expect(registry.pending).toEqual(['a', 'b', 'c']);
        await expect(registry.flush()).rejects.toThrow(/testData.*cleanup.*b: boom/);
        expect(ran).toEqual(['c', 'a']);
        expect(registry.pending).toEqual([]);
        await registry.flush(); // nothing left: a second flush (the next client's teardown) is a no-op
    });
});

test.describe('test data — factories', () => {
    const user = defineFactory('user', (f) => ({ email: f.email('user'), name: `User ${f.seq}`, active: true }));

    test('unique values carry the run ID and never repeat', () => {
        const data = new TestData(new CleanupRegistry(), { runId: 't2-abcd0123' });
        expect(data.unique('order')).toBe('order-t2-abcd0123-1');
        expect(data.email()).toBe('user-t2-abcd0123-2@example.test');
        expect(data.email('ann', 'corp.test')).toBe('ann-t2-abcd0123-3@corp.test');
    });

    test('run IDs are unique across workers and runs', () => {
        expect(newRunId(3)).toMatch(/^t3-[0-9a-f]{8}$/);
        const ids = new Set(Array.from({ length: 2000 }, (_, i) => newRunId(i % 8)));
        expect(ids.size).toBe(2000);
        const a = new TestData(undefined, { runId: newRunId(0) }).build(user);
        const b = new TestData(undefined, { runId: newRunId(1) }).build(user);
        expect(a.email).not.toBe(b.email); // same seq, different workers
    });

    test('build merges overrides; buildMany takes a function of the index', () => {
        const data = new TestData(undefined, { runId: 'r' });
        expect(data.build(user, { name: 'Alice' })).toEqual({ email: 'user-r-2@example.test', name: 'Alice', active: true });
        const many = data.buildMany(user, 3, (u, i) => ({ active: i !== 1, name: `${u.name}!` }));
        expect(many.map((u) => [u.name, u.active])).toEqual([
            ['User 3!', true],
            ['User 5!', false],
            ['User 7!', true],
        ]);
        expect(new Set(many.map((u) => u.email)).size).toBe(3);
    });

    test('define registers a factory by name; an unknown name lists the defined ones', () => {
        const data = new TestData(undefined, { runId: 'r' });
        data.define('order', (f) => ({ ref: f.unique('ord'), total: 10 }));
        expect(data.build<{ ref: string; total: number }>('order', { total: 5 })).toEqual({ ref: 'ord-r-2', total: 5 });
        expect(() => data.build('customer')).toThrow(/no factory named .*customer.*; defined: order/);
    });

    test('faker: given when installed, MissingPackageError when not', async () => {
        const { faker } = await import('@faker-js/faker');
        const withFaker = new TestData(undefined, { faker });
        const person = withFaker.build(defineFactory('p', (f) => ({ name: f.faker.person.fullName() as string })));
        expect(person.name.length).toBeGreaterThan(0);

        const without = new TestData();
        expect(() => without.faker).toThrow(MissingPackageError);
        expect(() => without.build(defineFactory('p', (f) => ({ n: f.faker })))).toThrow(/@faker-js\/faker/);
        expect(without.build(user).active).toBe(true); // factories that don't use faker still work
    });

    test('cleanup() adds custom undo actions to the same stack', async () => {
        const registry = new CleanupRegistry(false); // autoCleanup off still runs explicit cleanups
        const data = new TestData(registry);
        const ran: string[] = [];
        data.cleanup(() => ran.push('anonymous'));
        data.cleanup('delete the API user', () => ran.push('labelled'));
        expect(data.pendingCleanups).toEqual(['testData.cleanup', 'delete the API user']);
        await data.flushCleanups();
        expect(ran).toEqual(['labelled', 'anonymous']);
    });
});

test.describe('test data — SQL', () => {
    test('INSERT is parameterized, multi-row, with missing columns as NULL', () => {
        expect(buildInsert('app.users', [{ id: 1, email: 'a' }, { id: 2, name: 'B' }])).toEqual({
            sql: 'INSERT INTO app.users (id, email, name) VALUES ($1, $2, $3), ($4, $5, $6)',
            params: [1, 'a', null, 2, null, 'B'],
            columns: ['id', 'email', 'name'],
        });
    });

    test('DELETE matches the key columns, NULLs with IS NULL', () => {
        expect(buildDelete('users', { email: 'a', team: null }, ['email', 'team'])).toEqual({
            sql: 'DELETE FROM users WHERE email = $1 AND team IS NULL',
            params: ['a'],
        });
    });

    test('key columns: explicit key, else id, else every inserted column', () => {
        expect(keyColumns([{ id: 1, a: 1 }], ['id', 'a'], 'a')).toEqual(['a']);
        expect(keyColumns([{ id: 1, a: 1 }], ['id', 'a'])).toEqual(['id']);
        expect(keyColumns([{ id: 1 }, { a: 1 }], ['id', 'a'])).toEqual(['id', 'a']);
    });

    test('table and column names must be plain identifiers', () => {
        expect(() => buildInsert('users; DROP TABLE x', [{ a: 1 }])).toThrow(/isn't a plain table name/);
        expect(() => buildInsert('users', [{ 'a) --': 1 }])).toThrow(/isn't a plain column name/);
        expect(() => buildInsert('users', [{}])).toThrow(/no columns/);
    });
});

test.describe('test data — tracking per backend', () => {
    test('database: insert records a DELETE per row, newest first; keep and autoCleanup opt out', async () => {
        const executed: [string, unknown[] | undefined][] = [];
        const conn: DatabaseConnection = {
            query: async () => [],
            execute: async (sql, params) => (executed.push([sql, params]), { affectedRows: 1 }),
            close: async () => {},
        };
        const registry = new CleanupRegistry();
        const db = trackDatabase(conn, registry);
        await db.insert('users', [{ id: 1 }, { id: 2 }]);
        await db.insert('users', { email: 'kept' }, { keep: true });
        await db.insert('audit', { ref: 'x', at: null }, { key: 'ref' });
        expect(await db.insert('users', [])).toEqual({ affectedRows: 0 });
        await db.execute('UPDATE users SET a = 1'); // raw SQL isn't tracked
        expect(registry.pending).toEqual(['database users: 2 row(s)', 'database audit: 1 row(s)']);

        executed.length = 0;
        await registry.flush();
        expect(executed).toEqual([
            ['DELETE FROM audit WHERE ref = $1', ['x']],
            ['DELETE FROM users WHERE id = $1', [2]],
            ['DELETE FROM users WHERE id = $1', [1]],
        ]);

        const off = trackDatabase(conn, new CleanupRegistry(false));
        await off.insert('users', { id: 3 });
        expect(executed.at(-1)?.[0]).toMatch(/^INSERT/);
    });

    test('mongodb: inserts are deleted by _id; keep opts out', async () => {
        const deleted: [string, unknown][] = [];
        const fake = {
            insertOne: async () => ({ insertedId: 'id-1', acknowledged: true }),
            insertMany: async () => ({ insertedIds: { 0: 'id-2', 1: 'id-3' }, insertedCount: 2, acknowledged: true }),
            deleteMany: async (c: string, f: unknown) => (deleted.push([c, f]), { deletedCount: 1, acknowledged: true }),
            find: async () => [],
        } as unknown as MongoDbClient;
        const registry = new CleanupRegistry();
        const mongo = trackMongo(fake, registry);
        await mongo.insertOne('users', { a: 1 });
        await mongo.insertMany('orders', [{}, {}]);
        await mongo.insertOne('config', { a: 1 }, { keep: true });
        expect(await mongo.find('users')).toEqual([]); // other methods pass through
        await registry.flush();
        expect(deleted).toEqual([
            ['orders', { _id: { $in: ['id-2', 'id-3'] } }],
            ['users', { _id: { $in: ['id-1'] } }],
        ]);
    });

    test('redis: a new key is deleted, an existing one gets its old value back', async () => {
        const store = new Map<string, string>([['existing', 'old']]);
        const fake = {
            get: async (k: string) => store.get(k) ?? null,
            set: async (k: string, v: string) => void store.set(k, v),
            del: async (k: string) => Number(store.delete(k)),
        } as unknown as RedisClient;
        const registry = new CleanupRegistry();
        const redis = trackRedis(fake, registry);
        await redis.set('fresh', '1');
        await redis.set('fresh', '2'); // set twice: undone in reverse, still ends deleted
        await redis.set('existing', 'new', 60);
        await redis.set('kept', 'x', undefined, { keep: true });
        expect(Object.fromEntries(store)).toEqual({ existing: 'new', fresh: '2', kept: 'x' });
        await registry.flush();
        expect(Object.fromEntries(store)).toEqual({ existing: 'old', kept: 'x' });
    });

    test('neo4j: writes with a runId detach-delete that runId once; transactions too', async () => {
        const writes: [string, unknown][] = [];
        const fake = {
            write: async (c: string, p?: unknown) => (writes.push([c, p]), { nodesCreated: 1 }),
            executeInTransaction: async (fn: (tx: { run: (c: string, p?: unknown) => Promise<unknown[]> }) => Promise<unknown>) => fn({ run: async () => [] }),
        } as unknown as Neo4jClient;
        const registry = new CleanupRegistry();
        const neo = trackNeo4j(fake, registry);
        await neo.write('CREATE (:A {runId: $runId})', { runId: 'r1' });
        await neo.write('CREATE (:B {runId: $runId})', { runId: 'r1' });
        await neo.write('CREATE (:C)'); // no runId: not tracked
        await neo.write('CREATE (:D {runId: $runId})', { runId: 'r2' }, { keep: true });
        await neo.executeInTransaction(async (tx) => tx.run('CREATE (:E {runId: $runId})', { runId: 'r3' }));
        expect(registry.pending).toEqual(['neo4j nodes with runId r1', 'neo4j nodes with runId r3']);
        writes.length = 0;
        await registry.flush();
        expect(writes).toEqual([
            ['MATCH (n {runId: $runId}) DETACH DELETE n', { runId: 'r3' }],
            ['MATCH (n {runId: $runId}) DETACH DELETE n', { runId: 'r1' }],
        ]);
    });
});

/* ── The real fixtures, against SQLite: data is gone after the test, pass or fail ── */

const dbFile = path.join(os.tmpdir(), `propmaster-test-data-${process.pid}.sqlite`);

fixtureTest.describe('test data — fixture lifecycle (SQLite)', () => {
    fixtureTest.describe.configure({ mode: 'serial' });
    fixtureTest.use({ database: { type: 'sqlite', database: dbFile } });

    fixtureTest.beforeAll(async () => {
        const { default: Sqlite } = await import('better-sqlite3');
        const db = new Sqlite(dbFile);
        db.exec('DROP TABLE IF EXISTS users; CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT)');
        db.close();
    });
    fixtureTest.afterAll(() => fs.rmSync(dbFile, { force: true }));

    const user = defineFactory('user', (f) => ({ email: f.email('user'), name: `User ${f.seq}` }));
    let failedEmail = '';

    fixtureTest('a failing test still has its rows removed', async ({ databaseClient, testData }) => {
        fixtureTest.fail(); // expected to fail: the teardown must clean up anyway
        const row = testData.build(user);
        failedEmail = row.email;
        await databaseClient.insert('users', row); // generated id: deleted by every inserted column
        expect(await databaseClient.query('SELECT * FROM users WHERE email = $1', [row.email])).toHaveLength(1);
        throw new Error('the test fails after inserting');
    });

    fixtureTest('rows inserted by the previous test are gone; kept rows and custom cleanups', async ({ databaseClient, testData }) => {
        expect(await databaseClient.query('SELECT * FROM users WHERE email = $1', [failedEmail])).toEqual([]);

        await databaseClient.insert('users', testData.buildMany(user, 3));
        const kept = testData.build(user, { name: 'kept' });
        await databaseClient.insert('users', kept, { keep: true });
        await databaseClient.execute('INSERT INTO users (email, name) VALUES ($1, $2)', [testData.email('raw'), 'raw']);
        testData.cleanup('delete the raw row', () => databaseClient.execute("DELETE FROM users WHERE name = 'raw'"));
        expect(await databaseClient.query('SELECT * FROM users')).toHaveLength(5);

        await testData.flushCleanups();
        expect(await databaseClient.query<{ name: string }>('SELECT name FROM users')).toEqual([{ name: 'kept' }]);
    });

    fixtureTest.describe('autoCleanup: false (e.g. a seeding project)', () => {
        fixtureTest.use({ autoCleanup: false });

        fixtureTest('inserts stay', async ({ databaseClient }) => {
            await databaseClient.insert('users', { email: 'seed@example.test', name: 'seed' });
        });
    });

    fixtureTest('seeded rows are still there', async ({ databaseClient }) => {
        expect(await databaseClient.query<{ name: string }>('SELECT name FROM users ORDER BY name')).toEqual([{ name: 'kept' }, { name: 'seed' }]);
    });
});
