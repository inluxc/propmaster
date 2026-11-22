/**
 * Realtime fixture: test WebSocket and Server-Sent Events (SSE) APIs
 * directly, without a browser. Open a connection, send messages, wait for the
 * one you expect, and check everything that arrived.
 *
 * - WebSocket: `connect(url)` through the `ws` package (an optional
 *   dependency, loaded on first use). It sends headers and subprotocols, and
 *   when the server refuses the handshake the error has its status and body.
 * - SSE: `subscribe(url)` with Node's built-in fetch; no package needed.
 *
 * Every connection keeps what it received. `waitForMessage()` returns the
 * first matching message that no earlier wait returned, whether it already
 * arrived or is still to come, so "send, then wait for the reply" has no race.
 * When the connection closes, a pending wait fails at once and says so.
 * Connections still open when the test ends are closed.
 */

import type { AuthConfig, RealtimeFixtureConfig } from '../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { authApplies, bearerSource } from '../auth/apply.js';
import { FixtureOperationError } from '../errors.js';
import { loadOptional } from './optional-package.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A message received on a WebSocket. */
export interface WebSocketMessage {
    /** The message as text (a binary message decoded as UTF-8). */
    readonly data: string;
    /** True for a binary frame. */
    readonly binary: boolean;
    /** The raw bytes. */
    readonly bytes: Buffer;
    readonly receivedAt: Date;
    /** `data` parsed as JSON; throws a readable error when it isn't JSON. */
    json<T = unknown>(): T;
}

/** An event received on an SSE stream. */
export interface SseEvent {
    /** The `event:` field, or `message` when the server sent none. */
    readonly event: string;
    /** The `data:` lines, joined with newlines. */
    readonly data: string;
    /** The `id:` field of this event, if it had one. */
    readonly id: string | undefined;
    /** The `retry:` field of this event, if it had one. */
    readonly retry: number | undefined;
    readonly receivedAt: Date;
    /** `data` parsed as JSON; throws a readable error when it isn't JSON. */
    json<T = unknown>(): T;
}

/**
 * Which message to wait for:
 * - a function: any condition
 * - a string: the exact text
 * - a RegExp: tested against the text
 * - an object or array: the message parsed as JSON contains these fields and values
 */
export type MessageMatcher<M> = ((message: M) => boolean) | string | RegExp | Record<string, unknown> | unknown[];

export interface RealtimeWaitOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
}

export interface SseWaitOptions extends RealtimeWaitOptions {
    /** Only events of this type (the `event:` field). */
    event?: string;
}

export interface CloseInfo {
    /** The close code, e.g. 1000 (normal), 1006 (dropped without a close frame), 1008 (policy). */
    code: number;
    reason: string;
}

interface Connection<M, W extends RealtimeWaitOptions> {
    readonly url: string;
    /** True until the connection closes. */
    readonly isOpen: boolean;
    /** Everything received so far, oldest first. */
    messages(): M[];
    /** The first matching message no earlier wait returned. Throws on timeout or close, listing what arrived. */
    waitForMessage(matcher?: MessageMatcher<M>, options?: W): Promise<M>;
    /** The next `count` matching messages no earlier wait returned, in order. */
    waitForMessages(count: number, matcher?: MessageMatcher<M>, options?: W): Promise<M[]>;
}

export interface WebSocketConnection extends Connection<WebSocketMessage, RealtimeWaitOptions> {
    /** The subprotocol the server picked (`''` when none). */
    readonly protocol: string;
    /** Sends text, bytes (a Buffer or Uint8Array), or anything else as JSON. */
    send(message: string | Buffer | Uint8Array | object | number | boolean): Promise<void>;
    /** Resolves with the close code and reason once the connection closes (by either side). */
    waitForClose(options?: RealtimeWaitOptions): Promise<CloseInfo>;
    /** Closes the connection (default code 1000) and returns the code and reason the server answered with. */
    close(code?: number, reason?: string): Promise<CloseInfo>;
}

export interface SseConnection extends Connection<SseEvent, SseWaitOptions> {
    /** HTTP status of the stream response (200). */
    readonly status: number;
    /** Response headers, lowercase names. */
    readonly headers: Record<string, string>;
    /** The last `id:` the server sent (what a reconnecting client sends as `Last-Event-ID`). */
    readonly lastEventId: string | undefined;
    /** Stops reading the stream. */
    close(): Promise<void>;
}

export interface RealtimeConnectOptions {
    /** Extra headers for this connection. */
    headers?: Record<string, string>;
    /** Milliseconds to wait for the connection (default: the config's `connectTimeout`, else 10000). */
    timeout?: number;
    /** `false`: don't send the auth token, e.g. to check that an anonymous connection is refused. */
    auth?: boolean;
}

export interface WebSocketConnectOptions extends RealtimeConnectOptions {
    /** Subprotocols to offer (`Sec-WebSocket-Protocol`). */
    protocols?: string | string[];
}

export interface SseSubscribeOptions extends RealtimeConnectOptions {
    /** Sent as `Last-Event-ID`, to resume a stream. */
    lastEventId?: string;
}

/** Client exposed to tests as `realtimeClient`. */
export interface RealtimeClient {
    /** The base URL relative URLs resolve against (`realtime.url`), if set. */
    readonly url: string | undefined;
    /** Opens a WebSocket. `url` may be relative to `realtime.url`; http(s) becomes ws(s). */
    connect(url?: string, options?: WebSocketConnectOptions): Promise<WebSocketConnection>;
    /** Opens an SSE stream. `url` may be relative to `realtime.url`; ws(s) becomes http(s). */
    subscribe(url?: string, options?: SseSubscribeOptions): Promise<SseConnection>;
    /** A header sent on every later connection. */
    setHeader(name: string, value: string): void;
    /** Bearer token for later connections (`undefined` removes it). */
    setAuthToken(token: string | undefined): void;
    /** Closes every connection this client opened. */
    closeAll(): Promise<void>;
}

/**
 * A connection that failed: refused handshake (with `status` and `body`),
 * unreachable server, or timeout.
 */
export class RealtimeError extends FixtureOperationError {
    constructor(
        operation: 'connect' | 'subscribe',
        public readonly url: string,
        reason: string,
        /** HTTP status the server answered with instead of opening the connection. */
        public readonly status?: number,
        /** The start of the response body, when there was one. */
        public readonly body?: string,
        cause?: Error,
    ) {
        super('realtime', operation, { url, ...(status ? { status } : {}), reason }, cause);
        const kind = operation === 'connect' ? 'WebSocket' : 'SSE';
        this.message = `${kind} ${operation === 'connect' ? 'connection' : 'stream'} to ${url} failed: ${reason}`;
        this.name = 'RealtimeError';
    }
}

type RealtimeOperation = 'connect' | 'subscribe' | 'send' | 'waitForMessage' | 'waitForClose' | 'json';

/** A FixtureOperationError whose message is plain text (details stay on the error). */
function operationError(operation: RealtimeOperation, details: Record<string, unknown>, message: string, cause?: Error): FixtureOperationError {
    const error = new FixtureOperationError('realtime', operation, details, cause);
    error.message = message;
    return error;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

export const DEFAULT_REALTIME_TIMEOUT = 10_000;
const BODY_LIMIT = 500;

/**
 * Absolute URL for a connection: `input` resolved against `base`, with the
 * scheme switched to ws(s) for a WebSocket or http(s) for SSE.
 */
export function resolveRealtimeUrl(input: string | undefined, base: string | undefined, kind: 'ws' | 'sse'): string {
    let url: URL;
    try {
        url = input && /^[a-z][a-z0-9+.-]*:/i.test(input) ? new URL(input) : new URL(input ?? '', base);
    } catch {
        const what = input ? `'${input}'` : 'no URL';
        const reason = base
            ? `${what} isn't a valid URL relative to ${base}`
            : `${what} needs a base URL: set PW_REALTIME_URL (e.g. http://localhost:8080) or realtime.url, or pass an absolute URL`;
        throw operationError(kind === 'ws' ? 'connect' : 'subscribe', { url: input, reason }, reason);
    }
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        const reason = `unsupported scheme ${url.protocol} in ${url.href} (use http(s) or ws(s))`;
        throw operationError(kind === 'ws' ? 'connect' : 'subscribe', { url: url.href, reason }, reason);
    }
    url.protocol = kind === 'ws' ? (secure ? 'wss:' : 'ws:') : secure ? 'https:' : 'http:';
    return url.href;
}

/** True when `actual` contains everything in `expected`: objects by key (deep), arrays element by element. */
export function containsSubset(actual: unknown, expected: unknown): boolean {
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => containsSubset(actual[i], e));
    }
    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
        return Object.entries(expected).every(([k, v]) => containsSubset((actual as Record<string, unknown>)[k], v));
    }
    return Object.is(actual, expected);
}

/** A matcher as a predicate on a message's text and JSON. */
export function toPredicate<M extends { data: string }>(matcher: MessageMatcher<M> | undefined): (message: M) => boolean {
    if (matcher === undefined) return () => true;
    if (typeof matcher === 'function') return matcher;
    if (typeof matcher === 'string') return (m) => m.data === matcher;
    if (matcher instanceof RegExp) return (m) => new RegExp(matcher.source, matcher.flags.replace('g', '')).test(m.data);
    return (m) => {
        try {
            return containsSubset(JSON.parse(m.data), matcher);
        } catch {
            return false;
        }
    };
}

export function describeMatcher(matcher: MessageMatcher<unknown> | undefined): string {
    if (matcher === undefined) return 'any message';
    if (typeof matcher === 'function') return 'a message matching the condition';
    if (typeof matcher === 'string') return `the text ${JSON.stringify(truncate(matcher, 80))}`;
    if (matcher instanceof RegExp) return `a message matching ${matcher}`;
    return `JSON containing ${truncate(JSON.stringify(matcher), 120)}`;
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseJson<T>(data: string, what: string): T {
    try {
        return JSON.parse(data) as T;
    } catch (error) {
        const reason = `the ${what} isn't JSON: ${JSON.stringify(truncate(data, 100))}`;
        throw operationError('json', { reason }, reason, error instanceof Error ? error : undefined);
    }
}

function describeOne(m: { data: string; event?: string }): string {
    const text = JSON.stringify(truncate(m.data, 80));
    return m.event !== undefined ? `${m.event}: ${text}` : text;
}

/** The last few messages, for error messages. */
export function describeArrived(items: readonly { data: string; event?: string }[]): string {
    if (!items.length) return 'nothing arrived';
    const shown = items.slice(-5).map(describeOne).join(', ');
    return `${items.length} message(s) arrived${items.length > 5 ? ', the last 5' : ''}: ${shown}`;
}

/**
 * An incremental parser for the `text/event-stream` format: feed it text as
 * it arrives, get back the complete events. Follows the HTML spec: `:` lines
 * are comments, a field without a colon has an empty value, one space after
 * the colon is dropped, `data` lines join with `\n`, and a blank line ends an
 * event (one without data is not dispatched).
 */
export class SseParser {
    private buffer = '';
    private data: string[] = [];
    private event = '';
    private id: string | undefined;
    private retry: number | undefined;
    private hasData = false;
    private first = true;
    /** The last `id:` seen, kept across events. */
    lastEventId: string | undefined;

    push(chunk: string): SseEvent[] {
        if (this.first && chunk) {
            chunk = chunk.replace(/^﻿/, '');
            this.first = false;
        }
        this.buffer += chunk;
        const events: SseEvent[] = [];
        for (;;) {
            const m = /\r\n|\r|\n/.exec(this.buffer);
            if (!m) break;
            // A CR at the very end may be the first half of CRLF: wait for more.
            if (m[0] === '\r' && m.index === this.buffer.length - 1) break;
            const line = this.buffer.slice(0, m.index);
            this.buffer = this.buffer.slice(m.index + m[0].length);
            const event = this.line(line);
            if (event) events.push(event);
        }
        return events;
    }

    /** The stream ended: an event without its blank line is dropped, as browsers do. */
    end(): void {
        this.buffer = '';
        this.reset();
    }

    private line(line: string): SseEvent | undefined {
        if (line === '') return this.dispatch();
        if (line.startsWith(':')) return undefined;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
            case 'data':
                this.data.push(value);
                this.hasData = true;
                break;
            case 'event':
                this.event = value;
                break;
            case 'id':
                if (!value.includes('\0')) {
                    this.id = value;
                    this.lastEventId = value;
                }
                break;
            case 'retry':
                if (/^\d+$/.test(value)) this.retry = parseInt(value, 10);
                break;
            default:
                break;
        }
        return undefined;
    }

    private dispatch(): SseEvent | undefined {
        const event = this.hasData ? makeSseEvent(this.event || 'message', this.data.join('\n'), this.id, this.retry) : undefined;
        this.reset();
        return event;
    }

    private reset(): void {
        this.data = [];
        this.event = '';
        this.id = undefined;
        this.retry = undefined;
        this.hasData = false;
    }
}

function makeSseEvent(event: string, data: string, id: string | undefined, retry: number | undefined): SseEvent {
    return { event, data, id, retry, receivedAt: new Date(), json: <T>() => parseJson<T>(data, `'${event}' event`) };
}

function makeWsMessage(bytes: Buffer, binary: boolean): WebSocketMessage {
    const data = bytes.toString('utf8');
    return { data, binary, bytes, receivedAt: new Date(), json: <T>() => parseJson<T>(data, 'message') };
}

// ─── Message log ────────────────────────────────────────────────────────────

/** What a connection received, plus waiters that wake on each new message or on close. */
class MessageLog<M extends { data: string; event?: string }> {
    readonly items: M[] = [];
    private readonly taken = new Set<M>();
    private readonly listeners = new Set<() => void>();
    /** Why the connection is over, once it is. */
    ended: string | undefined;

    push(item: M): void {
        this.items.push(item);
        for (const l of [...this.listeners]) l();
    }

    end(reason: string): void {
        if (this.ended !== undefined) return;
        this.ended = reason;
        for (const l of [...this.listeners]) l();
    }

    async take(count: number, match: (m: M) => boolean, timeout: number, fail: (reason: string) => Error): Promise<M[]> {
        const found: M[] = [];
        const collect = () => {
            for (const m of this.items) {
                if (found.length >= count) break;
                if (!this.taken.has(m) && !found.includes(m) && match(m)) found.push(m);
            }
        };
        const deadline = Date.now() + timeout;
        for (;;) {
            collect();
            if (found.length >= count) {
                for (const m of found) this.taken.add(m);
                return found;
            }
            const have = found.length ? `; ${found.length} of ${count} matched` : '';
            if (this.ended !== undefined) throw fail(`${this.ended}${have}; ${describeArrived(this.items)}`);
            const left = deadline - Date.now();
            if (left <= 0) throw fail(`nothing matched within ${timeout} ms${have}; ${describeArrived(this.items)}`);
            found.length = 0;
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    this.listeners.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, left);
                this.listeners.add(wake);
            });
        }
    }
}

// ─── ws (optional package) ──────────────────────────────────────────────────

/** The parts of the `ws` package the fixture uses (declared here so the types don't need @types/ws). */
interface WsSocket {
    readonly readyState: number;
    readonly protocol: string;
    send(data: string | Buffer | Uint8Array, cb: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'open', fn: () => void): this;
    on(event: 'message', fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
    on(event: 'close', fn: (code: number, reason: Buffer) => void): this;
    on(event: 'error', fn: (err: Error) => void): this;
    on(event: 'unexpected-response', fn: (req: { destroy(): void }, res: IncomingLike) => void): this;
}
interface IncomingLike {
    statusCode?: number;
    statusMessage?: string;
    on(event: 'data', fn: (chunk: Buffer) => void): this;
    on(event: 'end' | 'close', fn: () => void): this;
    on(event: 'error', fn: (err: Error) => void): this;
    destroy(): void;
}
type WsConstructor = new (url: string, protocols: string[] | undefined, options: Record<string, unknown>) => WsSocket;

async function loadWs(): Promise<WsConstructor> {
    const mod = await loadOptional<{ default?: WsConstructor; WebSocket?: WsConstructor }>('ws', 'realtimeClient');
    return (mod.WebSocket ?? mod.default) as WsConstructor;
}

const OPEN = 1;

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

/** Why a connection attempt failed, in words. */
function networkReason(error: Error): string {
    const code = (error as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `can't reach the server (${code})`;
    return error.message || String(error);
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface RealtimeClientOptions {
    /** Bearer token source (the auth helpers), used when no token is set in the config. */
    bearer?: () => Promise<string>;
}

/** Builds a realtime client. The fixture closes its connections after the test; elsewhere, call `closeAll()`. */
export function createRealtimeClient(config: RealtimeFixtureConfig = {}, options: RealtimeClientOptions = {}): RealtimeClient {
    const waitDefault = config.timeout ?? DEFAULT_REALTIME_TIMEOUT;
    const connectDefault = config.connectTimeout ?? DEFAULT_REALTIME_TIMEOUT;
    const extraHeaders: Record<string, string> = { ...(config.headers ?? {}) };
    let token: string | undefined = config.authToken;
    const open = new Set<{ close(): Promise<unknown> }>();

    async function headersFor(opts: RealtimeConnectOptions): Promise<Record<string, string>> {
        const headers: Record<string, string> = { ...extraHeaders, ...(opts.headers ?? {}) };
        const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
        if (opts.auth !== false && !hasAuth) {
            const bearer = token ?? (options.bearer ? await options.bearer() : undefined);
            if (bearer) headers.Authorization = `Bearer ${bearer}`;
        }
        if (opts.auth === false) {
            for (const h of Object.keys(headers)) if (h.toLowerCase() === 'authorization') delete headers[h];
        }
        return headers;
    }

    async function connect(input?: string, opts: WebSocketConnectOptions = {}): Promise<WebSocketConnection> {
        const url = resolveRealtimeUrl(input, config.url, 'ws');
        const [Ws, headers] = await Promise.all([loadWs(), headersFor(opts)]);
        const protocols = opts.protocols === undefined ? undefined : Array.isArray(opts.protocols) ? opts.protocols : [opts.protocols];
        const timeout = opts.timeout ?? connectDefault;
        const log = new MessageLog<WebSocketMessage>();
        let closeInfo: CloseInfo | undefined;
        let self: WebSocketConnection | undefined;
        const closeWaiters = new Set<(info: CloseInfo) => void>();

        const socket = await new Promise<WsSocket>((resolve, reject) => {
            let settled = false;
            const fail = (reason: string, status?: number, body?: string, cause?: Error) => {
                if (settled) return;
                settled = true;
                reject(new RealtimeError('connect', url, reason, status, body, cause));
            };
            const ws = new Ws(url, protocols, { headers, handshakeTimeout: timeout });
            ws.on('unexpected-response', (req, res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                const done = () => {
                    req.destroy();
                    const body = Buffer.concat(chunks).toString('utf8').slice(0, BODY_LIMIT).trim();
                    const status = res.statusCode ?? 0;
                    fail(`the server answered ${status}${res.statusMessage ? ` ${res.statusMessage}` : ''} instead of opening the connection${body ? `: ${truncate(body, 200)}` : ''}`, status, body);
                };
                res.on('data', (c) => {
                    if (size < BODY_LIMIT) chunks.push(c);
                    size += c.length;
                });
                res.on('end', done);
                res.on('close', done);
                res.on('error', done);
            });
            ws.on('open', () => {
                settled = true;
                resolve(ws);
            });
            ws.on('error', (err) => {
                if (settled) return;
                const reason = /handshake has timed out/i.test(err.message)
                    ? `no connection within ${timeout} ms`
                    : /subprotocol/i.test(err.message) && protocols?.length
                      ? `the server accepted none of the subprotocols offered (${protocols.join(', ')}): ${err.message}`
                      : networkReason(err);
                fail(reason, undefined, undefined, err);
            });
            ws.on('message', (data, isBinary) => log.push(makeWsMessage(toBuffer(data), isBinary)));
            ws.on('close', (code, reason) => {
                closeInfo = { code, reason: reason.toString('utf8') };
                log.end(`the connection closed (code ${code}${closeInfo.reason ? `: ${closeInfo.reason}` : ''})`);
                for (const w of [...closeWaiters]) w(closeInfo);
                closeWaiters.clear();
                if (self) open.delete(self);
                if (!settled) fail(`the connection closed during the handshake (code ${code})`);
            });
        });

        const waitClosed = (ms: number): Promise<CloseInfo | undefined> =>
            closeInfo
                ? Promise.resolve(closeInfo)
                : new Promise((resolve) => {
                      const timer = setTimeout(() => {
                          closeWaiters.delete(done);
                          resolve(undefined);
                      }, ms);
                      const done = (info: CloseInfo) => {
                          clearTimeout(timer);
                          resolve(info);
                      };
                      closeWaiters.add(done);
                  });

        const waitFail = (count: number, matcher: MessageMatcher<WebSocketMessage> | undefined) => (reason: string) => {
            const waitedFor = `${count === 1 ? '' : `${count} × `}${describeMatcher(matcher as MessageMatcher<unknown>)}`;
            return operationError('waitForMessage', { url, waitedFor, reason }, `Waited for ${waitedFor} on ${url}: ${reason}`);
        };

        const connection: WebSocketConnection = {
            url,
            get protocol() {
                return socket.protocol;
            },
            get isOpen() {
                return socket.readyState === OPEN;
            },
            messages: () => [...log.items],
            async waitForMessage(matcher, wait) {
                const [m] = await log.take(1, toPredicate(matcher), wait?.timeout ?? waitDefault, waitFail(1, matcher));
                return m;
            },
            async waitForMessages(count, matcher, wait) {
                return log.take(count, toPredicate(matcher), wait?.timeout ?? waitDefault, waitFail(count, matcher));
            },
            async send(message) {
                if (socket.readyState !== OPEN) {
                    const reason = log.ended ?? 'the connection is not open';
                    throw operationError('send', { url, reason }, `Can't send on ${url}: ${reason}`);
                }
                const payload = typeof message === 'string' || Buffer.isBuffer(message) || message instanceof Uint8Array ? message : JSON.stringify(message);
                await new Promise<void>((resolve, reject) =>
                    socket.send(payload, (err) => (err ? reject(operationError('send', { url, reason: err.message }, `Can't send on ${url}: ${err.message}`, err)) : resolve())),
                );
            },
            async waitForClose(wait) {
                const timeout = wait?.timeout ?? waitDefault;
                const info = await waitClosed(timeout);
                if (info) return info;
                throw operationError('waitForClose', { url, timeout }, `${url} is still open after ${timeout} ms`);
            },
            async close(code = 1000, reason) {
                if (closeInfo) return closeInfo;
                try {
                    socket.close(code, reason);
                } catch {
                    socket.terminate();
                }
                const info = await waitClosed(2_000);
                if (info) return info;
                socket.terminate();
                return (await waitClosed(1_000)) ?? { code: 1006, reason: 'terminated' };
            },
        };
        self = connection;
        open.add(connection);
        return connection;
    }

    async function subscribe(input?: string, opts: SseSubscribeOptions = {}): Promise<SseConnection> {
        const url = resolveRealtimeUrl(input, config.url, 'sse');
        const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...(await headersFor(opts)) };
        if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId;
        const timeout = opts.timeout ?? connectDefault;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);

        let res: Response;
        try {
            res = await fetch(url, { headers, signal: controller.signal });
        } catch (error) {
            clearTimeout(timer);
            const err = error instanceof Error ? error : new Error(String(error));
            const cause = (err as { cause?: Error }).cause;
            const reason = controller.signal.aborted ? `no response within ${timeout} ms` : networkReason(cause ?? err);
            throw new RealtimeError('subscribe', url, reason, undefined, undefined, err);
        }
        clearTimeout(timer);

        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.toLowerCase().startsWith('text/event-stream')) {
            const body = (await res.text().catch(() => '')).slice(0, BODY_LIMIT).trim();
            controller.abort();
            const why = res.ok ? `the response is ${type || 'untyped'}, not text/event-stream` : `the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
            throw new RealtimeError('subscribe', url, `${why}${body ? `: ${truncate(body, 200)}` : ''}`, res.ok ? undefined : res.status, body);
        }

        const log = new MessageLog<SseEvent>();
        const parser = new SseParser();
        let closedByUs = false;
        let reading: Promise<void> = Promise.resolve();
        if (res.body) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            reading = (async () => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        for (const event of parser.push(decoder.decode(value, { stream: true }))) log.push(event);
                    }
                    for (const event of parser.push(decoder.decode())) log.push(event);
                    parser.end();
                    log.end('the server ended the stream');
                } catch (error) {
                    log.end(closedByUs ? 'the stream was closed' : `the stream broke: ${error instanceof Error ? error.message : String(error)}`);
                }
            })();
        } else {
            log.end('the response has no body');
        }

        const waitFail = (count: number, matcher: MessageMatcher<SseEvent> | undefined, event?: string) => (reason: string) => {
            const what = matcher === undefined && event ? `a '${event}' event` : `${event ? `a '${event}' event with ` : ''}${describeMatcher(matcher as MessageMatcher<unknown>)}`;
            const waitedFor = `${count === 1 ? '' : `${count} × `}${what}`;
            return operationError('waitForMessage', { url, waitedFor, reason }, `Waited for ${waitedFor} on ${url}: ${reason}`);
        };
        const predicate = (matcher: MessageMatcher<SseEvent> | undefined, event?: string) => {
            const p = toPredicate(matcher);
            return event === undefined ? p : (e: SseEvent) => e.event === event && p(e);
        };

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => (responseHeaders[key] = value));

        const connection: SseConnection = {
            url,
            status: res.status,
            headers: responseHeaders,
            get lastEventId() {
                return parser.lastEventId;
            },
            get isOpen() {
                return log.ended === undefined;
            },
            messages: () => [...log.items],
            async waitForMessage(matcher, wait) {
                const [e] = await log.take(1, predicate(matcher, wait?.event), wait?.timeout ?? waitDefault, waitFail(1, matcher, wait?.event));
                return e;
            },
            async waitForMessages(count, matcher, wait) {
                return log.take(count, predicate(matcher, wait?.event), wait?.timeout ?? waitDefault, waitFail(count, matcher, wait?.event));
            },
            async close() {
                open.delete(connection);
                if (log.ended !== undefined) return;
                closedByUs = true;
                controller.abort();
                await reading;
            },
        };
        open.add(connection);
        return connection;
    }

    return {
        url: config.url,
        connect,
        subscribe,
        setHeader(name, value) {
            extraHeaders[name] = value;
        },
        setAuthToken(value) {
            token = value;
        },
        async closeAll() {
            await Promise.allSettled([...open].map((c) => c.close()));
            open.clear();
        },
    };
}

/** The realtime config: the project option, else ConfigLoader (environments.json, .env, PW_REALTIME_*). */
export async function resolveRealtimeConfig(realtime: RealtimeFixtureConfig | undefined): Promise<RealtimeFixtureConfig> {
    if (realtime) return realtime;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().realtime ?? {};
    } catch {
        return {};
    }
}

/** Fixture definition for test.extend(). Connections still open are closed after the test. */
export const realtimeFixture = {
    realtimeClient: async (
        { realtime, authConfig, authRole, authTokens }: { realtime: RealtimeFixtureConfig | undefined; authConfig: AuthConfig | undefined; authRole: string | undefined; authTokens: TokenManager },
        use: (client: RealtimeClient) => Promise<void>,
    ) => {
        const config = await resolveRealtimeConfig(realtime);
        // An explicit realtime.authToken wins over the auth helpers' token.
        const bearer = !config.authToken && authApplies(authConfig, 'realtime') ? bearerSource(authTokens, authConfig!, authRole) : undefined;
        const client = createRealtimeClient(config, { bearer });
        try {
            await use(client);
        } finally {
            await client.closeAll();
        }
    },
};
