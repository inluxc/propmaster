/**
 * Unit tests for the realtime fixture: URL rules, matchers, the SSE parser,
 * PW_REALTIME_* variables, and connections to an in-process server (a `ws`
 * WebSocket server and a plain HTTP server for SSE): echo, subprotocols,
 * headers and bearer tokens, refused handshakes with their status, close
 * codes, a broadcast reaching a second client, and SSE streams. A real server
 * (echo-server) is covered by tests/examples/realtime.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import {
    RealtimeError,
    SseParser,
    containsSubset,
    createRealtimeClient,
    describeArrived,
    resolveRealtimeUrl,
    toPredicate,
    type RealtimeClient,
    type WebSocketMessage,
} from '../../src/fixtures/realtime.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { FixtureOperationError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _realtime = AssertHasKey<FixtureTypes, 'realtimeClient'>;

const msg = (data: string) => ({ data }) as WebSocketMessage;

/** A port nothing listens on (fetch refuses some low ports outright, so not port 1). */
async function closedPort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
}

test.describe('realtime — URLs and matchers', () => {
    test('relative URLs resolve against the base, and the scheme follows the connection kind', () => {
        expect(resolveRealtimeUrl('/ws', 'http://localhost:8080', 'ws')).toBe('ws://localhost:8080/ws');
        expect(resolveRealtimeUrl('/events', 'https://api.test', 'sse')).toBe('https://api.test/events');
        expect(resolveRealtimeUrl('/events', 'wss://api.test/', 'sse')).toBe('https://api.test/events');
        expect(resolveRealtimeUrl('wss://other.test/x?a=1', 'http://localhost', 'ws')).toBe('wss://other.test/x?a=1');
        expect(resolveRealtimeUrl(undefined, 'http://localhost:8080/live', 'ws')).toBe('ws://localhost:8080/live');
    });

    test('a relative URL without a base, or another scheme, says what to set', () => {
        expect(() => resolveRealtimeUrl('/ws', undefined, 'ws')).toThrow(/PW_REALTIME_URL/);
        expect(() => resolveRealtimeUrl(undefined, undefined, 'sse')).toThrow(/needs a base URL/);
        expect(() => resolveRealtimeUrl('ftp://h/x', undefined, 'ws')).toThrow(/unsupported scheme ftp:/);
    });

    test('JSON subsets: objects by key, deeply; arrays element by element', () => {
        const order = { type: 'order', order: { id: 'o-1', lines: [{ sku: 'a', qty: 2 }] }, at: 1 };
        expect(containsSubset(order, { type: 'order' })).toBe(true);
        expect(containsSubset(order, { order: { id: 'o-1' } })).toBe(true);
        expect(containsSubset(order, { order: { lines: [{ sku: 'a' }] } })).toBe(true);
        expect(containsSubset(order, { order: { lines: [] } })).toBe(false);
        expect(containsSubset(order, { type: 'refund' })).toBe(false);
        expect(containsSubset(order, { missing: undefined })).toBe(true);
        expect(containsSubset([1, 2], [1, 2])).toBe(true);
        expect(containsSubset('x', { a: 1 })).toBe(false);
    });

    test('matchers: exact text, a RegExp (even with g), a JSON subset, or a function', () => {
        expect(toPredicate<WebSocketMessage>('pong')(msg('pong'))).toBe(true);
        expect(toPredicate<WebSocketMessage>('pong')(msg('pong!'))).toBe(false);
        const re = toPredicate<WebSocketMessage>(/order-\d+/g);
        expect([re(msg('order-1')), re(msg('order-2')), re(msg('nope'))]).toEqual([true, true, false]);
        expect(toPredicate<WebSocketMessage>({ type: 'ack' })(msg('{"type":"ack","id":3}'))).toBe(true);
        expect(toPredicate<WebSocketMessage>({ type: 'ack' })(msg('not json'))).toBe(false);
        expect(toPredicate<WebSocketMessage>((m) => m.data.length === 3)(msg('abc'))).toBe(true);
        expect(toPredicate<WebSocketMessage>(undefined)(msg(''))).toBe(true);
    });

    test('what arrived: the count and the last five, shortened', () => {
        expect(describeArrived([])).toBe('nothing arrived');
        expect(describeArrived([{ data: 'a' }, { data: 'b', event: 'tick' }])).toBe('2 message(s) arrived: "a", tick: "b"');
        const many = Array.from({ length: 7 }, (_, i) => ({ data: `m${i}` }));
        expect(describeArrived(many)).toBe('7 message(s) arrived, the last 5: "m2", "m3", "m4", "m5", "m6"');
        expect(describeArrived([{ data: 'x'.repeat(200) }])).toContain('…');
    });

    test('PW_REALTIME_* variables', () => {
        const vars = {
            PW_REALTIME_URL: 'http://localhost:8080',
            PW_REALTIME_AUTH_TOKEN: 'tok',
            PW_REALTIME_TIMEOUT: '5000',
            PW_REALTIME_CONNECT_TIMEOUT: '3000',
        };
        const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
        Object.assign(process.env, vars);
        try {
            expect(new ConfigLoader().load().realtime).toEqual({ url: 'http://localhost:8080', authToken: 'tok', timeout: 5000, connectTimeout: 3000 });
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });
});

test.describe('realtime — SSE parser', () => {
    const parse = (...chunks: string[]) => {
        const p = new SseParser();
        const events = chunks.flatMap((c) => p.push(c));
        return { p, events: events.map(({ event, data, id, retry }) => ({ event, data, id, retry })) };
    };

    test('events, multi-line data, ids, retry and comments', () => {
        const { p, events } = parse(': keep-alive\n\nevent: order\ndata: {"id":1}\nid: 7\n\ndata: line 1\ndata: line 2\nretry: 3000\n\n');
        expect(events).toEqual([
            { event: 'order', data: '{"id":1}', id: '7', retry: undefined },
            { event: 'message', data: 'line 1\nline 2', id: undefined, retry: 3000 },
        ]);
        expect(p.lastEventId).toBe('7');
    });

    test('CRLF, CR and LF line endings, split anywhere between chunks', () => {
        const text = 'data: a\r\n\r\ndata: b\r\rdata: c\n\n';
        const whole = parse(text).events.map((e) => e.data);
        expect(whole).toEqual(['a', 'b', 'c']);
        for (let i = 1; i < text.length; i++) {
            expect(parse(text.slice(0, i), text.slice(i)).events.map((e) => e.data), `split at ${i}`).toEqual(['a', 'b', 'c']);
        }
    });

    test('spec details: BOM, one space dropped, no colon, NUL ids, events without data, unfinished events', () => {
        const { p, events } = parse('﻿data:  two spaces\n\ndata\n\nevent: empty\n\nid: a\0b\ndata: x\n\nid: ok\ndata: unfinished');
        expect(events.map((e) => e.data)).toEqual([' two spaces', '', 'x']);
        expect(events[2].id).toBeUndefined();
        p.end();
        expect(p.lastEventId).toBe('ok');
    });

    test('json() parses the data, or says it is not JSON', () => {
        const [event] = new SseParser().push('event: tick\ndata: {"n":1}\n\ndata: oops\n\n');
        expect(event.json()).toEqual({ n: 1 });
        const [, bad] = new SseParser().push('event: tick\ndata: {"n":1}\n\ndata: oops\n\n');
        expect(() => bad.json()).toThrow(/the 'message' event isn't JSON: "oops"/);
    });
});

// ─── In-process server ──────────────────────────────────────────────────────

interface TestServer {
    base: string;
    close(): Promise<void>;
    sseRequests: http.IncomingMessage[];
    /** Sockets handed to the upgrade handler and still open. */
    upgraded: Set<import('node:stream').Duplex>;
}

async function startServer(): Promise<TestServer> {
    const sseRequests: http.IncomingMessage[] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/events') {
            sseRequests.push(req);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Stream': 'orders' });
            res.write(': hello\n\nretry: 1000\n\n');
            res.write(`event: auth\ndata: ${JSON.stringify({ authorization: req.headers.authorization ?? null, lastEventId: req.headers['last-event-id'] ?? null })}\n\n`);
            let n = 0;
            const timer = setInterval(() => {
                n++;
                res.write(`event: tick\nid: ${n}\ndata: {"n":${n}}\n\n`);
                if (n === 3 && url.searchParams.has('end')) {
                    clearInterval(timer);
                    res.end();
                }
            }, 20);
            req.on('close', () => clearInterval(timer));
            return;
        }
        if (url.pathname === '/events-private') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end('{"error":"token expired"}');
            return;
        }
        if (url.pathname === '/slow-events') return; // never answers
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>not a stream</h1>');
    });

    const room = new Set<ServerSocket>();
    const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has('chat.v2') ? 'chat.v2' : false),
    });
    const upgraded = new Set<import('node:stream').Duplex>();
    server.on('upgrade', (req, socket, head) => {
        upgraded.add(socket);
        socket.on('close', () => upgraded.delete(socket));
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (path === '/private' && req.headers.authorization !== 'Bearer good') {
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ntoken expired');
            return;
        }
        if (path === '/hang') {
            socket.on('end', () => socket.end()); // never answers; closes once the client hangs up
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            if (path === '/kick') {
                ws.send('bye soon');
                setTimeout(() => ws.close(4001, 'kicked'), 30);
                return;
            }
            if (path === '/room') {
                room.add(ws);
                ws.on('close', () => room.delete(ws));
                ws.on('message', (data, isBinary) => {
                    for (const other of room) if (other !== ws) other.send(data, { binary: isBinary });
                });
                return;
            }
            ws.send(JSON.stringify({ type: 'welcome', authorization: req.headers.authorization ?? null, tenant: req.headers['x-tenant'] ?? null }));
            ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        sseRequests,
        upgraded,
        async close() {
            for (const c of wss.clients) c.terminate();
            for (const s of upgraded) s.destroy();
            wss.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

test.describe('realtime — WebSocket', () => {
    test.describe.configure({ mode: 'serial' });
    let server: TestServer;
    let client: RealtimeClient;

    test.beforeAll(async () => {
        server = await startServer();
    });
    test.afterAll(async () => {
        await server.close();
    });
    test.beforeEach(() => {
        client = createRealtimeClient({ url: server.base, timeout: 2000, headers: { 'X-Tenant': 'acme' } });
    });
    test.afterEach(async () => {
        await client.closeAll();
    });

    test('send and wait for the reply: text, JSON and bytes', async () => {
        const ws = await client.connect('/echo');
        expect(ws.url).toBe(`${server.base.replace('http', 'ws')}/echo`);
        const welcome = await ws.waitForMessage({ type: 'welcome' });
        expect(welcome.json()).toEqual({ type: 'welcome', authorization: null, tenant: 'acme' });

        await ws.send('ping');
        expect((await ws.waitForMessage('ping')).binary).toBe(false);
        await ws.send({ type: 'order', id: 'o-1' });
        expect((await ws.waitForMessage({ id: 'o-1' })).json()).toEqual({ type: 'order', id: 'o-1' });
        await ws.send(Buffer.from([0, 1, 2]));
        const bytes = await ws.waitForMessage((m) => m.binary);
        expect([...bytes.bytes]).toEqual([0, 1, 2]);
        expect(ws.messages().map((m) => m.binary)).toEqual([false, false, false, true]);
    });

    test('each wait returns a message once, so the same reply twice needs two', async () => {
        const ws = await client.connect('/echo');
        await ws.send('again');
        await ws.send('again');
        await ws.waitForMessage('again');
        await ws.waitForMessage('again');
        await expect(ws.waitForMessage('again', { timeout: 200 })).rejects.toThrow(
            `Waited for the text "again" on ${ws.url}: nothing matched within 200 ms; 3 message(s) arrived: "{\\"type\\":\\"welcome\\",\\"authorization\\":null,\\"tenant\\":\\"acme\\"}", "again", "again"`,
        );
        const [a, b] = await (async () => {
            await ws.send('x');
            await ws.send('y');
            return ws.waitForMessages(2, /^[xy]$/);
        })();
        expect([a.data, b.data]).toEqual(['x', 'y']);
    });

    test('a subprotocol is offered and the server picks one', async () => {
        const ws = await client.connect('/echo', { protocols: ['chat.v1', 'chat.v2'] });
        expect(ws.protocol).toBe('chat.v2');
        expect((await client.connect('/echo')).protocol).toBe('');
        await expect(client.connect('/echo', { protocols: 'chat.v1' })).rejects.toThrow(
            /failed: the server accepted none of the subprotocols offered \(chat\.v1\): Server sent no subprotocol/,
        );
    });

    test('bearer token: from the config, a source, or none; a refused handshake has its status and body', async () => {
        const refused = await client.connect('/private').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(RealtimeError);
        expect(refused).toMatchObject({ status: 401, body: 'token expired', url: `${server.base.replace('http', 'ws')}/private` });
        expect((refused as Error).message).toBe(`WebSocket connection to ${server.base.replace('http', 'ws')}/private failed: the server answered 401 Unauthorized instead of opening the connection: token expired`);

        const withToken = createRealtimeClient({ url: server.base, authToken: 'good' });
        try {
            expect((await withToken.connect('/private')).isOpen).toBe(true);
            await expect(withToken.connect('/private', { auth: false })).rejects.toMatchObject({ status: 401 });
        } finally {
            await withToken.closeAll();
        }

        let asked = 0;
        const fromSource = createRealtimeClient({ url: server.base }, { bearer: async () => (asked++, 'good') });
        try {
            const ws = await fromSource.connect('/echo', { headers: { 'X-Tenant': 'beta' } });
            expect((await ws.waitForMessage({ type: 'welcome' })).json()).toMatchObject({ authorization: 'Bearer good', tenant: 'beta' });
            expect(asked).toBe(1);
            // A header set by the test wins over the token
            const own = await fromSource.connect('/echo', { headers: { authorization: 'Bearer mine' } });
            expect((await own.waitForMessage({ type: 'welcome' })).json()).toMatchObject({ authorization: 'Bearer mine' });
            fromSource.setAuthToken('set-later');
            const later = await fromSource.connect('/echo');
            expect((await later.waitForMessage({ type: 'welcome' })).json()).toMatchObject({ authorization: 'Bearer set-later' });
        } finally {
            await fromSource.closeAll();
        }
    });

    test('the server closing: close code and reason, and a pending wait fails at once', async () => {
        const ws = await client.connect('/kick');
        const started = Date.now();
        const waiting = ws.waitForMessage('never', { timeout: 5000 }).catch((e: unknown) => e);
        expect(await ws.waitForClose()).toEqual({ code: 4001, reason: 'kicked' });
        const error = await waiting;
        expect(error).toBeInstanceOf(FixtureOperationError);
        expect((error as Error).message).toBe(`Waited for the text "never" on ${ws.url}: the connection closed (code 4001: kicked); 1 message(s) arrived: "bye soon"`);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(ws.isOpen).toBe(false);
        await expect(ws.send('late')).rejects.toThrow(/the connection closed \(code 4001: kicked\)/);
        expect(await ws.close()).toEqual({ code: 4001, reason: 'kicked' });
    });

    test('closing from the test, and closeAll for whatever is still open', async () => {
        const ws = await client.connect('/echo');
        expect(await ws.close(1000, 'done')).toEqual({ code: 1000, reason: 'done' });
        const a = await client.connect('/echo');
        const b = await client.connect('/echo');
        await client.closeAll();
        expect([a.isOpen, b.isOpen]).toEqual([false, false]);
        await expect(ws.waitForClose({ timeout: 100 })).resolves.toEqual({ code: 1000, reason: 'done' });
    });

    test('a message sent by one client reaches another', async () => {
        const alice = await client.connect('/room');
        const bob = await client.connect('/room');
        await alice.send({ from: 'alice', text: 'hi bob' });
        expect((await bob.waitForMessage({ from: 'alice' })).json()).toEqual({ from: 'alice', text: 'hi bob' });
        expect(alice.messages()).toEqual([]);
    });

    test('readable errors: unreachable, no handshake in time, no base URL', async () => {
        const port = await closedPort();
        const unreachable = await createRealtimeClient({ url: `http://127.0.0.1:${port}` }).connect('/x').catch((e: unknown) => e);
        expect(unreachable).toBeInstanceOf(RealtimeError);
        expect((unreachable as Error).message).toBe(`WebSocket connection to ws://127.0.0.1:${port}/x failed: can't reach the server (ECONNREFUSED)`);

        const started = Date.now();
        const before = server.upgraded.size;
        await expect(client.connect('/hang', { timeout: 300 })).rejects.toThrow(/no connection within 300 ms/);
        expect(Date.now() - started).toBeLessThan(2000);
        await expect.poll(() => server.upgraded.size, { message: 'the client dropped the socket', timeout: 2000 }).toBe(before);

        await expect(createRealtimeClient().connect('/x')).rejects.toThrow(/PW_REALTIME_URL/);
    });
});

test.describe('realtime — SSE', () => {
    test.describe.configure({ mode: 'serial' });
    let server: TestServer;
    let client: RealtimeClient;

    test.beforeAll(async () => {
        server = await startServer();
    });
    test.afterAll(async () => {
        await server.close();
    });
    test.beforeEach(() => {
        client = createRealtimeClient({ url: server.base.replace('http', 'ws'), timeout: 2000 });
    });
    test.afterEach(async () => {
        await client.closeAll();
    });

    test('events by type and content; status, headers and the last id', async () => {
        const sse = await client.subscribe('/events', { lastEventId: '41' });
        expect(sse.url).toBe(`${server.base}/events`);
        expect(sse.status).toBe(200);
        expect(sse.headers['x-stream']).toBe('orders');
        expect(server.sseRequests.at(-1)?.headers.accept).toBe('text/event-stream');

        expect((await sse.waitForMessage(undefined, { event: 'auth' })).json()).toEqual({ authorization: null, lastEventId: '41' });
        const second = await sse.waitForMessage({ n: 2 }, { event: 'tick' });
        expect(second).toMatchObject({ event: 'tick', id: '2' });
        const [third, fourth] = await sse.waitForMessages(2, undefined, { event: 'tick' });
        expect([third.id, fourth.id]).toEqual(['1', '3']); // tick 1 hadn't been returned yet
        expect(sse.lastEventId).not.toBeUndefined();
        await sse.close();
        expect(sse.isOpen).toBe(false);
    });

    test('the server ending the stream fails a pending wait at once', async () => {
        const sse = await client.subscribe('/events?end');
        const started = Date.now();
        const error = await sse.waitForMessage({ n: 99 }, { timeout: 5000 }).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/^Waited for JSON containing \{"n":99\} on http:\S+: the server ended the stream; 4 message\(s\) arrived: .*tick: "\{\\"n\\":3\}"$/);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(sse.isOpen).toBe(false);
    });

    test('auth token, a refused stream, and a response that is not a stream', async () => {
        const authed = createRealtimeClient({ url: server.base, authToken: 'tok' });
        try {
            const sse = await authed.subscribe('/events');
            expect((await sse.waitForMessage(undefined, { event: 'auth' })).json()).toMatchObject({ authorization: 'Bearer tok' });
        } finally {
            await authed.closeAll();
        }

        const refused = await client.subscribe('/events-private').catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(RealtimeError);
        expect(refused).toMatchObject({ status: 401, body: '{"error":"token expired"}' });
        expect((refused as Error).message).toBe(`SSE stream to ${server.base}/events-private failed: the server answered 401 Unauthorized: {"error":"token expired"}`);

        const html = await client.subscribe('/page').catch((e: unknown) => e);
        expect((html as RealtimeError).status).toBeUndefined();
        expect((html as Error).message).toMatch(/the response is text\/html, not text\/event-stream: <h1>not a stream<\/h1>/);
    });

    test('no response in time, and an unreachable server', async () => {
        await expect(client.subscribe('/slow-events', { timeout: 300 })).rejects.toThrow(/no response within 300 ms/);
        const port = await closedPort();
        await expect(createRealtimeClient({ url: `http://127.0.0.1:${port}` }).subscribe('/x')).rejects.toThrow(`SSE stream to http://127.0.0.1:${port}/x failed: can't reach the server (ECONNREFUSED)`);
    });
});
