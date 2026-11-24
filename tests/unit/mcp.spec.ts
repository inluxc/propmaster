/**
 * Unit tests for the MCP server behind `propmaster mcp` (src/mcp).
 *
 * Backends run against SQLite in a temp project; the other backends are
 * covered by the same connection code the fixtures use. Sample tests use the
 * fictional `ZZ` category so their IDs never collide with real ones.
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isProductionEnvironment, readOnlySqlProblem, stripSqlLiterals, writingPipelineStage } from '../../src/mcp/guards';
import { McpServer, serveStdio, ToolInputError, type JsonRpcResponse } from '../../src/mcp/protocol';
import { createPropmasterMcpServer, makeRedactor, parseMcpArgs, secretValues, type CreatedServer } from '../../src/mcp/server';
import { listOperations } from '../../src/mcp/tools';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_PASSWORD = 'sup3r-s3cret-pw';

// ─── Guards ─────────────────────────────────────────────────────────────────

test.describe('mcp — read-only SQL guard', () => {
    const reads = [
        'SELECT * FROM users',
        '  select id from users where name = $1;',
        "SELECT 'delete from users' AS text",
        'SELECT 1 -- DROP TABLE users',
        'SELECT /* insert */ 1',
        'WITH t AS (SELECT 1 AS n) SELECT n FROM t',
        'EXPLAIN SELECT * FROM users',
        'SHOW TABLES',
        'DESCRIBE users',
        'PRAGMA table_info(users)',
        '(SELECT 1) UNION (SELECT 2)',
        'SELECT $$drop table$$ AS body',
        'SELECT "update" FROM t',
        'SELECT [delete] FROM t',
        'SELECT created_at, updated_at FROM t',
    ];
    for (const sql of reads) {
        test(`allows: ${sql.trim()}`, () => {
            expect(readOnlySqlProblem(sql)).toBeUndefined();
        });
    }

    const writes: Array<[string, RegExp]> = [
        ['DELETE FROM users', /must start with/],
        ['UPDATE users SET a = 1', /must start with/],
        ['insert into users values (1)', /must start with/],
        ['DROP TABLE users', /must start with/],
        ['SELECT 1; DROP TABLE users', /only one statement/],
        ['WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone', /DELETE/],
        ['SELECT * INTO backup FROM users', /INTO/],
        ['EXPLAIN ANALYZE DELETE FROM users', /DELETE|ANALYZE/],
        ['SELECT * FROM users FOR UPDATE', /UPDATE/],
        ['PRAGMA journal_mode = WAL', /PRAGMA/],
        ['', /empty/],
        ['  ;  ', /empty/],
    ];
    for (const [sql, reason] of writes) {
        test(`refuses: ${sql || '(empty)'}`, () => {
            expect(readOnlySqlProblem(sql)).toMatch(reason);
        });
    }

    test('keywords inside literals and comments are ignored', () => {
        expect(stripSqlLiterals("SELECT 'it''s DROP' /* DELETE */ -- UPDATE\n, \"INSERT\"")).not.toMatch(/DROP|DELETE|UPDATE|INSERT/);
    });
});

test.describe('mcp — other guards', () => {
    test('production environment names', () => {
        for (const name of ['prod', 'PROD', 'production', 'prd', 'live', ' Prod ']) expect(isProductionEnvironment(name)).toBe(true);
        for (const name of ['local', 'dev', 'stg', 'staging', 'test', 'preprod']) expect(isProductionEnvironment(name)).toBe(false);
    });

    test('aggregation stages that write', () => {
        expect(writingPipelineStage([{ $match: {} }, { $out: 'copy' }])).toBe('$out');
        expect(writingPipelineStage([{ $merge: { into: 'x' } }])).toBe('$merge');
        expect(writingPipelineStage([{ $match: {} }, { $group: { _id: null } }])).toBeUndefined();
    });
});

// ─── Protocol ───────────────────────────────────────────────────────────────

test.describe('mcp — protocol', () => {
    const calls: string[] = [];
    const server = new McpServer({
        name: 'test',
        version: '1.2.3',
        instructions: 'be nice',
        onToolCall: ({ name, ok }) => calls.push(`${name}:${ok}`),
        tools: [
            {
                name: 'echo',
                description: 'Echoes',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                handler: async (args) => ({ said: args.text, big: 2n ** 70n }),
            },
            {
                name: 'fails',
                description: 'Fails',
                inputSchema: { type: 'object' },
                handler: async () => {
                    throw new ToolInputError('bad input');
                },
            },
            {
                name: 'list',
                description: 'Returns an array',
                inputSchema: { type: 'object' },
                handler: async () => [1, 2],
            },
        ],
    });
    const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
        server.handle({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });

    test('initialize echoes a supported protocol version and falls back to the latest', async () => {
        const res = await call('initialize', { protocolVersion: '2025-06-18' });
        expect(res?.result).toMatchObject({
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1.2.3' },
            instructions: 'be nice',
        });
        const old = await call('initialize', { protocolVersion: '1999-01-01' });
        expect((old?.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    });

    test('tools/list lists definitions without handlers', async () => {
        const res = await call('tools/list');
        const tools = (res?.result as { tools: Array<Record<string, unknown>> }).tools;
        expect(tools.map((t) => t.name)).toEqual(['echo', 'fails', 'list']);
        expect(tools[0]).toEqual({ name: 'echo', description: 'Echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } });
    });

    test('tools/call returns JSON text and structured content', async () => {
        const res = await call('tools/call', { name: 'echo', arguments: { text: 'hi' } });
        const result = res?.result as { content: Array<{ text: string }>; structuredContent: unknown; isError?: boolean };
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toEqual({ said: 'hi', big: '1180591620717411303424' });
        expect(result.structuredContent).toEqual({ said: 'hi', big: '1180591620717411303424' });
    });

    test('arrays get no structured content', async () => {
        const res = await call('tools/call', { name: 'list' });
        expect(res?.result).toEqual({ content: [{ type: 'text', text: '[\n  1,\n  2\n]' }] });
    });

    test('a failing tool is a tool error, not a protocol error', async () => {
        const res = await call('tools/call', { name: 'fails' });
        expect(res?.error).toBeUndefined();
        expect(res?.result).toEqual({ content: [{ type: 'text', text: 'bad input' }], isError: true });
        expect(calls).toContain('fails:false');
    });

    test('missing required arguments are reported by name', async () => {
        const res = await call('tools/call', { name: 'echo', arguments: {} });
        expect(res?.result).toMatchObject({ isError: true, content: [{ text: 'Missing required argument: text' }] });
    });

    test('unknown tools, unknown methods and bad JSON are JSON-RPC errors', async () => {
        expect((await call('tools/call', { name: 'nope' }))?.error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' });
        expect((await call('resources/list'))?.error).toMatchObject({ code: -32601 });
        expect((await server.handleLine('{oops'))?.error).toMatchObject({ code: -32700 });
        expect((await server.handle({ id: 1, method: 'ping' }))?.error).toMatchObject({ code: -32600 });
    });

    test('notifications get no reply; ping answers', async () => {
        expect(await call('notifications/initialized', undefined, null)).toBeUndefined();
        expect(await call('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    });

    test('serveStdio answers one JSON line per request and stops at end of input', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let written = '';
        output.on('data', (d) => (written += d));
        const done = serveStdio(server, input, output);
        input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
        input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"split');
        input.write(' line"}}}\n');
        input.end();
        await done;
        const lines = written.trim().split('\n').map((l) => JSON.parse(l) as JsonRpcResponse);
        expect(lines.map((l) => l.id).sort()).toEqual([1, 2]);
        expect(JSON.stringify(lines.find((l) => l.id === 2))).toContain('split line');
    });
});

// ─── Options and redaction ──────────────────────────────────────────────────

test.describe('mcp — options and redaction', () => {
    test('parses flags', () => {
        expect(parseMcpArgs(['--allow-writes', '-e', 'dev', '--root', 'x'], '/base')).toEqual({ root: path.resolve('/base/x'), environment: 'dev', allowWrites: true, allowProd: false });
        expect(parseMcpArgs(['--environment=stg', '--allow-prod', '--root=/p'])).toEqual({ root: '/p', environment: 'stg', allowWrites: false, allowProd: true });
        expect(parseMcpArgs(['--help'])).toEqual({ help: true });
        expect(parseMcpArgs(['--nope'])).toEqual({ error: 'Unknown option: --nope' });
        expect(parseMcpArgs(['-e'])).toEqual({ error: '-e needs a value' });
    });

    test('collects credential-like config values, including passwords in URIs', () => {
        const values = secretValues({
            environment: 'dev',
            database: { host: 'db', password: 'pw-1234', username: 'app' },
            mongodb: { uri: 'mongodb://app:uri%40pass@mongo:27017/db' },
            auth: { clientSecret: 'cs-5678', roles: { admin: { password: 'adm-9999' } } },
            otp: { secret: 'JBSWY3DPEHPK3PXP' },
            graphql: { authToken: 'tok-abcd' },
            redis: { password: 'x' }, // too short to scrub safely
        });
        expect([...values].sort()).toEqual(['JBSWY3DPEHPK3PXP', 'adm-9999', 'cs-5678', 'pw-1234', 'tok-abcd', 'uri@pass'].sort());
    });

    test('the redactor scrubs secrets, their JSON-escaped form, and known credential patterns', () => {
        const redact = makeRedactor(new Set(['pa"ss-1234', 'plain-secret']));
        expect(redact('pw is plain-secret')).toBe('pw is [REDACTED]');
        expect(redact(JSON.stringify({ v: 'pa"ss-1234' }))).toBe('{"v":"[REDACTED]"}');
        expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    });
});

// ─── Server against a temp project (SQLite) ─────────────────────────────────

function makeProject(environments: Record<string, unknown>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-mcp-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sample"}');
    fs.writeFileSync(path.join(root, 'environments.json'), JSON.stringify({ environments }));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/a.spec.ts'), `import { test } from '@inluxc/propmaster';
test('[TC-ZZ-001] one', { tag: ['@TC-ZZ-001'] }, async () => {
    await test.step('Step 1: Do it', async () => {});
});
test('[TC-ZZ-002] two', { tag: ['@TC-ZZ-002'] }, async () => {
    await test.step('Step 1: Do it', async () => {});
});
`);
    fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Shop', version: '1' },
        paths: {
            '/products': {
                get: { operationId: 'listProducts', summary: 'List products', tags: ['catalog'], parameters: [{ name: 'q', in: 'query' }], responses: { 200: { description: 'ok' } } },
                post: { operationId: 'createProduct', requestBody: { content: { 'application/json': {} } }, responses: { 201: { description: 'made' }, 400: { description: 'bad' } } },
            },
            '/products/{id}': {
                parameters: [{ name: 'id', in: 'path', required: true }],
                get: { operationId: 'getProduct', responses: { 200: { description: 'ok' }, 404: { description: 'missing' } } },
            },
        },
    }));
    return root;
}

function dbEnv(root: string, extra: Record<string, unknown> = {}) {
    return {
        database: { type: 'sqlite', host: 'local', port: 0, database: path.join(root, 'app.db'), username: 'app', password: DB_PASSWORD },
        openapi: { specPath: './api.json', baseUrl: 'http://localhost:3000' },
        otp: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
        ...extra,
    };
}

async function start(root: string, options: { environment?: string; allowWrites?: boolean; allowProd?: boolean } = {}) {
    const logs: string[] = [];
    const created = await createPropmasterMcpServer(
        { root, environment: options.environment ?? 'local', allowWrites: options.allowWrites ?? false, allowProd: options.allowProd ?? false },
        (line) => logs.push(line),
    );
    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await created.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
        const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
        return { error: result.isError === true, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
    };
    return { ...created, logs, callTool };
}

test.describe('mcp — server tools (SQLite project)', () => {
    let root: string;
    let server: CreatedServer & Awaited<ReturnType<typeof start>>;

    test.beforeAll(async () => {
        root = makeProject({ local: dbEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-mcp-db-'))), prod: dbEnv(os.tmpdir()) });
        const setup = await start(root, { allowWrites: true });
        expect((await setup.callTool('db_execute', { sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, secret TEXT)' })).error).toBe(false);
        expect((await setup.callTool('db_execute', { sql: 'INSERT INTO users (email, secret) VALUES (?, ?), (?, ?)', params: ['a@example.test', DB_PASSWORD, 'b@example.test', 'none'] })).json()).toEqual({ affectedRows: 2 });
        await setup.close();
        server = await start(root);
    });

    test.afterAll(async () => {
        await server?.close();
    });

    test('backends read-only by default: no backend write tools; only the project tools change anything', async () => {
        const res = await server.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const names = (res?.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }).tools;
        expect(names.map((t) => t.name)).toEqual([
            'environment_info', 'db_query', 'mongo_find', 'mongo_aggregate', 'redis_get', 'redis_keys', 'kafka_topics',
            'kafka_peek', 'neo4j_read', 'clickhouse_query', 'openapi_operations', 'otp_generate', 'next_test_id', 'check_tests',
            'fixtures_list', 'fixture_add', 'fixture_remove', 'environments_list', 'environment_add', 'standards', 'doctor',
            'run_tests', 'last_failures', 'flaky_tests', 'coverage_report', 'generate_api_tests',
        ]);
        // The project tools change project files (only with apply: true), never backend data.
        expect(names.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(['fixture_add', 'fixture_remove', 'environment_add', 'doctor', 'run_tests', 'generate_api_tests']);
        const write = await server.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'db_execute', arguments: { sql: 'DELETE FROM users' } } });
        expect(write?.error).toMatchObject({ message: 'Unknown tool: db_execute' });
        expect(server.logs[0]).toContain('backends read-only, 26 tools');
    });

    test('db_query returns rows, honours params and maxRows', async () => {
        const all = await server.callTool('db_query', { sql: 'SELECT id, email FROM users ORDER BY id', maxRows: 1 });
        expect(all.json()).toEqual({ rowCount: 2, rows: [{ id: 1, email: 'a@example.test' }], truncated: true });
        const one = await server.callTool('db_query', { sql: 'SELECT email FROM users WHERE id = ?', params: [2] });
        expect(one.json()).toEqual({ rowCount: 1, rows: [{ email: 'b@example.test' }] });
    });

    test('db_query refuses writes and leaves the data alone', async () => {
        const res = await server.callTool('db_query', { sql: 'DELETE FROM users' });
        expect(res.error).toBe(true);
        expect(res.text).toContain("db_query only runs reads, and this statement isn't one");
        expect((await server.callTool('db_query', { sql: 'SELECT count(*) AS n FROM users' })).json().rows).toEqual([{ n: 2 }]);
    });

    test('credentials from the config never reach the agent', async () => {
        const res = await server.callTool('db_query', { sql: 'SELECT secret FROM users WHERE id = 1' });
        expect(res.text).not.toContain(DB_PASSWORD);
        expect(res.json().rows).toEqual([{ secret: '[REDACTED]' }]);

        const info = await server.callTool('environment_info');
        expect(info.text).not.toContain(DB_PASSWORD);
        expect(info.json()).toMatchObject({
            environment: 'local',
            writes: expect.stringContaining('disabled'),
            backends: { database: { type: 'sqlite', tools: ['db_query'] }, openapi: { specPath: './api.json' }, otp: { secret: 'configured' } },
        });

        const err = await server.callTool('db_query', { sql: `SELECT * FROM "${DB_PASSWORD}"` });
        expect(err.error).toBe(true);
        expect(err.text).not.toContain(DB_PASSWORD);
        expect(server.logs.join('\n')).not.toContain(DB_PASSWORD);
    });

    test('every call is logged to the log sink with its arguments and outcome', async () => {
        await server.callTool('db_query', { sql: 'SELECT 1 AS one' });
        expect(server.logs.at(-1)).toMatch(/^propmaster-mcp: db_query \{"sql":"SELECT 1 AS one"\} → ok \(\d+ ms\)$/);
    });

    test('backends that are not configured say how to configure them', async () => {
        const res = await server.callTool('redis_get', { key: 'k' });
        expect(res.error).toBe(true);
        expect(res.text).toBe("Redis isn't configured for this environment. Add \"redis\" to environments.json or set PW_REDIS_HOST.");
        expect((await server.callTool('kafka_peek', { topic: 't' })).text).toContain('PW_KAFKA_BROKERS');
        expect((await server.callTool('mongo_find', { collection: 'c' })).text).toContain('PW_MONGODB_URI');
        expect((await server.callTool('neo4j_read', { cypher: 'RETURN 1' })).text).toContain('PW_NEO4J_URI');
    });

    test('openapi_operations lists operations from the spec, with a filter', async () => {
        const all = (await server.callTool('openapi_operations')).json();
        expect(all.count).toBe(3);
        expect(all.operations).toContainEqual({ operationId: 'getProduct', method: 'GET', path: '/products/{id}', responses: ['200', '404'], parameters: ['id (path, required)'] });
        const filtered = (await server.callTool('openapi_operations', { filter: 'catalog' })).json();
        expect(filtered.operations.map((o: { operationId: string }) => o.operationId)).toEqual(['listProducts']);
    });

    test('next_test_id and check_tests use the project tests', async () => {
        expect((await server.callTool('next_test_id', { category: 'zz', count: 2 })).json()).toEqual({ ids: ['TC-ZZ-003', 'TC-ZZ-004'] });
        expect((await server.callTool('check_tests')).json()).toEqual({ ok: true, violations: [] });
        expect((await server.callTool('next_test_id', { category: 'not valid' })).error).toBe(true);
    });

    test('otp_generate returns the current code for the configured secret', async () => {
        const res = (await server.callTool('otp_generate')).json();
        expect(res.token).toMatch(/^\d{6}$/);
        expect(res.expiresInSeconds).toBeGreaterThan(0);
        expect(res.expiresInSeconds).toBeLessThanOrEqual(30);
    });

    test('bad arguments are tool errors', async () => {
        expect((await server.callTool('db_query', { sql: 42 })).text).toBe('"sql" must be a non-empty string');
        expect((await server.callTool('db_query', { sql: 'SELECT 1', maxRows: -1 })).text).toBe('"maxRows" must be a positive integer');
    });

    test('production is refused unless allowed, and never gets write tools', async () => {
        await expect(start(root, { environment: 'prod' })).rejects.toThrow('Refusing to start for environment "prod"');
        const prod = await start(root, { environment: 'prod', allowProd: true, allowWrites: true });
        try {
            const res = await prod.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
            const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
            expect(names).not.toContain('db_execute');
            // Running tests writes to the backends: not in production
            expect(names).not.toContain('run_tests');
            expect(names).toContain('last_failures');
            expect(prod.logs[0]).toContain('--allow-writes ignored');
        } finally {
            await prod.close();
        }
    });

    test('without environments.json the test-ID tools still work', async () => {
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-mcp-bare-'));
        fs.writeFileSync(path.join(bare, 'package.json'), '{}');
        const s = await start(bare);
        try {
            expect((await s.callTool('next_test_id', { category: 'ZZ' })).json()).toEqual({ ids: ['TC-ZZ-001'] });
            expect((await s.callTool('environment_info')).json().configError).toContain('environments.json');
            expect((await s.callTool('db_query', { sql: 'SELECT 1' })).error).toBe(true);
        } finally {
            await s.close();
        }
    });
});

test('mcp — listOperations reads Swagger 2 body parameters', () => {
    const ops = listOperations({
        swagger: '2.0',
        paths: { '/pet': { post: { operationId: 'addPet', parameters: [{ in: 'body', name: 'body' }], responses: { 405: {} } } } },
    });
    expect(ops).toEqual([{ operationId: 'addPet', method: 'POST', path: '/pet', requestBody: ['body'], responses: ['405'] }]);
});

// ─── End to end: the CLI over stdio ─────────────────────────────────────────

test('mcp — `propmaster mcp` speaks MCP over stdio', async () => {
    test.setTimeout(60_000);
    const root = makeProject({ local: dbEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-mcp-e2e-'))) });
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli/init.ts'), 'mcp', '--root', root], {
        cwd: REPO_ROOT,
        env: { ...process.env, PW_ENVIRONMENT: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const responses = new Map<number, JsonRpcResponse>();
    const waitFor = (id: number) => new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no response ${id}; stderr: ${stderr}`)), 30_000);
        const check = () => {
            for (const line of stdout.split('\n').filter(Boolean)) {
                const msg = JSON.parse(line) as JsonRpcResponse;
                responses.set(msg.id as number, msg);
            }
            const r = responses.get(id);
            if (r) {
                clearTimeout(timer);
                resolve(r);
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    });
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect((await waitFor(1)).result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'propmaster' } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'db_query', arguments: { sql: "SELECT 'hello' AS greeting" } } });
    const res = await waitFor(2);
    expect(JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text)).toEqual({ rowCount: 1, rows: [{ greeting: 'hello' }] });

    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    // stdout carries only protocol messages; logs go to stderr
    expect(stdout.trim().split('\n').every((l) => JSON.parse(l).jsonrpc === '2.0')).toBe(true);
    expect(stderr).toContain('propmaster-mcp: environment "local", backends read-only');
    expect(stderr).toContain('propmaster-mcp: db_query');
});
