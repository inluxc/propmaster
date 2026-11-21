/**
 * The tools the Propmaster MCP server offers: read tools for every configured
 * backend, the test-convention tools, and write tools when writes are allowed.
 *
 * Each backend connects on its first call and stays connected until the server
 * stops. A backend that isn't configured answers with how to configure it.
 */

import { randomBytes } from 'node:crypto';
import type { FrameworkConfig } from '../config/schema.js';
import { collect, nextIds } from '../cli/check-tests.js';
import { loadOptional } from '../fixtures/optional-package.js';
import { createDatabaseClient, type DatabaseConnection } from '../fixtures/database.fixture.js';
import { createRedisClient } from '../fixtures/redis.fixture.js';
import { createMongoDbClient } from '../fixtures/mongodb.fixture.js';
import type { MongoDbClient } from '../fixtures/mongodb.fixture.js';
import { createNeo4jDriver, toPlain } from '../fixtures/neo4j.fixture.js';
import { createOtpClient } from '../fixtures/otp.fixture.js';
import { loadOpenApiDocument } from '../openapi/load.js';
import { readOnlySqlProblem, writingPipelineStage } from './guards.js';
import { ToolInputError, type ToolDefinition } from './protocol.js';

type Redis = Awaited<ReturnType<typeof createRedisClient>>['client'];
type Neo4jDriver = Awaited<ReturnType<typeof createNeo4jDriver>>;

export interface McpContext {
    /** Project root: where environments.json and the tests live. */
    root: string;
    /** Active environment name. */
    environment: string;
    /** The loaded configuration, or undefined when it couldn't be loaded. */
    config: FrameworkConfig | undefined;
    /** Why the configuration couldn't be loaded. */
    configError?: string;
    /** Write tools are offered. */
    allowWrites: boolean;
}

const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;
const MAX_VALUE_CHARS = 10_000;
const KAFKA_PEEK_TIMEOUT_MS = 10_000;

/** Holds each backend's connection, opened on first use. */
export class Connections {
    private readonly open = new Map<string, Promise<unknown>>();
    private readonly closers = new Map<string, () => Promise<void>>();

    get<T>(name: string, connect: () => Promise<{ value: T; close: () => Promise<void> }>): Promise<T> {
        let pending = this.open.get(name) as Promise<T> | undefined;
        if (!pending) {
            pending = connect().then(({ value, close }) => {
                this.closers.set(name, close);
                return value;
            });
            // A failed connect is retried on the next call.
            pending.catch(() => this.open.delete(name));
            this.open.set(name, pending);
        }
        return pending;
    }

    async closeAll(): Promise<void> {
        const closers = [...this.closers.values()];
        this.closers.clear();
        this.open.clear();
        await Promise.allSettled(closers.map((close) => close()));
    }
}

// ─── Argument helpers ───────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.trim() === '') throw new ToolInputError(`"${key}" must be a non-empty string`);
    return value;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
    return value;
}

function count(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
    const value = args[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolInputError(`"${key}" must be a positive integer`);
    return Math.min(value, max);
}

function obj(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError(`"${key}" must be an object`);
    return value as Record<string, unknown>;
}

function arr(args: Record<string, unknown>, key: string, required = false): unknown[] | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        if (required) throw new ToolInputError(`"${key}" is required`);
        return undefined;
    }
    if (!Array.isArray(value)) throw new ToolInputError(`"${key}" must be an array`);
    return value;
}

function limitRows<T>(rows: T[], max: number): { rowCount: number; rows: T[]; truncated?: true } {
    return rows.length > max ? { rowCount: rows.length, rows: rows.slice(0, max), truncated: true } : { rowCount: rows.length, rows };
}

function clip(value: string): string {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}… [${value.length - MAX_VALUE_CHARS} more characters]` : value;
}

/** Message bodies: JSON when they parse, else the (clipped) text. */
function decode(value: string | null | undefined): unknown {
    if (value === null || value === undefined) return null;
    try {
        return JSON.parse(value);
    } catch {
        return clip(value);
    }
}

function notConfigured(backend: string, hint: string): never {
    throw new ToolInputError(`${backend} isn't configured for this environment. ${hint}`);
}

const PARAMS_SCHEMA = { type: 'array', description: 'Positional parameters for $1/? placeholders', items: {} };
const ROWS_SCHEMA = { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: `Rows to return (default ${DEFAULT_ROWS})` };

// ─── Tools ──────────────────────────────────────────────────────────────────

export function createTools(ctx: McpContext, connections: Connections): ToolDefinition[] {
    const config = ctx.config;
    // ── Connections ──
    const database = (): Promise<DatabaseConnection> => {
        const db = config?.database;
        if (!db) notConfigured('The database', 'Add "database" to environments.json or set PW_DB_TYPE, PW_DB_HOST, ...');
        return connections.get('database', async () => {
            const conn = await createDatabaseClient(db);
            return { value: conn, close: () => conn.close() };
        });
    };

    const redis = (): Promise<{ client: Redis; prefix: string }> => {
        const rc = config?.redis;
        if (!rc) notConfigured('Redis', 'Add "redis" to environments.json or set PW_REDIS_HOST.');
        return connections.get('redis', async () => {
            const { client, subscriber } = await createRedisClient(rc);
            subscriber?.disconnect();
            return { value: { client, prefix: rc.keyPrefix ?? '' }, close: async () => { client.disconnect(); } };
        });
    };

    const mongo = (): Promise<MongoDbClient> => {
        const mc = config?.mongodb;
        if (!mc) notConfigured('MongoDB', 'Add "mongodb" to environments.json or set PW_MONGODB_URI.');
        return connections.get('mongodb', async () => {
            const client = await createMongoDbClient(mc);
            return { value: client, close: () => client.close() };
        });
    };

    const neo4j = (): Promise<Neo4jDriver> => {
        const nc = config?.neo4j;
        if (!nc) notConfigured('Neo4j', 'Add "neo4j" to environments.json or set PW_NEO4J_URI.');
        return connections.get('neo4j', async () => {
            const driver = await createNeo4jDriver(nc);
            return { value: driver, close: () => driver.close() };
        });
    };

    type KafkaModule = typeof import('kafkajs');
    const kafka = () => {
        const kc = config?.kafka;
        if (!kc || kc.brokers.length === 0) notConfigured('Kafka', 'Add "kafka" to environments.json or set PW_KAFKA_BROKERS.'); 
        return connections.get('kafka', async () => {
            const { Kafka, logLevel } = await loadOptional<KafkaModule>('kafkajs', 'kafkaClient');
            const instance = new Kafka({
                clientId: 'propmaster-mcp',
                brokers: kc.brokers,
                ssl: kc.ssl ?? false,
                ...(kc.sasl ? { sasl: kc.sasl as never } : {}),
                logLevel: logLevel.NOTHING,
            });
            const admin = instance.admin();
            await admin.connect();
            return { value: { instance, admin }, close: () => admin.disconnect() };
        });
    };

    const tools: ToolDefinition[] = [
        {
            name: 'environment_info',
            title: 'Environment info',
            description: 'Shows the active Propmaster environment, which backends are configured (hosts only, no credentials), and whether write tools are enabled. Call this first.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async () => ({
                environment: ctx.environment,
                root: ctx.root,
                writes: ctx.allowWrites ? 'enabled' : 'disabled (start the server with --allow-writes to enable)',
                ...(ctx.configError ? { configError: ctx.configError } : {}),
                backends: describeBackends(config),
            }),
        },
        {
            name: 'db_query',
            title: 'Database query',
            description: 'Runs one read-only SQL statement (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, PRAGMA) against the configured database (PostgreSQL, MySQL, MSSQL or SQLite) and returns the rows. Use placeholders ($1 for PostgreSQL, ? otherwise) and params for values.',
            inputSchema: {
                type: 'object',
                properties: { sql: { type: 'string', description: 'A single read-only SQL statement' }, params: PARAMS_SCHEMA, maxRows: ROWS_SCHEMA },
                required: ['sql'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const sql = str(args, 'sql');
                const problem = readOnlySqlProblem(sql);
                if (problem) {
                    throw new ToolInputError(`db_query only runs reads, and this statement isn't one: ${problem}.${ctx.allowWrites ? ' Use db_execute for writes.' : ''}`);
                }
                const rows = await (await database()).query(sql, arr(args, 'params'));
                return limitRows(rows, count(args, 'maxRows', DEFAULT_ROWS, MAX_ROWS));
            },
        },
        {
            name: 'mongo_find',
            title: 'MongoDB find',
            description: 'Finds documents in a MongoDB collection with an optional filter, sort and projection.',
            inputSchema: {
                type: 'object',
                properties: {
                    collection: { type: 'string' },
                    filter: { type: 'object', description: 'MongoDB query filter, e.g. {"status": "active"}' },
                    sort: { type: 'object', description: 'e.g. {"createdAt": -1}' },
                    projection: { type: 'object', description: 'e.g. {"name": 1, "_id": 0}' },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: 'Documents to return (default 20)' },
                },
                required: ['collection'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const limit = count(args, 'limit', 20, MAX_ROWS);
                const docs = await (await mongo()).find(str(args, 'collection'), obj(args, 'filter') ?? {}, {
                    limit,
                    sort: obj(args, 'sort') as Record<string, 1 | -1> | undefined,
                    projection: obj(args, 'projection') as Record<string, 0 | 1> | undefined,
                });
                return { count: docs.length, documents: docs };
            },
        },
        {
            name: 'mongo_aggregate',
            title: 'MongoDB aggregate',
            description: 'Runs an aggregation pipeline on a MongoDB collection. Pipelines with $out or $merge (which write) are refused.',
            inputSchema: {
                type: 'object',
                properties: {
                    collection: { type: 'string' },
                    pipeline: { type: 'array', items: { type: 'object' } },
                    maxRows: ROWS_SCHEMA,
                },
                required: ['collection', 'pipeline'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const pipeline = arr(args, 'pipeline', true) as Record<string, unknown>[];
                const stage = writingPipelineStage(pipeline);
                if (stage) throw new ToolInputError(`mongo_aggregate only reads; the pipeline has a ${stage} stage, which writes.`);
                const docs = await (await mongo()).aggregate(str(args, 'collection'), pipeline);
                return limitRows(docs, count(args, 'maxRows', DEFAULT_ROWS, MAX_ROWS));
            },
        },
        {
            name: 'redis_get',
            title: 'Redis get',
            description: 'Reads a Redis key of any type (string, hash, list, set, sorted set, stream) with its TTL. The configured key prefix is added for you.',
            inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const key = str(args, 'key');
                const { client } = await redis();
                const type = await client.type(key);
                const ttl = await client.ttl(key);
                const value = await readRedisValue(client, key, type);
                return { key, type, ttlSeconds: ttl >= 0 ? ttl : null, value };
            },
        },
        {
            name: 'redis_keys',
            title: 'Redis keys',
            description: 'Lists Redis keys matching a glob pattern (SCAN, never KEYS). The configured key prefix is added to the pattern and removed from the results.',
            inputSchema: {
                type: 'object',
                properties: { pattern: { type: 'string', description: 'Glob, default "*"' }, limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: 'Keys to return (default 100)' } },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const { client, prefix } = await redis();
                const limit = count(args, 'limit', 100, MAX_ROWS);
                const match = prefix + (optStr(args, 'pattern') ?? '*');
                const keys: string[] = [];
                let cursor = '0';
                do {
                    const [next, batch] = await client.scan(cursor, 'MATCH', match, 'COUNT', 500);
                    cursor = next;
                    for (const k of batch) if (keys.length < limit) keys.push(prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k);
                } while (cursor !== '0' && keys.length < limit);
                return { count: keys.length, keys: keys.sort(), truncated: cursor !== '0' ? true : undefined };
            },
        },
        {
            name: 'kafka_topics',
            title: 'Kafka topics',
            description: 'Lists Kafka topics with their partitions and message offsets.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async () => {
                const { admin } = await kafka();
                const names = (await admin.listTopics()).filter((t) => !t.startsWith('__')).sort();
                const topics = await Promise.all(names.map(async (name) => {
                    const offsets = await admin.fetchTopicOffsets(name);
                    return {
                        name,
                        partitions: offsets.length,
                        messages: offsets.reduce((sum, p) => sum + (Number(p.high) - Number(p.low)), 0),
                    };
                }));
                return { topics };
            },
        },
        {
            name: 'kafka_peek',
            title: 'Kafka peek',
            description: 'Reads the latest messages on a Kafka topic without committing offsets for any existing consumer group. Values are parsed as JSON when they can be.',
            inputSchema: {
                type: 'object',
                properties: {
                    topic: { type: 'string' },
                    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Latest messages to return (default 10)' },
                },
                required: ['topic'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const topic = str(args, 'topic');
                const limit = count(args, 'limit', 10, 200);
                const { instance, admin } = await kafka();
                return { topic, messages: await peekTopic(instance, admin, topic, limit) };
            },
        },
        {
            name: 'neo4j_read',
            title: 'Neo4j read',
            description: 'Runs a Cypher query in a read transaction (Neo4j rejects writes in it) and returns the records as plain objects.',
            inputSchema: {
                type: 'object',
                properties: { cypher: { type: 'string' }, params: { type: 'object' }, maxRows: ROWS_SCHEMA },
                required: ['cypher'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const driver = await neo4j();
                const session = driver.session({ database: config?.neo4j?.database, defaultAccessMode: 'READ' });
                try {
                    const result = await session.executeRead((tx) => tx.run(str(args, 'cypher'), obj(args, 'params') ?? {}));
                    const rows = result.records.map((r) => toPlain(r.toObject()) as Record<string, unknown>);
                    return limitRows(rows, count(args, 'maxRows', DEFAULT_ROWS, MAX_ROWS));
                } finally {
                    await session.close();
                }
            },
        },
        {
            name: 'openapi_operations',
            title: 'OpenAPI operations',
            description: 'Lists the operations in the configured OpenAPI spec: operationId (the method name on openApiClient.client), method, path, summary, parameters, request body and documented status codes. Filter by a substring of the operationId, path, summary or tag.',
            inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const oc = config?.openapi;
                if (!oc?.specPath) notConfigured('The OpenAPI spec', 'Add "openapi.specPath" to environments.json or set PW_OPENAPI_SPEC_PATH.');
                const document = await loadOpenApiDocument(oc.specPath, ctx.root);
                const operations = listOperations(document, optStr(args, 'filter'));
                return { baseUrl: oc.baseUrl, count: operations.length, operations };
            },
        },
        {
            name: 'otp_generate',
            title: 'Generate OTP',
            description: 'Generates the current TOTP code for the configured OTP secret (PW_OTP_SECRET), or for a base32 secret you pass.',
            inputSchema: { type: 'object', properties: { secret: { type: 'string', description: 'Base32 secret; defaults to the configured one' } }, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const otp = config?.otp ?? {};
                const client = createOtpClient(otp, await loadOptional<typeof import('otplib')>('otplib', 'otpClient'));
                const token = await client.generateTotp(optStr(args, 'secret'));
                const period = otp.period ?? 30;
                return { token, expiresInSeconds: period - (Math.floor(Date.now() / 1000) % period) };
            },
        },
        {
            name: 'next_test_id',
            title: 'Next TestCaseID',
            description: 'Returns the next free TestCaseID(s) in a category (e.g. API → TC-API-005). Use it for every new test: each test needs a unique [TC-XXX-NNN] title prefix and matching tag.',
            inputSchema: {
                type: 'object',
                properties: {
                    category: { type: 'string', description: 'Category code, e.g. API, DB, KFK, RDS, MDB, NEO, GQL, BRW' },
                    count: { type: 'integer', minimum: 1, maximum: 50, description: 'How many sequential IDs (default 1)' },
                },
                required: ['category'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const category = str(args, 'category').toUpperCase();
                if (!/^[A-Z][A-Z0-9]{1,5}$/.test(category)) throw new ToolInputError('category must be 2–6 capital letters or digits, starting with a letter (e.g. API)');
                return { ids: nextIds(category, collect(ctx.root).ids, count(args, 'count', 1, 50)) };
            },
        },
        {
            name: 'check_tests',
            title: 'Check test conventions',
            description: 'Checks every test file against the Propmaster conventions (TestCaseID in title and tag, unique IDs, test.step() bodies, imports) and lists the violations with file, line and fix. Run it after writing or changing tests.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async () => {
                const { violations } = collect(ctx.root);
                return { ok: violations.length === 0, violations };
            },
        },
    ];

    if (!ctx.allowWrites) return tools;

    // ── Write tools (only with --allow-writes, never in production) ──
    const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
    tools.push(
        {
            name: 'db_execute',
            title: 'Database execute',
            description: 'Runs one SQL statement that changes data (INSERT, UPDATE, DELETE, DDL) and returns the affected row count. Nothing is cleaned up afterwards.',
            inputSchema: { type: 'object', properties: { sql: { type: 'string' }, params: PARAMS_SCHEMA }, required: ['sql'], additionalProperties: false },
            annotations: write,
            handler: async (args) => {
                return (await database()).execute(str(args, 'sql'), arr(args, 'params'));
            },
        },
        {
            name: 'mongo_insert',
            title: 'MongoDB insert',
            description: 'Inserts documents into a MongoDB collection.',
            inputSchema: { type: 'object', properties: { collection: { type: 'string' }, documents: { type: 'array', items: { type: 'object' } } }, required: ['collection', 'documents'], additionalProperties: false },
            annotations: write,
            handler: async (args) => (await mongo()).insertMany(str(args, 'collection'), arr(args, 'documents', true) as Record<string, unknown>[]),
        },
        {
            name: 'mongo_update',
            title: 'MongoDB update',
            description: 'Updates every document matching a filter (updateMany).',
            inputSchema: { type: 'object', properties: { collection: { type: 'string' }, filter: { type: 'object' }, update: { type: 'object', description: 'e.g. {"$set": {"active": false}}' } }, required: ['collection', 'filter', 'update'], additionalProperties: false },
            annotations: write,
            handler: async (args) => (await mongo()).updateMany(str(args, 'collection'), obj(args, 'filter') ?? {}, obj(args, 'update') ?? {}),
        },
        {
            name: 'mongo_delete',
            title: 'MongoDB delete',
            description: 'Deletes every document matching a filter (deleteMany). An empty filter is refused.',
            inputSchema: { type: 'object', properties: { collection: { type: 'string' }, filter: { type: 'object' } }, required: ['collection', 'filter'], additionalProperties: false },
            annotations: write,
            handler: async (args) => {
                const filter = obj(args, 'filter') ?? {};
                if (Object.keys(filter).length === 0) throw new ToolInputError('mongo_delete needs a non-empty filter; it never deletes a whole collection.');
                return (await mongo()).deleteMany(str(args, 'collection'), filter);
            },
        },
        {
            name: 'redis_set',
            title: 'Redis set',
            description: 'Sets a Redis string key, optionally with a TTL.',
            inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, ttlSeconds: { type: 'integer', minimum: 1 } }, required: ['key', 'value'], additionalProperties: false },
            annotations: write,
            handler: async (args) => {
                const { client } = await redis();
                const key = str(args, 'key');
                const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
                const ttl = args.ttlSeconds === undefined ? undefined : count(args, 'ttlSeconds', 1, Number.MAX_SAFE_INTEGER);
                await (ttl ? client.set(key, value, 'EX', ttl) : client.set(key, value));
                return { key, set: true, ttlSeconds: ttl ?? null };
            },
        },
        {
            name: 'redis_del',
            title: 'Redis delete',
            description: 'Deletes Redis keys.',
            inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'], additionalProperties: false },
            annotations: write,
            handler: async (args) => {
                const keys = (arr(args, 'keys', true) ?? []).map(String);
                if (keys.length === 0) throw new ToolInputError('"keys" is empty');
                const { client } = await redis();
                return { removed: await client.del(...keys) };
            },
        },
        {
            name: 'kafka_produce',
            title: 'Kafka produce',
            description: 'Sends messages to a Kafka topic. Object values are sent as JSON.',
            inputSchema: {
                type: 'object',
                properties: {
                    topic: { type: 'string' },
                    messages: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['value'] } },
                },
                required: ['topic', 'messages'],
                additionalProperties: false,
            },
            annotations: write,
            handler: async (args) => {
                const topic = str(args, 'topic');
                const messages = (arr(args, 'messages', true) as Array<{ key?: string; value: unknown }>).map((m) => ({
                    key: m.key ?? null,
                    value: typeof m.value === 'string' ? m.value : JSON.stringify(m.value),
                }));
                const { instance } = await kafka();
                const producer = instance.producer();
                await producer.connect();
                try {
                    await producer.send({ topic, messages });
                } finally {
                    await producer.disconnect();
                }
                return { topic, sent: messages.length };
            },
        },
        {
            name: 'neo4j_write',
            title: 'Neo4j write',
            description: 'Runs a Cypher write query and returns the update counters.',
            inputSchema: { type: 'object', properties: { cypher: { type: 'string' }, params: { type: 'object' } }, required: ['cypher'], additionalProperties: false },
            annotations: write,
            handler: async (args) => {
                const driver = await neo4j();
                const { summary } = await driver.executeQuery(str(args, 'cypher'), obj(args, 'params') ?? {}, {
                    database: config?.neo4j?.database,
                    routing: 'WRITE' as never,
                });
                return summary.counters.updates();
            },
        },
    );
    return tools;
}

// ─── Backend details ────────────────────────────────────────────────────────

/** Configured backends with where they point, without credentials. */
export function describeBackends(config: FrameworkConfig | undefined): Record<string, unknown> {
    if (!config) return {};
    const out: Record<string, unknown> = {};
    const c = config;
    if (c.database) out.database = { type: c.database.type, host: c.database.host, port: c.database.port, database: c.database.database, tools: ['db_query'] };
    if (c.redis) out.redis = { host: c.redis.host, port: c.redis.port, db: c.redis.db, keyPrefix: c.redis.keyPrefix, tools: ['redis_get', 'redis_keys'] };
    if (c.mongodb) out.mongodb = { host: c.mongodb.uri ? hostOf(c.mongodb.uri) : c.mongodb.host, port: c.mongodb.port, database: c.mongodb.database, tools: ['mongo_find', 'mongo_aggregate'] };
    if (c.neo4j) out.neo4j = { uri: hostOf(c.neo4j.uri), database: c.neo4j.database, tools: ['neo4j_read'] };
    if (c.kafka && c.kafka.brokers.length > 0) out.kafka = { brokers: c.kafka.brokers, tools: ['kafka_topics', 'kafka_peek'] };
    if (c.openapi?.specPath) out.openapi = { specPath: c.openapi.specPath, baseUrl: c.openapi.baseUrl, tools: ['openapi_operations'] };
    if (c.graphql?.endpoint) out.graphql = { endpoint: c.graphql.endpoint };
    if (c.otp?.secret) out.otp = { secret: 'configured', tools: ['otp_generate'] };
    return out;
}

/** A URL without its user info. */
function hostOf(uri: string): string {
    try {
        const u = new URL(uri);
        u.username = '';
        u.password = '';
        return u.toString();
    } catch {
        return uri.replace(/\/\/[^@/]*@/, '//');
    }
}

async function readRedisValue(client: Redis, key: string, type: string): Promise<unknown> {
    switch (type) {
        case 'none': return null;
        case 'string': return decode(await client.get(key));
        case 'hash': return client.hgetall(key);
        case 'list': return { length: await client.llen(key), first100: await client.lrange(key, 0, 99) };
        case 'set': {
            const [, members] = await client.sscan(key, '0', 'COUNT', 100);
            return { size: await client.scard(key), sample: members.slice(0, 100) };
        }
        case 'zset': return { size: await client.zcard(key), first100WithScores: await client.zrange(key, '0', '99', 'WITHSCORES') };
        case 'stream': return { length: await client.xlen(key), latest20: await client.xrevrange(key, '+', '-', 'COUNT', '20') };
        default: return `<${type} values aren't shown>`;
    }
}

type KafkaInstance = InstanceType<typeof import('kafkajs').Kafka>;
type KafkaAdmin = ReturnType<KafkaInstance['admin']>;

/**
 * Reads up to `limit` of the latest messages on each partition with a
 * throwaway consumer group, then deletes the group.
 */
async function peekTopic(kafka: KafkaInstance, admin: KafkaAdmin, topic: string, limit: number) {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) throw new ToolInputError(`Topic "${topic}" doesn't exist. kafka_topics lists the topics.`);

    const offsets = await admin.fetchTopicOffsets(topic);
    const ranges = offsets
        .map((p) => ({ partition: p.partition, high: Number(p.high), start: Math.max(Number(p.low), Number(p.high) - limit) }))
        .filter((p) => p.high > p.start);
    if (ranges.length === 0) return [];

    const groupId = `propmaster-mcp-${randomBytes(4).toString('hex')}`;
    const consumer = kafka.consumer({ groupId });
    const messages: Array<{ partition: number; offset: string; timestamp: string; key: string | null; value: unknown; headers?: Record<string, string> }> = [];
    const remaining = new Map(ranges.map((r) => [r.partition, r.high]));

    await consumer.connect();
    try {
        await consumer.subscribe({ topic, fromBeginning: true });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, KAFKA_PEEK_TIMEOUT_MS);
            consumer.run({
                autoCommit: false,
                eachMessage: async ({ partition, message }) => {
                    const high = remaining.get(partition);
                    if (high === undefined) return;
                    messages.push({
                        partition,
                        offset: message.offset,
                        timestamp: new Date(Number(message.timestamp)).toISOString(),
                        key: message.key?.toString() ?? null,
                        value: decode(message.value?.toString()),
                        ...(message.headers && Object.keys(message.headers).length > 0
                            ? { headers: Object.fromEntries(Object.entries(message.headers).map(([k, v]) => [k, String(v)])) }
                            : {}),
                    });
                    if (Number(message.offset) + 1 >= high) remaining.delete(partition);
                    if (remaining.size === 0) {
                        clearTimeout(timer);
                        resolve();
                    }
                },
            }).catch(reject);
            for (const r of ranges) consumer.seek({ topic, partition: r.partition, offset: String(r.start) });
        });
    } finally {
        await consumer.disconnect().catch(() => { });
        await admin.deleteGroups([groupId]).catch(() => { });
    }

    return messages
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.partition - b.partition || Number(a.offset) - Number(b.offset))
        .slice(-limit);
}

// ─── OpenAPI ────────────────────────────────────────────────────────────────

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface OperationSummary {
    operationId?: string;
    method: string;
    path: string;
    summary?: string;
    tags?: string[];
    parameters?: string[];
    requestBody?: string[];
    responses: string[];
}

export function listOperations(document: Record<string, unknown>, filter?: string): OperationSummary[] {
    const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
    const needle = filter?.toLowerCase();
    const out: OperationSummary[] = [];
    for (const [path, item] of Object.entries(paths)) {
        if (!item || typeof item !== 'object') continue;
        const shared = Array.isArray(item.parameters) ? (item.parameters as Array<Record<string, unknown>>) : [];
        for (const method of HTTP_METHODS) {
            const op = item[method] as Record<string, unknown> | undefined;
            if (!op) continue;
            const params = [...shared, ...(Array.isArray(op.parameters) ? (op.parameters as Array<Record<string, unknown>>) : [])];
            const body = op.requestBody as { content?: Record<string, unknown>; $ref?: string } | undefined;
            const bodyParam = params.find((p) => p.in === 'body');
            const entry: OperationSummary = {
                operationId: op.operationId as string | undefined,
                method: method.toUpperCase(),
                path,
                summary: (op.summary ?? op.description) as string | undefined,
                tags: op.tags as string[] | undefined,
                parameters: params.filter((p) => p.in !== 'body').map((p) => (p.$ref ? String(p.$ref).split('/').pop()! : `${p.name} (${p.in}${p.required ? ', required' : ''})`)),
                requestBody: body?.content ? Object.keys(body.content) : body?.$ref ? [String(body.$ref)] : bodyParam ? ['body'] : undefined,
                responses: Object.keys((op.responses ?? {}) as object),
            };
            if (entry.parameters?.length === 0) delete entry.parameters;
            if (needle) {
                const haystack = [entry.operationId, entry.path, entry.summary, ...(entry.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
                if (!haystack.includes(needle)) continue;
            }
            out.push(entry);
        }
    }
    return out;
}
