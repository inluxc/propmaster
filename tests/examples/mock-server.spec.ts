/**
 * Example tests for the mock-server fixture (WireMock).
 *
 * In a real suite your backend calls the third-party API, configured to use
 * `mockServer.url` instead of the provider. Here `fetch` stands in for the
 * backend, so the examples run with nothing but WireMock:
 *
 *   PW_MOCK_URL=http://localhost:8089   (or PW_MOCK_CONTAINER=true)
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from '../../src';
import { MockServerSteps } from '../../src/steps';

/** Stand-in for the app's payment-provider client. */
async function charge(base: string, orderId: string, amount: number) {
    const res = await fetch(`${base}/v1/charges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_test_123' },
        body: JSON.stringify({ orderId, amount, currency: 'eur' }),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

test.describe('Mock Server Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-MCK-001] stub a payment provider for the app', { tag: ['@TC-MCK-001'] }, async ({ mockServer }) => {
        const mocks = new MockServerSteps(mockServer);
        const orderId = randomUUID(); // unique per test, so parallel tests never share a stub

        await mocks.stub('Step 1: Stub a successful charge for this order', { method: 'POST', path: '/v1/charges', body: { orderId } }, {
            status: 201,
            json: { id: 'ch_123', status: 'succeeded' },
        });

        await test.step('Step 2: The app charges the order and gets the stubbed answer', async () => {
            const res = await charge(mockServer.url, orderId, 4999);
            expect(res).toEqual({ status: 201, body: { id: 'ch_123', status: 'succeeded' } });
        });
    });

    test('[TC-MCK-002] verify the call the app made', { tag: ['@TC-MCK-002'] }, async ({ mockServer }) => {
        const mocks = new MockServerSteps(mockServer);
        const orderId = randomUUID();
        await mockServer.stub({ method: 'POST', path: '/v1/charges', body: { orderId } }, { status: 201, json: { id: 'ch_1' } });

        await test.step('Step 1: The app charges the order', async () => {
            await charge(mockServer.url, orderId, 1500);
        });

        const [call] = await mocks.verifyCalled('Step 2: Verify exactly one charge for this order', { method: 'POST', path: '/v1/charges', body: { orderId } }, 1);

        await test.step('Step 3: Verify what was sent', async () => {
            expect(call.json).toEqual({ orderId, amount: 1500, currency: 'eur' });
            expect(call.headers.authorization).toBe('Bearer sk_test_123');
        });
    });

    test('[TC-MCK-003] fail twice, then succeed, to test retries', { tag: ['@TC-MCK-003'] }, async ({ mockServer }) => {
        const mocks = new MockServerSteps(mockServer);
        const orderId = randomUUID();
        await mocks.stubSequence('Step 1: Stub two outages, then success', { method: 'POST', path: '/v1/charges', body: { orderId } }, [
            { status: 503, json: { error: 'unavailable' } },
            { status: 503, json: { error: 'unavailable' } },
            { status: 201, json: { id: 'ch_retry' } },
        ]);

        await test.step('Step 2: An app retrying up to 3 times ends up charged', async () => {
            const statuses: number[] = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                const res = await charge(mockServer.url, orderId, 100);
                statuses.push(res.status);
                if (res.status === 201) break;
            }
            expect(statuses).toEqual([503, 503, 201]);
        });

        await test.step('Step 3: Later calls keep the last answer', async () => {
            expect((await charge(mockServer.url, orderId, 100)).status).toBe(201);
        });
    });

    test('[TC-MCK-004] simulate a slow provider and a dropped connection', { tag: ['@TC-MCK-004'] }, async ({ mockServer }) => {
        const slowId = randomUUID();
        const brokenId = randomUUID();
        await mockServer.stub({ method: 'POST', path: '/v1/charges', body: { orderId: slowId } }, { status: 201, json: {}, delayMs: 700 });
        await mockServer.stub({ method: 'POST', path: '/v1/charges', body: { orderId: brokenId } }, { fault: 'CONNECTION_RESET_BY_PEER' });

        await test.step('Step 1: Verify the slow response takes at least the delay', async () => {
            const start = Date.now();
            await charge(mockServer.url, slowId, 1);
            expect(Date.now() - start).toBeGreaterThanOrEqual(650);
        });

        await test.step('Step 2: Verify the dropped connection fails the call', async () => {
            await expect(charge(mockServer.url, brokenId, 1)).rejects.toThrow();
        });
    });

    test('[TC-MCK-005] match on query and headers; check a call never happened', { tag: ['@TC-MCK-005'] }, async ({ mockServer }) => {
        const mocks = new MockServerSteps(mockServer);
        const customer = `cus_${randomUUID().slice(0, 8)}`;
        await mockServer.stub(
            { method: 'GET', path: '/v1/customers', query: { email: /@example\.test$/, id: customer }, headers: { Authorization: /^Bearer / } },
            { json: { data: [{ id: customer }] } },
        );

        await test.step('Step 1: The app looks the customer up', async () => {
            const res = await fetch(`${mockServer.url}/v1/customers?id=${customer}&email=ann@example.test`, { headers: { Authorization: 'Bearer sk_test' } });
            expect((await res.json()).data[0].id).toBe(customer);
        });

        await mocks.verifyNotCalled('Step 2: Verify no refund was requested', { method: 'POST', pathPattern: /^\/v1\/refunds/, bodyContains: customer });
    });

    test('[TC-MCK-006] a failed verify lists the calls that did arrive', { tag: ['@TC-MCK-006'] }, async ({ mockServer }) => {
        const orderId = randomUUID();

        await test.step('Step 1: The app calls a slightly wrong path', async () => {
            await fetch(`${mockServer.url}/v1/charge`, { method: 'POST', body: JSON.stringify({ orderId }) });
        });

        await test.step('Step 2: Verify the error lists what the app actually called', async () => {
            await expect(mockServer.verify({ method: 'POST', path: '/v1/charges', body: { orderId } })).rejects.toThrow(/closest requests since the test started: POST \/v1\/charge /);
        });
    });

    test('[TC-MCK-007] a removed stub stops answering', { tag: ['@TC-MCK-007'] }, async ({ mockServer }) => {
        const orderId = randomUUID();
        const stub = await mockServer.stub({ method: 'POST', path: '/v1/charges', body: { orderId } }, { status: 201, json: {} });

        await test.step('Step 1: Remove the stub mid-test', async () => {
            expect((await charge(mockServer.url, orderId, 1)).status).toBe(201);
            await stub.remove();
        });

        await test.step('Step 2: Verify WireMock now answers 404 (no stub matches)', async () => {
            expect((await charge(mockServer.url, orderId, 1)).status).toBe(404);
        });
    });
});
