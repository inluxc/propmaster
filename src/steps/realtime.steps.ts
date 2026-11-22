/**
 * Realtime Step Class
 *
 * Reusable steps for WebSocket and Server-Sent Events APIs: open a
 * connection, send and expect a reply, wait for an event, check that a
 * connection is refused. Each method runs inside `test.step()`, so it shows
 * up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import { RealtimeError, toPredicate } from '../fixtures/realtime.fixture.js';
import type {
    MessageMatcher,
    RealtimeClient,
    RealtimeWaitOptions,
    SseConnection,
    SseEvent,
    SseSubscribeOptions,
    SseWaitOptions,
    WebSocketConnectOptions,
    WebSocketConnection,
    WebSocketMessage,
} from '../fixtures/realtime.fixture.js';

export type { RealtimeClient, WebSocketConnection, WebSocketMessage, SseConnection, SseEvent } from '../fixtures/realtime.fixture.js';

type Sendable = Parameters<WebSocketConnection['send']>[0];

export class RealtimeSteps {
    constructor(private realtimeClient: RealtimeClient) {}

    /** Opens a WebSocket. */
    async connect(description: string, url?: string, options?: WebSocketConnectOptions): Promise<WebSocketConnection> {
        let connection!: WebSocketConnection;
        await test.step(`Step: ${description}`, async () => {
            connection = await this.realtimeClient.connect(url, options);
        });
        return connection;
    }

    /** Opens an SSE stream. */
    async subscribe(description: string, url?: string, options?: SseSubscribeOptions): Promise<SseConnection> {
        let connection!: SseConnection;
        await test.step(`Step: ${description}`, async () => {
            connection = await this.realtimeClient.subscribe(url, options);
        });
        return connection;
    }

    /** Sends a message on a WebSocket. */
    async send(description: string, connection: WebSocketConnection, message: Sendable): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await connection.send(message);
        });
    }

    /** Sends a message and waits for the reply that matches `reply`. */
    async sendAndExpect(
        description: string,
        connection: WebSocketConnection,
        message: Sendable,
        reply: MessageMatcher<WebSocketMessage>,
        options?: RealtimeWaitOptions,
    ): Promise<WebSocketMessage> {
        let received!: WebSocketMessage;
        await test.step(`Step: ${description}`, async () => {
            await connection.send(message);
            received = await connection.waitForMessage(reply, options);
        });
        return received;
    }

    /**
     * Waits for a matching WebSocket message. Other clients may share the
     * server, so match on something unique to this test (an order ID).
     */
    async expectMessage(
        description: string,
        connection: WebSocketConnection,
        matcher?: MessageMatcher<WebSocketMessage>,
        options?: RealtimeWaitOptions,
    ): Promise<WebSocketMessage> {
        let message!: WebSocketMessage;
        await test.step(`Step: ${description}`, async () => {
            message = await connection.waitForMessage(matcher, options);
        });
        return message;
    }

    /** Waits for a matching SSE event; `options.event` limits it to one event type. */
    async expectEvent(description: string, connection: SseConnection, matcher?: MessageMatcher<SseEvent>, options?: SseWaitOptions): Promise<SseEvent> {
        let event!: SseEvent;
        await test.step(`Step: ${description}`, async () => {
            event = await connection.waitForMessage(matcher, options);
        });
        return event;
    }

    /** Checks that no matching message arrives within `timeout` ms (default 2000). */
    async expectNoMessage<M extends WebSocketMessage | SseEvent>(
        description: string,
        connection: WebSocketConnection | SseConnection,
        matcher?: MessageMatcher<M>,
        timeout = 2000,
    ): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const before = connection.messages().length;
            await new Promise((resolve) => setTimeout(resolve, timeout));
            const later = connection.messages().slice(before) as M[];
            const unexpected = later.filter(toPredicate(matcher));
            expect(unexpected.map((m) => m.data), 'messages that should not have arrived').toEqual([]);
        });
    }

    /** Checks that the server closes the WebSocket, optionally with this close code. */
    async expectClosed(description: string, connection: WebSocketConnection, code?: number, options?: RealtimeWaitOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const info = await connection.waitForClose(options);
            if (code !== undefined) expect(info.code, `close code (reason: ${info.reason || 'none'})`).toBe(code);
        });
    }

    /** Checks that the server refuses a WebSocket connection with this HTTP status (e.g. 401). Returns the error. */
    async expectConnectRejected(description: string, url: string | undefined, status: number, options?: WebSocketConnectOptions): Promise<RealtimeError> {
        let error!: RealtimeError;
        await test.step(`Step: ${description}`, async () => {
            error = await expectRejected(() => this.realtimeClient.connect(url, options));
            expect(error.status, error.message).toBe(status);
        });
        return error;
    }

    /** Checks that the server refuses an SSE stream with this HTTP status. Returns the error. */
    async expectSubscribeRejected(description: string, url: string | undefined, status: number, options?: SseSubscribeOptions): Promise<RealtimeError> {
        let error!: RealtimeError;
        await test.step(`Step: ${description}`, async () => {
            error = await expectRejected(() => this.realtimeClient.subscribe(url, options));
            expect(error.status, error.message).toBe(status);
        });
        return error;
    }
}

async function expectRejected(open: () => Promise<{ close(): Promise<unknown> }>): Promise<RealtimeError> {
    let connection: { close(): Promise<unknown> } | undefined;
    const error = await open().then(
        (c) => {
            connection = c;
            return undefined;
        },
        (e: unknown) => e,
    );
    if (connection) {
        await connection.close();
        throw new Error('expected the server to refuse the connection, but it opened');
    }
    expect(error).toBeInstanceOf(RealtimeError);
    return error as RealtimeError;
}
