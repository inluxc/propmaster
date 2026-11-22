/**
 * Unit tests for the Cassandra / ScyllaDB fixture: names, statements built
 * for insert() and its undo, driver values as plain ones, error messages,
 * PW_CASSANDRA_* variables and the container spec. The behaviour against a
 * real node is covered by tests/examples/cassandra.spec.ts (ScyllaDB).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { types } from 'cassandra-driver';
import {
    buildCqlInsert,
    cassandraReason,
    createCassandraClient,
    identifier,
    keyWhere,
    replicationCql,
    splitTable,
    testKeyspaceName,
    toDriverParams,
    toPlainValue,
} from '../../src/fixtures/cassandra.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { cassandraSpec, ContainerManager, DEFAULT_IMAGES } from '../../src/containers/container-manager';
import { FixtureInitError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _cas = AssertHasKey<FixtureTypes, 'cassandraClient'>;

test.describe('cassandra — names', () => {
    test('plain identifiers are lowercased as Cassandra folds them; anything else is refused', () => {
        expect(identifier('Orders', 'table')).toBe('orders');
        expect(() => identifier('orders; DROP', 'table')).toThrow(/isn't a plain table name/);
        expect(() => identifier('"Quoted"', 'column')).toThrow(/use execute\(\)/);
    });

    test('a table name takes the session keyspace unless it names one', () => {
        expect(splitTable('orders', 'shop')).toEqual({ keyspace: 'shop', table: 'orders' });
        expect(splitTable('Sales.Orders', 'shop')).toEqual({ keyspace: 'sales', table: 'orders' });
        expect(() => splitTable('orders', undefined)).toThrow(/has no keyspace: write keyspace.orders, or set cassandra.keyspace/);
        expect(() => splitTable('a.b.c', 'x')).toThrow(/use table or keyspace.table/);
    });

    test('a test keyspace name is a valid identifier of at most 48 characters', () => {
        expect(testKeyspaceName('t3-9f2a1c0b')).toBe('propmaster_t3_9f2a1c0b');
        expect(testKeyspaceName('x'.repeat(80))).toHaveLength(48);
    });

    test('replication becomes a CQL map; a class is required and odd characters refused', () => {
        expect(replicationCql({ class: 'NetworkTopologyStrategy', replication_factor: 1 })).toBe("{'class': 'NetworkTopologyStrategy', 'replication_factor': 1}");
        expect(replicationCql({ class: 'NetworkTopologyStrategy', dc1: 3, dc2: '2' })).toBe("{'class': 'NetworkTopologyStrategy', 'dc1': 3, 'dc2': '2'}");
        expect(() => replicationCql({ replication_factor: 1 })).toThrow(/needs a class/);
        expect(() => replicationCql({ class: "x'; DROP" })).toThrow(/characters CQL doesn't allow/);
    });
});

test.describe('cassandra — statements for insert()', () => {
    test('one ? per column, with IF NOT EXISTS and USING TTL in the right order; undefined columns left out', () => {
        expect(buildCqlInsert('shop', 'orders', { customer_id: 'c', total: 3, note: undefined }, { ifNotExists: true, ttl: 60 })).toEqual({
            cql: 'INSERT INTO shop.orders (customer_id, total) VALUES (?, ?) IF NOT EXISTS USING TTL 60',
            params: ['c', 3],
        });
        expect(() => buildCqlInsert('shop', 'orders', {})).toThrow(/no columns/);
        expect(() => buildCqlInsert('shop', 'orders', { a: 1 }, { ttl: 1.5 })).toThrow(/whole number of seconds/);
        expect(() => buildCqlInsert('shop', 'orders', { 'a-b': 1 })).toThrow(/isn't a plain column name/);
    });

    test('the undo picks the row by its whole primary key and names missing parts', () => {
        const key = { partitionKeys: ['customer_id'], clusteringKeys: ['ordered_at'] };
        const at = new Date(0);
        expect(keyWhere({ Customer_Id: 'c', ordered_at: at, total: 1 }, key, 'shop.orders')).toEqual({ where: 'customer_id = ? AND ordered_at = ?', params: ['c', at] });
        expect(() => keyWhere({ customer_id: 'c' }, key, 'shop.orders')).toThrow('the row has no ordered_at, part of the primary key of shop.orders (customer_id, ordered_at)');
    });
});

test.describe('cassandra — values', () => {
    test('driver types become strings and numbers; large integers stay exact as bigint', () => {
        const uuid = types.Uuid.random();
        const row = {
            id: uuid,
            seen: types.TimeUuid.now(),
            ip: types.InetAddress.fromString('10.0.0.1'),
            day: types.LocalDate.fromString('2026-01-31'),
            at: types.LocalTime.fromString('10:30:00'),
            total: types.BigDecimal.fromString('12.30'),
            qty: types.Long.fromNumber(42),
            huge: types.Long.fromString('9007199254740993'),
            big: types.Integer.fromString('123'),
            pair: new types.Tuple('a', types.Long.fromNumber(1)),
            tags: ['x'],
            attrs: { k: types.Long.fromNumber(2) },
            when: new Date(0),
            blob: Buffer.from([1]),
            missing: undefined,
        };
        expect(toPlainValue(row)).toEqual({
            id: uuid.toString(),
            seen: String(row.seen),
            ip: '10.0.0.1',
            day: '2026-01-31',
            at: '10:30:00',
            total: '12.30',
            qty: 42,
            huge: 9007199254740993n,
            big: 123,
            pair: ['a', 1],
            tags: ['x'],
            attrs: { k: 2 },
            when: new Date(0),
            blob: Buffer.from([1]),
            missing: null,
        });
        expect(toPlainValue(5n)).toBe(5);
    });

    test('BigInt params go to the driver as decimal strings, nested too', () => {
        expect(toDriverParams([1n, [2n], { a: 3n }, 'x'])).toEqual(['1', ['2'], { a: '3' }, 'x']);
        expect(toDriverParams({ id: 9007199254740993n })).toEqual({ id: '9007199254740993' });
        expect(toDriverParams(undefined)).toBeUndefined();
    });
});

test.describe('cassandra — errors', () => {
    test('"no host available" lists every node with its reason', () => {
        const error = Object.assign(new Error('All host(s) tried for query failed.'), {
            name: 'NoHostAvailableError',
            innerErrors: { '127.0.0.1:9042': new Error('connect ECONNREFUSED'), '::1:9042': new Error('timeout') },
        });
        expect(cassandraReason(error)).toBe('no node answered: 127.0.0.1:9042 (connect ECONNREFUSED); ::1:9042 (timeout)');
        expect(cassandraReason(new Error('unconfigured table nope'))).toBe('unconfigured table nope');
    });

    test('a node that can\'t be reached is a FixtureInitError naming it, and the process can exit', async () => {
        const error = await createCassandraClient({ contactPoints: ['127.0.0.1'], port: 1, connectTimeout: 2000 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FixtureInitError);
        expect((error as Error).message).toContain('127.0.0.1:1');
        expect((error as Error).message).toContain('ECONNREFUSED');
    });

    test('a bad keyspace name is refused before connecting', async () => {
        await expect(createCassandraClient({ keyspace: 'shop-1' })).rejects.toThrow(/isn't a plain keyspace name/);
    });
});

test.describe('cassandra — configuration', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-cas-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { cassandra: { contactPoints: ['db1'], keyspace: 'file_ks' } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_CASSANDRA_* variables override environments.json', () => {
        Object.assign(process.env, {
            PW_CASSANDRA_CONTACT_POINTS: 'node1:9043, node2',
            PW_CASSANDRA_PORT: '9044',
            PW_CASSANDRA_LOCAL_DC: 'eu-west',
            PW_CASSANDRA_KEYSPACE: 'shop',
            PW_CASSANDRA_CREATE_KEYSPACE: 'true',
            PW_CASSANDRA_USERNAME: 'tests',
            PW_CASSANDRA_PASSWORD: 'secret',
            PW_CASSANDRA_CONSISTENCY: 'localQuorum',
            PW_CASSANDRA_TIMEOUT: '2500',
            PW_CASSANDRA_CONTAINER: 'true',
        });
        expect(new ConfigLoader(dir).load('local').cassandra).toEqual({
            contactPoints: ['node1:9043', 'node2'],
            port: 9044,
            localDataCenter: 'eu-west',
            keyspace: 'shop',
            createKeyspace: true,
            username: 'tests',
            password: 'secret',
            consistency: 'localQuorum',
            timeout: 2500,
            container: true,
        });
    });

    test('environments.json alone is enough', () => {
        expect(new ConfigLoader(dir).load('local').cassandra).toEqual({ contactPoints: ['db1'], keyspace: 'file_ks' });
    });
});

test.describe('cassandra — container', () => {
    test('ScyllaDB by default: pinned image, one core in developer mode, cqlsh health check', () => {
        const spec = cassandraSpec({});
        expect(DEFAULT_IMAGES.scylla).toMatch(/^scylladb\/scylla:\d+\.\d+\.\d+$/);
        expect(spec).toMatchObject({ image: DEFAULT_IMAGES.scylla, port: 9042, env: {}, startupTimeoutMs: 120_000 });
        expect(spec.command).toEqual(['--smp', '1', '--memory', '750M', '--overprovisioned', '1', '--developer-mode', '1']);
        expect(spec.healthCheck).toContain('cqlsh');
    });

    test('a Cassandra image gets a small heap and no ScyllaDB flags', () => {
        for (const image of ['cassandra:5', 'docker.io/library/cassandra:4.1']) {
            const spec = cassandraSpec({ image });
            expect(spec.command).toBeUndefined();
            expect(spec.env).toMatchObject({ MAX_HEAP_SIZE: '512M' });
        }
    });

    test('the manager returns the config unchanged when container is off', async () => {
        const m = new ContainerManager();
        const config = { contactPoints: ['db'], container: false };
        expect(await m.cassandra(config)).toBe(config);
        await m.stopAll();
    });
});
