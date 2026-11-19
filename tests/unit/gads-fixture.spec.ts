/**
 * Unit tests for the GADS device farm fixture.
 *
 * A local HTTP server stands in for the GADS hub: it implements
 * GET /grid/status, POST /grid/session, session commands and
 * DELETE /grid/session/:id, and records every request so tests can assert on
 * the capabilities sent and on device release.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import {
    buildCapabilities,
    createGadsHubClient,
    filterDevices,
    normalizeHubUrl,
    redactCapabilities,
    redactSecret,
    startGadsSession,
    W3C_ELEMENT_KEY,
    type GadsDeviceInfo,
} from '../../src/fixtures/gads.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { FixtureInitError, FixtureOperationError } from '../../src/errors';
import type { GadsFixtureConfig } from '../../src/config/schema';

const SECRET = 'gads-secret-s3cr3t-value';

const DEVICES: GadsDeviceInfo[] = [
    { udid: 'ios-busy', name: 'iPhone 15', os: 'ios', os_version: '17.5.1', provider: 'mac-1', available: false, in_use_by_automation: true },
    { udid: 'ios-free', name: 'iPhone 15 Pro', os: 'ios', os_version: '17.4', provider: 'mac-1', available: true, in_use_by_automation: false },
    { udid: 'and-1', name: 'Pixel 8', os: 'android', os_version: '14', provider: 'linux-1', available: true, in_use_by_automation: false },
];

interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
}

interface MockHub {
    url: string;
    requests: Recorded[];
    /** Override a route: return [status, body] or undefined to fall through. */
    override?: (req: Recorded) => [number, unknown] | undefined;
    close(): Promise<void>;
}

async function startMockHub(): Promise<MockHub> {
    const hub: MockHub = { url: '', requests: [], close: async () => { } };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const rec: Recorded = {
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body: raw ? JSON.parse(raw) : undefined,
            };
            hub.requests.push(rec);

            const send = (status: number, body: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            const o = hub.override?.(rec);
            if (o) return send(o[0], o[1]);

            if (rec.method === 'GET' && rec.url === '/grid/status') {
                if (rec.headers.authorization !== `Bearer ${SECRET}`) {
                    return send(200, { value: { ready: true, message: 'ok', queued: 0 } });
                }
                return send(200, { value: { ready: true, message: 'ok', queued: 0, devices: DEVICES } });
            }
            if (rec.method === 'POST' && rec.url === '/grid/session') {
                const caps = rec.body?.capabilities?.alwaysMatch ?? {};
                if (caps['gads:clientSecret'] !== SECRET) {
                    return send(401, { value: { error: 'session not created', message: 'Invalid client credentials' } });
                }
                const udid = caps['appium:udid'] ?? (caps.platformName === 'iOS' ? 'ios-free' : 'and-1');
                const device = DEVICES.find((d) => d.udid === udid)!;
                return send(200, {
                    value: {
                        sessionId: 'sess-1',
                        capabilities: {
                            platformName: device.os === 'ios' ? 'iOS' : 'Android',
                            'gads:deviceUdid': device.udid,
                            'gads:deviceName': device.name,
                            'gads:provider': device.provider,
                            'gads:controlUrl': `${hub.url}/devices/control/${device.udid}`,
                        },
                    },
                });
            }
            if (rec.method === 'DELETE' && rec.url === '/grid/session/sess-1') return send(200, { value: null });
            if (rec.method === 'POST' && rec.url === '/grid/session/sess-1/element') {
                if (rec.body.value === 'missing') {
                    return send(404, { value: { error: 'no such element', message: 'An element could not be located' } });
                }
                return send(200, { value: { [W3C_ELEMENT_KEY]: 'el-42' } });
            }
            if (rec.method === 'POST' && rec.url === '/grid/session/sess-1/elements') {
                return send(200, { value: rec.body.value === 'missing' ? [] : [{ [W3C_ELEMENT_KEY]: 'el-1' }, { [W3C_ELEMENT_KEY]: 'el-2' }] });
            }
            if (rec.method === 'GET' && rec.url === '/grid/session/sess-1/element/el-42/text') return send(200, { value: 'Hello' });
            if (rec.method === 'GET' && rec.url === '/grid/session/sess-1/screenshot') {
                return send(200, { value: Buffer.from('PNGDATA').toString('base64') });
            }
            if (rec.url.startsWith('/grid/session/sess-1/')) return send(200, { value: null });
            send(404, { message: 'not found' });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    hub.close = () => new Promise((resolve) => server.close(() => resolve()));
    return hub;
}

test.describe('GADS Fixture', () => {
    let hub: MockHub;

    test.beforeEach(async () => {
        hub = await startMockHub();
    });

    test.afterEach(async () => {
        await hub.close();
    });

    const cfg = (extra: Partial<GadsFixtureConfig> = {}): GadsFixtureConfig => ({
        hubUrl: `${hub.url}/`,
        clientSecret: SECRET,
        ...extra,
    });

    test.describe('helpers', () => {
        test('normalizeHubUrl strips trailing slashes', () => {
            expect(normalizeHubUrl('http://gads:10000///')).toBe('http://gads:10000');
        });

        test('redactSecret removes the literal secret and bearer tokens', () => {
            const out = redactSecret(`failed with ${SECRET}; Authorization: Bearer abc.def`, SECRET);
            expect(out).not.toContain(SECRET);
            expect(out).not.toContain('abc.def');
            expect(out).toContain('[REDACTED]');
        });

        test('redactCapabilities masks gads:clientSecret without mutating the input', () => {
            const caps = { 'gads:clientSecret': SECRET, platformName: 'iOS' };
            expect(redactCapabilities(caps)).toEqual({ 'gads:clientSecret': '[REDACTED]', platformName: 'iOS' });
            expect(caps['gads:clientSecret']).toBe(SECRET);
        });

        test('filterDevices matches platform, name regex and major version, free devices first', () => {
            const ios17 = filterDevices(DEVICES, { platform: 'ios', deviceName: 'iphone 15', platformVersion: '17' });
            expect(ios17.map((d) => d.udid)).toEqual(['ios-free', 'ios-busy']);
        });

        test('filterDevices requires an exact match for a full version', () => {
            expect(filterDevices(DEVICES, { platformVersion: '17.5.1' }).map((d) => d.udid)).toEqual(['ios-busy']);
        });

        test('buildCapabilities maps config to W3C/Appium/GADS capabilities', () => {
            const caps = buildCapabilities({
                hubUrl: 'http://h',
                clientSecret: SECRET,
                platform: 'android',
                platformVersion: '14',
                queueTimeout: 60,
                newCommandTimeout: 120,
                capabilities: { 'appium:appPackage': 'com.example', 'gads:clientSecret': 'override-attempt' },
            });
            expect(caps).toEqual({
                'gads:clientSecret': SECRET,
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:platformVersion': '14',
                'gads:queueTimeout': 60,
                'appium:newCommandTimeout': 120,
                'appium:appPackage': 'com.example',
            });
        });

        test('buildCapabilities rejects a config with no way to pick a device', () => {
            expect(() => buildCapabilities({ hubUrl: 'http://h', clientSecret: SECRET })).toThrow(FixtureInitError);
        });
    });

    test.describe('hub client', () => {
        test('status sends the client secret as a Bearer token', async () => {
            const status = await createGadsHubClient(cfg()).status();
            expect(status.ready).toBe(true);
            expect(status.devices).toHaveLength(3);
            expect(hub.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
        });

        test('listDevices filters by criteria', async () => {
            const devices = await createGadsHubClient(cfg()).listDevices({ platform: 'android' });
            expect(devices.map((d) => d.udid)).toEqual(['and-1']);
        });

        test('webDriverUrl points at the hub grid', () => {
            expect(createGadsHubClient(cfg()).webDriverUrl).toBe(`${hub.url}/grid`);
        });

        test('missing hubUrl/clientSecret raises FixtureInitError naming the env vars', () => {
            expect(() => createGadsHubClient({ hubUrl: '', clientSecret: '' })).toThrow(/PW_GADS_HUB_URL.*PW_GADS_CLIENT_SECRET/);
        });

        test('unreachable hub raises FixtureInitError with operation connect', async () => {
            const client = createGadsHubClient({ hubUrl: 'http://127.0.0.1:1', clientSecret: SECRET, requestTimeout: 2000 });
            const error = await client.status().catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.operation).toBe('connect');
            expect(error.message).not.toContain(SECRET);
        });
    });

    test.describe('session lifecycle', () => {
        test('starts a session by platform and releases it', async () => {
            const device = await startGadsSession(cfg({ platform: 'ios', queueTimeout: 30 }));

            const create = hub.requests.find((r) => r.method === 'POST' && r.url === '/grid/session')!;
            expect(create.body.capabilities.alwaysMatch).toMatchObject({
                'gads:clientSecret': SECRET,
                platformName: 'iOS',
                'appium:automationName': 'XCUITest',
                'gads:queueTimeout': 30,
            });
            expect(create.body.capabilities.alwaysMatch['appium:udid']).toBeUndefined();

            expect(device.sessionId).toBe('sess-1');
            expect(device.udid).toBe('ios-free');
            expect(device.name).toBe('iPhone 15 Pro');
            expect(device.provider).toBe('mac-1');
            expect(device.platform).toBe('ios');
            expect(device.controlUrl).toContain('/devices/control/ios-free');
            expect(JSON.stringify(device.capabilities)).not.toContain(SECRET);

            await device.release();
            await device.release(); // idempotent
            expect(hub.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
        });

        test('resolves deviceName to a UDID, preferring a free device', async () => {
            const device = await startGadsSession(cfg({ platform: 'ios', deviceName: '^iPhone 15' }));
            const create = hub.requests.find((r) => r.url === '/grid/session')!;
            expect(create.body.capabilities.alwaysMatch['appium:udid']).toBe('ios-free');
            expect(device.udid).toBe('ios-free');
            await device.release();
        });

        test('pins a UDID without querying the device list', async () => {
            const device = await startGadsSession(cfg({ udid: 'and-1' }));
            expect(hub.requests.some((r) => r.url === '/grid/status')).toBe(false);
            expect(device.platform).toBe('android');
            await device.release();
        });

        test('unknown deviceName lists the known devices in the error', async () => {
            const error = await startGadsSession(cfg({ deviceName: 'Galaxy' })).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.message).toContain('No GADS device matches');
            expect(error.message).toContain('Pixel 8');
        });

        test('rejected credentials raise FixtureInitError without leaking the secret', async () => {
            const error = await startGadsSession({ hubUrl: hub.url, clientSecret: 'wrong-secret-value', platform: 'android' }).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.message).toContain('Invalid client credentials');
            expect(error.message).not.toContain('wrong-secret-value');
            expect(error.message).toContain('[REDACTED]');
        });

        test('no free device (hub 404) raises FixtureInitError', async () => {
            hub.override = (r) => r.url === '/grid/session' ? [404, { value: { error: 'session not created', message: 'No available device found' } }] : undefined;
            const error = await startGadsSession(cfg({ platform: 'android' })).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.message).toContain('No available device found');
        });

        test('release tolerates a session the hub already ended', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            hub.override = (r) => r.method === 'DELETE' ? [404, { value: { error: 'invalid session id' } }] : undefined;
            await expect(device.release()).resolves.toBeUndefined();
        });

        test('release failure raises FixtureOperationError with operation release', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            hub.override = (r) => r.method === 'DELETE' ? [500, { value: { message: 'provider unreachable' } }] : undefined;
            const error = await device.release().catch((e) => e);
            expect(error).toBeInstanceOf(FixtureOperationError);
            expect(error.operation).toBe('release');
        });
    });

    test.describe('WebDriver commands', () => {
        test('findElement, getText, findElements and screenshot', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            const id = await device.findElement('accessibility id', 'greeting');
            expect(id).toBe('el-42');
            expect(await device.getText(id)).toBe('Hello');
            expect(await device.findElements('xpath', '//*')).toEqual(['el-1', 'el-2']);
            expect((await device.screenshot()).toString()).toBe('PNGDATA');
            await device.release();
        });

        test('activateApp sends a mobile: command with bundleId and appId', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            await device.activateApp('com.example');
            const exec = hub.requests.find((r) => r.url.endsWith('/execute/sync'))!;
            expect(exec.body).toEqual({ script: 'mobile: activateApp', args: [{ bundleId: 'com.example', appId: 'com.example' }] });
            await device.release();
        });

        test('a failing command raises FixtureOperationError with the WebDriver message', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            const error = await device.findElement('id', 'missing').catch((e) => e);
            expect(error).toBeInstanceOf(FixtureOperationError);
            expect(error.operation).toBe('command');
            expect(error.message).toContain('An element could not be located');
            await device.release();
        });

        test('waitForElement times out with FixtureOperationError', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            const error = await device.waitForElement('id', 'missing', 300).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureOperationError);
            expect(error.message).toContain('Element not found before timeout');
            await device.release();
        });

        test('commands after release are rejected', async () => {
            const device = await startGadsSession(cfg({ platform: 'android' }));
            await device.release();
            await expect(device.source()).rejects.toThrow(/already released/);
        });
    });

    test.describe('config loading', () => {
        const keys = ['PW_GADS_HUB_URL', 'PW_GADS_CLIENT_SECRET', 'PW_GADS_PLATFORM', 'PW_GADS_DEVICE_NAME', 'PW_GADS_QUEUE_TIMEOUT'];
        const saved: Record<string, string | undefined> = {};

        test.beforeEach(() => {
            for (const k of keys) saved[k] = process.env[k];
        });

        test.afterEach(() => {
            for (const k of keys) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        });

        test('PW_GADS_* environment variables populate config.gads', () => {
            process.env.PW_GADS_HUB_URL = 'http://gads-hub:10000';
            process.env.PW_GADS_CLIENT_SECRET = SECRET;
            process.env.PW_GADS_PLATFORM = 'iOS';
            process.env.PW_GADS_DEVICE_NAME = 'iPhone';
            process.env.PW_GADS_QUEUE_TIMEOUT = '120';

            const config = new ConfigLoader().load('local');
            expect(config.gads).toMatchObject({
                hubUrl: 'http://gads-hub:10000',
                clientSecret: SECRET,
                platform: 'ios',
                deviceName: 'iPhone',
                queueTimeout: 120,
            });
        });
    });
});
