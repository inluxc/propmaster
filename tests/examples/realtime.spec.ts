/**
 * Realtime Fixture — Example Tests
 *
 * WebSocket and Server-Sent Events with `realtimeClient` and the
 * RealtimeSteps class, against echo-server: it echoes WebSocket messages on
 * any path (after a greeting) and streams SSE on `/.sse` (the request it got,
 * then the time every second).
 *
 * Prerequisites:
 *   - `docker compose -f compose.test.yaml up -d --wait echo-server`
 *   - PW_REALTIME_URL=http://localhost:8091, or `realtime` in environments.json
 */

import { test, expect, RealtimeError } from '../../src';
import { RealtimeSteps } from '../../src/steps';

test.describe('Realtime Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-RT-001] WebSocket: send and wait for the reply', { tag: ['@TC-RT-001'] }, async ({ realtimeClient }) => {
        const ws = await realtimeClient.connect('/.ws');

        await test.step('Step 1: Verify the server greets the new connection', async () => {
            const greeting = await ws.waitForMessage(/^Request served by /);
            expect(greeting.binary).toBe(false);
        });

        await test.step('Step 2: Send text and JSON, and wait for each reply', async () => {
            await ws.send('ping');
            await ws.waitForMessage('ping');
            const orderId = `o-${test.info().testId}`;
            await ws.send({ type: 'order.created', orderId });
            const reply = await ws.waitForMessage({ type: 'order.created', orderId }); // a JSON subset
            expect(reply.json()).toEqual({ type: 'order.created', orderId });
        });

        await test.step('Step 3: Verify everything that arrived, in order', async () => {
            expect(ws.messages().map((m) => m.data).slice(1)).toEqual(['ping', expect.stringContaining('order.created')]);
        });
    });

    test('[TC-RT-002] WebSocket steps, bytes and closing', { tag: ['@TC-RT-002'] }, async ({ realtimeClient }) => {
        const realtime = new RealtimeSteps(realtimeClient);
        const ws = await realtime.connect('Open a WebSocket', '/.ws');

        await realtime.sendAndExpect('Verify a JSON message comes back', ws, { op: 'subscribe', channel: 'prices' }, { op: 'subscribe' });

        await test.step('Step 1: Send bytes and get the same bytes back', async () => {
            await ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
            const reply = await ws.waitForMessage((m) => m.binary);
            expect(reply.bytes.toString('hex')).toBe('deadbeef');
        });

        await test.step('Step 2: Close the connection with a code and reason', async () => {
            // close() returns the server's answer: echo-server confirms the code without repeating the reason
            expect(await ws.close(1000, 'test done')).toMatchObject({ code: 1000 });
            expect(ws.isOpen).toBe(false);
        });
    });

    test('[TC-RT-003] SSE: wait for events by type', { tag: ['@TC-RT-003'] }, async ({ realtimeClient }) => {
        const sse = await realtimeClient.subscribe('/.sse');

        await test.step('Step 1: Verify the stream response', async () => {
            expect(sse.status).toBe(200);
            expect(sse.headers['content-type']).toContain('text/event-stream');
        });

        await test.step('Step 2: Wait for the next two time events', async () => {
            const [first, second] = await sse.waitForMessages(2, /^\d{4}-\d\d-\d\dT/, { event: 'time', timeout: 5000 });
            expect(Number(second.id)).toBe(Number(first.id) + 1);
            expect(sse.lastEventId).toBeDefined();
        });
    });

    test('[TC-RT-004] headers and the bearer token reach the server', { tag: ['@TC-RT-004'] }, async ({ realtimeClient }) => {
        const realtime = new RealtimeSteps(realtimeClient);
        realtimeClient.setAuthToken('example-token');
        realtimeClient.setHeader('X-Tenant', 'acme');

        const sse = await realtime.subscribe('Subscribe with a token and a tenant header', '/.sse', { lastEventId: '41' });

        await realtime.expectEvent('Verify the server got them (it echoes the request as the first event)', sse, (e) => {
            return e.data.includes('Authorization: Bearer example-token') && e.data.includes('X-Tenant: acme') && e.data.includes('Last-Event-Id: 41');
        }, { event: 'request' });

        await test.step('Step 1: Connect without the token', async () => {
            const sseAnonymous = await realtimeClient.subscribe('/.sse', { auth: false });
            const request = await sseAnonymous.waitForMessage(undefined, { event: 'request' });
            expect(request.data).not.toContain('Authorization');
        });
    });

    test('[TC-RT-005] readable errors', { tag: ['@TC-RT-005'] }, async ({ realtimeClient }) => {
        await test.step('Step 1: A response that is not an event stream', async () => {
            const error = await realtimeClient.subscribe('/not-a-stream').catch((e: unknown) => e);
            expect(error).toBeInstanceOf(RealtimeError);
            expect((error as Error).message).toMatch(/failed: the response is text\/plain, not text\/event-stream/);
        });

        await test.step('Step 2: A wait that times out lists what arrived', async () => {
            const ws = await realtimeClient.connect('/.ws');
            await expect(ws.waitForMessage('never sent', { timeout: 500 })).rejects.toThrow(/nothing matched within 500 ms; 1 message\(s\) arrived: "Request served by /);
        });
    });
});
