/**
 * Unit tests for the Testcontainers integration (src/containers/container-manager.ts)
 * and its PW_*_CONTAINER variables. These cover the pure parts — specs, parsing,
 * config mapping — and need no Docker. Real containers are exercised by the
 * example suites with PW_<BACKEND>_CONTAINER=true (see the "Testcontainers" CI job).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigLoader } from '../../src/config/loader';
import {
    withStartupBudget,
    ContainerManager,
    DEFAULT_IMAGES,
    containerOptions,
    databaseSpec,
    freePort,
    kafkaSpec,
    meetsMssqlPasswordPolicy,
    mongoDbSpec,
    neo4jSpec,
    parseContainerEnv,
    redisSpec,
} from '../../src/containers/container-manager';
import { FixtureInitError } from '../../src/errors';

test.describe('containers — options and env parsing', () => {
    test('parseContainerEnv: booleans and image names', () => {
        for (const v of ['true', 'TRUE', '1', 'yes', 'on']) expect(parseContainerEnv(v)).toBe(true);
        for (const v of ['false', '0', 'no', 'off', '', '  ']) expect(parseContainerEnv(v)).toBe(false);
        expect(parseContainerEnv('postgres:16-alpine')).toEqual({ image: 'postgres:16-alpine' });
    });

    test('containerOptions normalises the setting', () => {
        expect(containerOptions(undefined)).toBeNull();
        expect(containerOptions(false)).toBeNull();
        expect(containerOptions(true)).toEqual({});
        expect(containerOptions({ image: 'redis:8' })).toEqual({ image: 'redis:8' });
    });

    test('MSSQL password policy', () => {
        expect(meetsMssqlPasswordPolicy('TestPass123!')).toBe(true);
        expect(meetsMssqlPasswordPolicy('test')).toBe(false);
        expect(meetsMssqlPasswordPolicy('alllowercase1')).toBe(false); // two classes
        expect(meetsMssqlPasswordPolicy('Ab1!')).toBe(false); // too short
    });
});

test.describe('containers — specs', () => {
    test('PostgreSQL: config credentials, TCP readiness, ordered init scripts', () => {
        const { spec, resolved } = databaseSpec(
            { type: 'postgresql', database: 'app', username: 'u', password: 'p' },
            { initScripts: ['sql/a.sql', 'sql/b.sql'] },
        );
        expect(spec.image).toBe(DEFAULT_IMAGES.postgresql);
        expect(spec.env).toEqual({ POSTGRES_DB: 'app', POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p' });
        expect(spec.healthCheck).toContain('-h 127.0.0.1');
        expect(spec.files).toEqual([
            [path.resolve('sql/a.sql'), '/docker-entrypoint-initdb.d/01-a.sql'],
            [path.resolve('sql/b.sql'), '/docker-entrypoint-initdb.d/02-b.sql'],
        ]);
        expect(resolved).toMatchObject({ database: 'app', username: 'u', password: 'p' });
        expect(spec.startupTimeoutMs).toBe(60_000);
    });

    test('defaults fill in missing credentials; custom image and timeout apply', () => {
        const { spec, resolved } = databaseSpec({ type: 'mysql', database: '' }, { image: 'mysql:8.4', startupTimeout: 90 });
        expect(resolved).toMatchObject({ database: 'testdb', username: 'testuser', password: 'testpass' });
        expect(spec.image).toBe('mysql:8.4');
        expect(spec.startupTimeoutMs).toBe(90_000);
        expect(spec.env.MYSQL_USER).toBe('testuser');
    });

    test('MySQL root user sets only the root password', () => {
        const { spec } = databaseSpec({ type: 'mysql', database: 'd', username: 'root', password: 'pw' }, {});
        expect(spec.env).toEqual({ MYSQL_DATABASE: 'd', MYSQL_ROOT_PASSWORD: 'pw' });
    });

    test('MSSQL: sa login, no TLS checks, longer start-up, weak password rejected up front', () => {
        const { spec, resolved } = databaseSpec({ type: 'mssql', database: 'app', username: 'someone' }, {});
        expect(resolved).toMatchObject({ username: 'sa', password: 'TestPass123!', database: 'app', encrypt: false, trustServerCertificate: true });
        expect(spec.startupTimeoutMs).toBe(120_000);
        expect(() => databaseSpec({ type: 'mssql', database: 'app', password: 'test' }, {})).toThrow(/too weak/);
    });

    test('SQLite has no container', () => {
        expect(() => databaseSpec({ type: 'sqlite', database: 'x.db' }, {})).toThrow(FixtureInitError);
    });

    test('Redis with a password starts the server with requirepass', () => {
        expect(redisSpec({ host: '', port: 0 }, {}).command).toBeUndefined();
        const spec = redisSpec({ host: '', port: 0, password: 's3cret' }, {});
        expect(spec.command).toEqual(['redis-server', '--requirepass', 's3cret']);
        expect(spec.healthCheck).toContain("-a 's3cret'");
    });

    test('MongoDB sets a root user only when the config has one', () => {
        expect(mongoDbSpec({ database: 'd' }, {}).env).toEqual({});
        expect(mongoDbSpec({ database: 'd', username: 'admin', password: 'pw' }, {}).env).toEqual({
            MONGO_INITDB_ROOT_USERNAME: 'admin',
            MONGO_INITDB_ROOT_PASSWORD: 'pw',
        });
    });

    test('Neo4j needs an 8+ character password', () => {
        expect(neo4jSpec({ uri: '', username: '', password: '' }, {}).password).toBe('testpassword');
        expect(() => neo4jSpec({ uri: '', username: 'neo4j', password: 'short' }, {})).toThrow(/8 characters/);
    });

    test('Kafka advertises the host port and health-checks an internal listener', () => {
        const spec = kafkaSpec({ reuse: true }, 'localhost', 41234);
        expect(spec.hostPort).toBe(41234);
        expect(spec.reuse).toBe(false);
        expect(spec.env.KAFKA_ADVERTISED_LISTENERS).toBe('INTERNAL://localhost:19092,HOST://localhost:41234');
        expect(spec.healthCheck).toContain('localhost:19092');
    });

    test('quotes shell arguments in health checks', () => {
        const { spec } = databaseSpec({ type: 'postgresql', database: "it's", username: 'u' }, {});
        expect(spec.healthCheck).toContain(`-d 'it'\\''s'`);
    });

    test('freePort returns a usable port', async () => {
        const port = await freePort();
        expect(port).toBeGreaterThan(0);
    });
});

test.describe('containers — manager without containers', () => {
    test('returns configs unchanged and starts nothing when container is off', async () => {
        const m = new ContainerManager();
        const db = { type: 'postgresql' as const, database: 'd', host: 'db', port: 5432 };
        expect(await m.database(db)).toBe(db);
        expect(await m.database({ type: 'sqlite', database: 'x.db', container: true })).toEqual({ type: 'sqlite', database: 'x.db', container: true });
        const redis = { host: 'r', port: 6379, container: false };
        expect(await m.redis(redis)).toBe(redis);
        await m.stopAll();
    });
});

test.describe('containers — PW_*_CONTAINER variables', () => {
    let dir: string;
    const saved = { ...process.env };

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagehand-containers-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: {} } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('turn containers on per backend, or pick an image', () => {
        Object.assign(process.env, {
            PW_DB_CONTAINER: 'true',
            PW_REDIS_CONTAINER: 'redis:8',
            PW_MONGODB_CONTAINER: '1',
            PW_NEO4J_CONTAINER: 'false',
            PW_KAFKA_CONTAINER: 'yes',
        });
        const config = new ConfigLoader(dir).load('local');
        expect(config.database?.container).toBe(true);
        expect(config.redis?.container).toEqual({ image: 'redis:8' });
        expect(config.mongodb?.container).toBe(true);
        expect(config.neo4j?.container).toBe(false);
        expect(config.kafka?.container).toBe(true);
    });

    test('PW_DB_CONTAINER_INIT adds init scripts whatever the variable order', () => {
        // Insert INIT first, so it is iterated before PW_DB_CONTAINER.
        process.env.PW_DB_CONTAINER_INIT = 'sql/a.sql, sql/b.sql';
        process.env.PW_DB_CONTAINER = 'postgres:16';
        const config = new ConfigLoader(dir).load('local');
        expect(config.database?.container).toEqual({ image: 'postgres:16', initScripts: ['sql/a.sql', 'sql/b.sql'] });
    });

    test('PW_DB_CONTAINER_INIT alone does not turn a container on', () => {
        process.env.PW_DB_CONTAINER_INIT = 'sql/a.sql';
        process.env.PW_DB_TYPE = 'postgresql';
        const config = new ConfigLoader(dir).load('local');
        expect(config.database?.container).toBeUndefined();
    });
});

test.describe('containers — startup time does not count against the test timeout', () => {
    test('a start longer than the test timeout still passes; the timeout grows by the time it took', async () => {
        test.setTimeout(1_000);
        const slowStart = new Promise((r) => setTimeout(() => r('up'), 1_500));
        await expect(withStartupBudget(slowStart, 10_000)).resolves.toBe('up');
        const timeout = test.info().timeout;
        expect(timeout).toBeGreaterThanOrEqual(2_400);
        expect(timeout).toBeLessThan(5_000); // the unused budget is handed back
    });

    test('a failed start is rethrown and the budget handed back', async () => {
        test.setTimeout(5_000);
        await expect(withStartupBudget(Promise.reject(new Error('no docker')), 60_000)).rejects.toThrow('no docker');
        expect(test.info().timeout).toBeLessThan(6_000);
    });
});
