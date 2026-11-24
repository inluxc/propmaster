/**
 * Unit tests for errorReason (src/network-error.ts): a failed request gives
 * the same reason on Node.js and Bun. The real-fetch test runs on whichever
 * runtime runs the tests; CI runs it on both.
 */

import { test, expect } from '@playwright/test';
import * as net from 'node:net';
import { errorReason } from '../../src/network-error';

test.describe('errorReason', () => {
    test('a real refused connection: fetch failed: ECONNREFUSED, on this runtime', async () => {
        // A port that was just free: nothing listens on it.
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as net.AddressInfo;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const error = await fetch(`http://127.0.0.1:${port}/`).then(() => undefined, (e: unknown) => e);
        expect(errorReason(error)).toMatch(/^fetch failed: ECONNREFUSED \(.+\)$/);
    });

    test('Node.js: the reason comes from cause', () => {
        const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), { code: 'ECONNREFUSED' }) });
        expect(errorReason(refused)).toBe('fetch failed: ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:9200)');
        const several = new TypeError('fetch failed', { cause: { message: '', errors: [{ code: 'ECONNREFUSED' }] } });
        expect(errorReason(several)).toBe('fetch failed: ECONNREFUSED');
        expect(errorReason(new TypeError('fetch failed', { cause: new Error('bad port') }))).toBe('fetch failed: bad port');
        expect(errorReason(new TypeError('fetch failed'))).toBe('fetch failed');
    });

    test('Bun: the reason is the error\'s own code and message', () => {
        const refused = Object.assign(new TypeError('ECONNREFUSED: Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
        expect(errorReason(refused)).toBe('fetch failed: ECONNREFUSED (Unable to connect. Is the computer able to access the url?)');
        const dns = Object.assign(new TypeError('getaddrinfo ENOTFOUND db.invalid'), { code: 'ENOTFOUND' });
        expect(errorReason(dns)).toBe('fetch failed: ENOTFOUND (getaddrinfo ENOTFOUND db.invalid)');
    });

    test('other errors keep their message', () => {
        expect(errorReason(new Error('HTTP 500'))).toBe('HTTP 500');
        expect(errorReason(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBe('relation "x" does not exist');
        expect(errorReason('plain')).toBe('plain');
    });
});
