/**
 * Unit tests for the Appium fixture and its GADS preset.
 *
 * A local HTTP server stands in for both a plain Appium server (`/session`)
 * and a GADS hub (`/grid/session`, `/grid/status`). Sessions are opened with
 * the real WebdriverIO client, so these tests cover the actual wire format:
 * capabilities sent, device resolution, and session deletion on release.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import {
    buildCapabilities,
    createGadsHubClient,
    filterDevices,
    gadsSessionInfo,
    normalizeServerUrl,
    redactCapabilities,
    redactSecret,
    startAppiumSession,
    type GadsDeviceInfo,
} from '../../src/fixtures/appium.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { ConfigurationError, FixtureInitError } from '../../src/errors';
import type { AppiumFixtureConfig } from '../../src/config/schema';

const SECRET = 'gads-secret-s3cr3t-value';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

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

interface MockServer {
    url: string;
    requests: Recorded[];
    /** ID of the most recently created session. */
    sessionId?: string;
    /** Override a route: return [status, body] or undefined to fall through. */
    override?: (req: Recorded) => [number, unknown] | undefined;
    close(): Promise<void>;
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

let sessionCounter = 0;

async function startMockServer(): Promise<MockServer> {
    const mock: MockServer = { url: '', requests: [], close: async () => { } };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const rec: Recorded = {
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body: raw ? safeJson(raw) : undefined,
            };
            mock.requests.push(rec);

            const send = (status: number, body: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            const o = mock.override?.(rec);
            if (o) return send(o[0], o[1]);

            // GADS hub status
            if (rec.method === 'GET' && rec.url === '/grid/status') {
                if (rec.headers.authorization !== `Bearer ${SECRET}`) {
                    return send(200, { value: { ready: true, message: 'ok', queued: 0 } });
                }
                return send(200, { value: { ready: true, message: 'ok', queued: 0, devices: DEVICES } });
            }

            // Session create — plain Appium at /session, GADS at /grid/session
            const sessionMatch = rec.url.match(/^(\/grid)?\/session$/);
            if (rec.method === 'POST' && sessionMatch) {
                const gads = Boolean(sessionMatch[1]);
                const caps = rec.body?.capabilities?.alwaysMatch ?? {};
                if (gads && caps['gads:clientSecret'] !== SECRET) {
                    return send(401, { value: { error: 'session not created', message: 'Invalid client credentials' } });
                }
                const udid = caps['appium:udid'] ?? (caps.platformName === 'iOS' ? 'ios-free' : 'and-1');
                const device = DEVICES.find((d) => d.udid === udid) ?? DEVICES[2];
                const returned: Record<string, unknown> = {
                    platformName: caps.platformName,
                    'appium:automationName': caps['appium:automationName'],
                    'appium:udid': device.udid,
                };
                if (gads) {
                    Object.assign(returned, {
                        'gads:deviceUdid': device.udid,
                        'gads:deviceName': device.name,
                        'gads:provider': device.provider,
                        'gads:controlUrl': `${mock.url}/devices/control/${device.udid}`,
                    });
                }
                // Unique IDs: WebdriverIO refuses commands for a session ID it already deleted.
                mock.sessionId = `sess-${++sessionCounter}`;
                return send(200, { value: { sessionId: mock.sessionId, capabilities: returned } });
            }

            const cmd = rec.url.replace(/^\/grid/, '').replace(/^\/session\/sess-\d+/, '/session/sess-1');
            if (rec.method === 'DELETE' && cmd === '/session/sess-1') return send(200, { value: null });
            if (rec.method === 'POST' && cmd === '/session/sess-1/element') {
                return send(200, { value: { [ELEMENT_KEY]: 'el-42' } });
            }
            if (rec.method === 'POST' && cmd === '/session/sess-1/elements') {
                return send(200, { value: [{ [ELEMENT_KEY]: 'el-42' }] });
            }
            if (rec.method === 'GET' && cmd === '/session/sess-1/element/el-42/text') return send(200, { value: 'Hello' });
            if (rec.method === 'GET' && cmd === '/session/sess-1/screenshot') {
                return send(200, { value: Buffer.from('PNGDATA').toString('base64') });
            }
            if (cmd.startsWith('/session/sess-1')) return send(200, { value: null });
            send(404, { value: { error: 'unknown command', message: `no route ${rec.method} ${rec.url}` } });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mock.close = () => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
    return mock;
}

test.describe('Appium Fixture', () => {
    let mock: MockServer;

    test.beforeEach(async () => {
        mock = await startMockServer();
    });

    test.afterEach(async () => {
        await mock.close();
    });

    const sessionCreate = () => mock.requests.find((r) => r.method === 'POST' && /\/session$/.test(r.url))!;

    test.describe('helpers', () => {
        test('normalizeServerUrl strips trailing slashes, and /grid for GADS', () => {
            expect(normalizeServerUrl('http://appium:4723///', false)).toBe('http://appium:4723');
            expect(normalizeServerUrl('http://gads:10000/grid/', true)).toBe('http://gads:10000');
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

        test('buildCapabilities maps plain Appium config to W3C capabilities', () => {
            expect(buildCapabilities({
                serverUrl: 'http://a',
                platform: 'ios',
                deviceName: 'iPhone 15',
                platformVersion: '17.5',
                app: '/apps/my.app',
                newCommandTimeout: 120,
                capabilities: { 'appium:bundleId': 'com.example' },
            })).toEqual({
                platformName: 'iOS',
                'appium:automationName': 'XCUITest',
                'appium:deviceName': 'iPhone 15',
                'appium:platformVersion': '17.5',
                'appium:app': '/apps/my.app',
                'appium:newCommandTimeout': 120,
                'appium:bundleId': 'com.example',
            });
        });

        test('buildCapabilities adds GADS caps, drops deviceName, and protects the secret', () => {
            const caps = buildCapabilities({
                serverUrl: 'http://h',
                platform: 'android',
                deviceName: 'Pixel',
                capabilities: { 'gads:clientSecret': 'override-attempt' },
                gads: { clientSecret: SECRET, queueTimeout: 60 },
            }, 'and-1');
            expect(caps).toEqual({
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:udid': 'and-1',
                'gads:clientSecret': SECRET,
                'gads:queueTimeout': 60,
            });
        });

        test('buildCapabilities requires a platform', () => {
            expect(() => buildCapabilities({ serverUrl: 'http://a' })).toThrow(/platformName is required/);
        });
    });

    test.describe('plain Appium session', () => {
        test('opens a session at /session with the built capabilities and deletes it', async () => {
            const driver = await startAppiumSession({ serverUrl: mock.url, platform: 'android', udid: 'and-1' });

            expect(sessionCreate().url).toBe('/session');
            expect(sessionCreate().body.capabilities.alwaysMatch).toMatchObject({
                platformName: 'Android',
                'appium:automationName': 'UiAutomator2',
                'appium:udid': 'and-1',
            });
            expect(driver.sessionId).toBe(mock.sessionId);

            await driver.deleteSession();
            expect(mock.requests.some((r) => r.method === 'DELETE' && r.url === `/session/${mock.sessionId}`)).toBe(true);
        });

        test('WebdriverIO commands reach the server', async () => {
            const driver = await startAppiumSession({ serverUrl: mock.url, platform: 'ios' });
            const el = await driver.$('~greeting');
            expect(await el.getText()).toBe('Hello');
            const find = mock.requests.find((r) => r.url === `/session/${mock.sessionId}/element`)!;
            expect(find.body).toEqual({ using: 'accessibility id', value: 'greeting' });
            expect(Buffer.from(await driver.takeScreenshot(), 'base64').toString()).toBe('PNGDATA');
            await driver.deleteSession();
        });

        test('keeps a base path from serverUrl (e.g. Appium 1 /wd/hub)', async () => {
            mock.override = (r) => r.method === 'POST' && r.url === '/wd/hub/session'
                ? [200, { value: { sessionId: `sess-${++sessionCounter}`, capabilities: { platformName: 'Android' } } }]
                : undefined;
            const driver = await startAppiumSession({ serverUrl: `${mock.url}/wd/hub`, platform: 'android' });
            expect(sessionCreate().url).toBe('/wd/hub/session');
            expect(driver.sessionId).toBe(`sess-${sessionCounter}`);
            await driver.deleteSession().catch(() => { });
        });

        test('session failure raises FixtureInitError with the server message', async () => {
            mock.override = (r) => r.url === '/session'
                ? [500, { value: { error: 'session not created', message: 'Could not find a connected Android device' } }]
                : undefined;
            const error = await startAppiumSession({ serverUrl: mock.url, platform: 'android' }).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.fixtureName).toBe('appium');
            expect(error.operation).toBe('connect');
            expect(error.message).toContain('Could not find a connected Android device');
        });

        test('missing serverUrl raises FixtureInitError naming the env var', async () => {
            await expect(startAppiumSession({ serverUrl: '', platform: 'ios' })).rejects.toThrow(/PW_APPIUM_SERVER_URL/);
        });
    });

    test.describe('GADS preset', () => {
        const gadsCfg = (extra: Partial<AppiumFixtureConfig> = {}): AppiumFixtureConfig => ({
            serverUrl: `${mock.url}/`,
            gads: { clientSecret: SECRET, queueTimeout: 30 },
            ...extra,
        });

        test('routes the session through /grid with the client secret', async () => {
            const driver = await startAppiumSession(gadsCfg({ platform: 'ios' }));
            expect(sessionCreate().url).toBe('/grid/session');
            expect(sessionCreate().body.capabilities.alwaysMatch).toMatchObject({
                platformName: 'iOS',
                'gads:clientSecret': SECRET,
                'gads:queueTimeout': 30,
            });
            expect(gadsSessionInfo(driver)).toEqual({
                udid: 'ios-free',
                name: 'iPhone 15 Pro',
                provider: 'mac-1',
                controlUrl: `${mock.url}/devices/control/ios-free`,
            });
            expect(JSON.stringify(driver.capabilities)).not.toContain(SECRET);

            await driver.deleteSession();
            expect(mock.requests.some((r) => r.method === 'DELETE' && r.url === `/grid/session/${mock.sessionId}`)).toBe(true);
        });

        test('accepts a serverUrl that already ends in /grid', async () => {
            const driver = await startAppiumSession(gadsCfg({ serverUrl: `${mock.url}/grid`, platform: 'android' }));
            expect(sessionCreate().url).toBe('/grid/session');
            await driver.deleteSession();
        });

        test('resolves deviceName to a UDID, preferring a free device', async () => {
            const driver = await startAppiumSession(gadsCfg({ platform: 'ios', deviceName: '^iPhone 15' }));
            expect(sessionCreate().body.capabilities.alwaysMatch['appium:udid']).toBe('ios-free');
            expect(sessionCreate().body.capabilities.alwaysMatch['appium:deviceName']).toBeUndefined();
            await driver.deleteSession();
        });

        test('pinning a UDID skips the device list', async () => {
            const driver = await startAppiumSession(gadsCfg({ platform: 'android', udid: 'and-1' }));
            expect(mock.requests.some((r) => r.url === '/grid/status')).toBe(false);
            await driver.deleteSession();
        });

        test('unknown deviceName lists the known devices in the error', async () => {
            const error = await startAppiumSession(gadsCfg({ platform: 'ios', deviceName: 'Galaxy' })).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.message).toContain('No GADS device matches');
            expect(error.message).toContain('iPhone 15 Pro');
        });

        test('rejected credentials raise FixtureInitError without leaking the secret', async () => {
            const error = await startAppiumSession({
                serverUrl: mock.url,
                platform: 'android',
                gads: { clientSecret: 'wrong-secret-value' },
            }).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.fixtureName).toBe('gads');
            expect(error.message).toContain('Invalid client credentials');
            expect(error.message).not.toContain('wrong-secret-value');
            expect(error.message).toContain('[REDACTED]');
        });

        test('no free device (hub 404) raises FixtureInitError', async () => {
            mock.override = (r) => r.url === '/grid/session'
                ? [404, { value: { error: 'session not created', message: 'No available device found' } }]
                : undefined;
            const error = await startAppiumSession(gadsCfg({ platform: 'android' })).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.message).toContain('No available device found');
        });

        test('gadsHub status sends the secret as a Bearer token and lists devices', async () => {
            const hub = createGadsHubClient(gadsCfg());
            const status = await hub.status();
            expect(status.ready).toBe(true);
            expect(status.devices).toHaveLength(3);
            expect(mock.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
            expect((await hub.listDevices({ platform: 'android' })).map((d) => d.udid)).toEqual(['and-1']);
        });

        test('gadsHub requires the GADS preset', () => {
            expect(() => createGadsHubClient({ serverUrl: mock.url })).toThrow(/GADS is not configured/);
        });

        test('unreachable hub raises FixtureInitError without the secret', async () => {
            const hub = createGadsHubClient({ serverUrl: 'http://127.0.0.1:1', gads: { clientSecret: SECRET } });
            const error = await hub.status().catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.operation).toBe('connect');
            expect(error.message).not.toContain(SECRET);
        });
    });

    test.describe('config loading', () => {
        const keys = ['PW_APPIUM_SERVER_URL', 'PW_APPIUM_PLATFORM', 'PW_APPIUM_DEVICE_NAME', 'PW_APPIUM_CAPABILITIES', 'PW_GADS_CLIENT_SECRET', 'PW_GADS_QUEUE_TIMEOUT'];
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

        test('PW_APPIUM_* and PW_GADS_* populate config.appium', () => {
            process.env.PW_APPIUM_SERVER_URL = 'http://gads-hub:10000';
            process.env.PW_APPIUM_PLATFORM = 'iOS';
            process.env.PW_APPIUM_DEVICE_NAME = 'iPhone';
            process.env.PW_APPIUM_CAPABILITIES = '{"appium:bundleId":"com.example"}';
            process.env.PW_GADS_CLIENT_SECRET = SECRET;
            process.env.PW_GADS_QUEUE_TIMEOUT = '120';

            const config = new ConfigLoader().load('local');
            expect(config.appium).toMatchObject({
                serverUrl: 'http://gads-hub:10000',
                platform: 'ios',
                deviceName: 'iPhone',
                capabilities: { 'appium:bundleId': 'com.example' },
                gads: { clientSecret: SECRET, queueTimeout: 120 },
            });
        });

        test('invalid PW_APPIUM_CAPABILITIES raises ConfigurationError naming the variable', () => {
            process.env.PW_APPIUM_CAPABILITIES = '{not json';
            expect(() => new ConfigLoader().load('local')).toThrow(ConfigurationError);
            expect(() => new ConfigLoader().load('local')).toThrow(/PW_APPIUM_CAPABILITIES is not valid JSON/);
        });
    });
});
