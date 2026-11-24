/**
 * Unit tests for the ClickHouse fixture: names, how insert() finds its rows
 * again, ClickHouse's JSON values as plain ones, engines that can't be undone,
 * error messages, PW_CLICKHOUSE_* variables and the container spec. The
 * behaviour against a real server is covered by tests/examples/clickhouse.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildWhere,
    clickHouseReason,
    comparableType,
    createClickHouseClient,
    identifier,
    splitCredentials,
    splitTable,
    testDatabaseName,
    toPlainValue,
    undoKey,
    undoMode,
} from '../../src/fixtures/clickhouse.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { clickHouseSpec, ContainerManager, DEFAULT_IMAGES } from '../../src/containers/container-manager';
import { FixtureInitError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _ch = AssertHasKey<FixtureTypes, 'clickHouseClient'>;

test.describe('clickhouse — names', () => {
    test('plain identifiers are kept as written (ClickHouse is case-sensitive); anything else is refused', () => {
        expect(identifier('Events', 'table')).toBe('Events');
        expect(() => identifier('events; DROP', 'table')).toThrow(/isn't a plain table name/);
        expect(() => identifier('`quoted`', 'column')).toThrow(/use execute\(\)/);
    });

    test('a table name takes the configured database unless it names one', () => {
        expect(splitTable('events', 'analytics')).toEqual({ database: 'analytics', table: 'events' });
        expect(splitTable('other.events', 'analytics')).toEqual({ database: 'other', table: 'events' });
        expect(() => splitTable('a.b.c', 'analytics')).toThrow(/database\.table/);
    });

    test('a test database name is a valid identifier', () => {
        const name = testDatabaseName('t3-9f2a1c0b');
        expect(name).toBe('propmaster_t3_9f2a1c0b');
        expect(() => identifier(name, 'database')).not.toThrow();
    });
});

test.describe('clickhouse — values', () => {
    test('64-bit and wider integers become numbers, or bigint beyond 2^53; other types are left alone', () => {
        expect(toPlainValue('42', 'UInt64')).toBe(42);
        expect(toPlainValue('-7', 'Nullable(Int64)')).toBe(-7);
        expect(toPlainValue('1152921504606846976', 'UInt64')).toBe(2n ** 60n);
        expect(toPlainValue('340282366920938463463374607431768211455', 'UInt128')).toBe(2n ** 128n - 1n);
        expect(toPlainValue(null, 'Nullable(UInt64)')).toBeNull();
        expect(toPlainValue('2026-01-01 10:00:00', 'DateTime')).toBe('2026-01-01 10:00:00');
        expect(toPlainValue(3, 'UInt32')).toBe(3);
        expect(toPlainValue('12', 'String')).toBe('12');
    });

    test('inside arrays and map values too', () => {
        expect(toPlainValue(['1', '2'], 'Array(UInt64)')).toEqual([1, 2]);
        expect(toPlainValue([['1'], []], 'Array(Array(LowCardinality(Nullable(Int64))))')).toEqual([[1], []]);
        expect(toPlainValue({ a: '5' }, 'Map(String, UInt64)')).toEqual({ a: 5 });
        expect(toPlainValue({ a: ['5'] }, 'Map(LowCardinality(String), Array(Int64))')).toEqual({ a: [5] });
    });
});

test.describe('clickhouse — finding inserted rows again', () => {
    const types = new Map([
        ['id', 'UInt64'], ['name', 'LowCardinality(String)'], ['note', 'Nullable(String)'],
        ['score', 'Float64'], ['attrs', 'Map(String, String)'], ['tags', 'Array(String)'],
    ]);

    test('the key: as given, else id, else every comparable column the row sets', () => {
        expect(undoKey({ id: 1, name: 'a' }, 'name', types)).toEqual(['name']);
        expect(undoKey({ id: 1, name: 'a' }, ['id', 'name'], types)).toEqual(['id', 'name']);
        expect(undoKey({ id: 1, name: 'a' }, undefined, types)).toEqual(['id']);
        expect(undoKey({ name: 'a', score: 1.5, attrs: {}, tags: ['x'], extra: 1 }, undefined, types)).toEqual(['name', 'tags']);
        expect(() => undoKey({}, 'na me', types)).toThrow(/isn't a plain column name/);
    });

    test('floats, maps, JSON and aggregate states are not compared', () => {
        expect(comparableType('Float64')).toBe(false);
        expect(comparableType('Nullable(Float32)')).toBe(false);
        expect(comparableType('Map(String, UInt8)')).toBe(false);
        expect(comparableType('JSON')).toBe(false);
        expect(comparableType('AggregateFunction(uniq, UInt64)')).toBe(false);
        expect(comparableType('Array(String)')).toBe(true);
        expect(comparableType('Decimal(10, 2)')).toBe(true);
        expect(comparableType('DateTime64(3, \'UTC\')')).toBe(true);
    });

    test('the WHERE clause binds typed parameters (no Nullable/LowCardinality wrappers) and matches null with IS NULL', () => {
        expect(buildWhere({ id: 7, name: 'a', note: null }, ['id', 'name', 'note'], types, 'db.t')).toEqual({
            where: 'id = {k0:UInt64} AND name = {k1:String} AND note IS NULL',
            params: { k0: 7, k1: 'a' },
        });
        expect(() => buildWhere({ x: 1 }, ['x'], types, 'db.t')).toThrow(/db\.t has no column x/);
        expect(() => buildWhere({ score: 1 }, [], types, 'db.t')).toThrow(/keep: true/);
    });

    test('MergeTree and Memory rows are deleted, Null keeps nothing, Log can\'t be undone', () => {
        for (const engine of ['MergeTree', 'ReplacingMergeTree', 'ReplicatedMergeTree', 'SharedMergeTree', 'Memory']) expect(undoMode(engine)).toBe('delete');
        expect(undoMode('Null')).toBe('none');
        for (const engine of ['Log', 'TinyLog', 'Distributed']) expect(undoMode(engine)).toEqual({ unsupported: expect.stringContaining('keep: true') });
    });
});

test.describe('clickhouse — errors', () => {
    test('ClickHouse\'s message without the stack trace, with its error type', () => {
        const error = Object.assign(new Error('Unknown table expression identifier \'x\'. Stack trace:\n0. foo\n1. bar'), { code: '60', type: 'UNKNOWN_TABLE' });
        expect(clickHouseReason(error)).toBe('Unknown table expression identifier \'x\'. (UNKNOWN_TABLE)');
        expect(clickHouseReason(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))).toBe('connect ECONNREFUSED 127.0.0.1:1');
        const both = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:8123'), new Error('connect ECONNREFUSED 127.0.0.1:8123')], ''), { code: 'ECONNREFUSED' });
        expect(clickHouseReason(both)).toBe('connect ECONNREFUSED ::1:8123; connect ECONNREFUSED 127.0.0.1:8123');
    });

    test('a server that can\'t be reached is a FixtureInitError naming it, without credentials', async () => {
        const error = await createClickHouseClient({ url: 'http://user:secret@127.0.0.1:1', requestTimeout: 2000 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FixtureInitError);
        expect(String((error as Error).message)).toMatch(/url="http:\/\/127\.0\.0\.1:1".*ECONNREFUSED/);
        expect(String((error as Error).message)).not.toContain('secret');
    });

    test('credentials in the URL are taken out of it', () => {
        expect(splitCredentials('http://app:p%40ss@ch:8123')).toEqual({ url: 'http://ch:8123', username: 'app', password: 'p@ss' });
        expect(splitCredentials('https://ch.example.com:8443/')).toEqual({ url: 'https://ch.example.com:8443/' });
    });

    test('a bad database name is refused before connecting', async () => {
        await expect(createClickHouseClient({ database: 'no-dashes' })).rejects.toThrow(/isn't a plain database name/);
    });
});

test.describe('clickhouse — configuration', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-ch-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { clickhouse: { url: 'http://ch:8123', database: 'file_db' } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_CLICKHOUSE_* variables override environments.json', () => {
        Object.assign(process.env, {
            PW_CLICKHOUSE_URL: 'https://ch.example.com:8443',
            PW_CLICKHOUSE_USERNAME: 'tests',
            PW_CLICKHOUSE_PASSWORD: 'secret',
            PW_CLICKHOUSE_DATABASE: 'analytics',
            PW_CLICKHOUSE_CREATE_DATABASE: 'true',
            PW_CLICKHOUSE_TIMEOUT: '2500',
            PW_CLICKHOUSE_CONTAINER: 'clickhouse/clickhouse-server:25.8',
        });
        expect(new ConfigLoader(dir).load('local').clickhouse).toEqual({
            url: 'https://ch.example.com:8443',
            username: 'tests',
            password: 'secret',
            database: 'analytics',
            createDatabase: true,
            timeout: 2500,
            container: { image: 'clickhouse/clickhouse-server:25.8' },
        });
    });

    test('environments.json alone is enough', () => {
        expect(new ConfigLoader(dir).load('local').clickhouse).toEqual({ url: 'http://ch:8123', database: 'file_db' });
    });
});

test.describe('clickhouse — container', () => {
    test('pinned image, the config\'s credentials (not the default user), no CLICKHOUSE_DB, HTTP health check', () => {
        const { spec, username, password } = clickHouseSpec({ username: 'default', database: 'analytics' }, {});
        expect(DEFAULT_IMAGES.clickhouse).toMatch(/^clickhouse\/clickhouse-server:\d+\.\d+/);
        expect(spec).toMatchObject({ image: DEFAULT_IMAGES.clickhouse, port: 8123, startupTimeoutMs: 60_000 });
        expect({ username, password }).toEqual({ username: 'testuser', password: 'testpass' });
        expect(spec.env).toEqual({ CLICKHOUSE_USER: 'testuser', CLICKHOUSE_PASSWORD: 'testpass', CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' });
        expect(spec.healthCheck).toContain('/ping');
        expect(clickHouseSpec({ username: 'app', password: 'pw' }, { image: 'clickhouse/clickhouse-server:25.8' }).spec).toMatchObject({
            image: 'clickhouse/clickhouse-server:25.8',
            env: { CLICKHOUSE_USER: 'app', CLICKHOUSE_PASSWORD: 'pw' },
        });
    });

    test('the manager returns the config unchanged when container is off', async () => {
        const m = new ContainerManager();
        const config = { url: 'http://ch:8123', container: false };
        expect(await m.clickhouse(config)).toBe(config);
        await m.stopAll();
    });
});
