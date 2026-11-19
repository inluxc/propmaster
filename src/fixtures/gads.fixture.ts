/**
 * GADS device farm fixture for the Playwright Framework Template.
 *
 * GADS (https://github.com/shamanec/GADS) is a self-hosted mobile device farm.
 * A GADS hub fronts one or more providers (hosts with real iOS/Android devices)
 * and exposes a Selenium-Grid-style Appium endpoint at `<hub>/grid`. This
 * fixture talks to that endpoint over plain W3C WebDriver HTTP:
 *
 *   Setup:    resolve the target device (UDID, name or platform)
 *             → POST <hub>/grid/session with `gads:clientSecret` and Appium caps
 *             → the hub allocates the device (queueing up to `queueTimeout`)
 *   Use:      `gadsDevice` exposes W3C WebDriver/Appium commands for the session
 *   Teardown: DELETE <hub>/grid/session/<id> → the hub releases the device
 *
 * Authentication uses a GADS client secret (Admin → Client credentials). The
 * secret is sent only as the `gads:clientSecret` capability and as a Bearer
 * token for `/grid/status`; it is redacted from every error this module throws.
 *
 * Error handling:
 *   - FixtureInitError when the hub is unreachable, rejects the credentials,
 *     or no matching device can be allocated
 *   - FixtureOperationError when a WebDriver command or the release fails
 */

import type { GadsFixtureConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import { redactCredentials } from '../annotations/truncation.js';

/** W3C WebDriver element identifier key. */
export const W3C_ELEMENT_KEY = 'element-6066-11e4-a6a6-4a6a7b6f1c47';

/** Default timeout for ordinary hub requests and WebDriver commands (ms). */
const DEFAULT_REQUEST_TIMEOUT = 90_000;
/** Default timeout for session creation, which includes queueing and app install (ms). */
const DEFAULT_SESSION_TIMEOUT = 240_000;

/** Appium locator strategies accepted by `findElement` / `findElements`. */
export type GadsLocatorStrategy =
    | 'accessibility id'
    | 'id'
    | 'xpath'
    | 'class name'
    | '-android uiautomator'
    | '-ios predicate string'
    | '-ios class chain'
    | (string & {});

/** A device as reported by `GET <hub>/grid/status`. */
export interface GadsDeviceInfo {
    udid: string;
    name: string;
    os: string;
    os_version: string;
    provider: string;
    available: boolean;
    in_use_by_automation: boolean;
}

/** Hub readiness as reported by `GET <hub>/grid/status`. */
export interface GadsGridStatus {
    ready: boolean;
    message: string;
    queued: number;
    devices: GadsDeviceInfo[];
}

/** Criteria for picking a device. All fields are optional and combined with AND. */
export interface GadsDeviceCriteria {
    platform?: 'ios' | 'android';
    udid?: string;
    /** Regular expression matched against the device name (case-insensitive). */
    deviceName?: string;
    /** Exact OS version, or a major version such as `17`. */
    platformVersion?: string;
}

/** Hub-level operations that don't need a device session. */
export interface GadsHubClient {
    /** The hub base URL, without trailing slash. */
    readonly hubUrl: string;
    /** The WebDriver endpoint to hand to other clients (WebdriverIO, Appium clients). */
    readonly webDriverUrl: string;
    /** Returns hub readiness, queue length and every automation-enabled device. */
    status(): Promise<GadsGridStatus>;
    /** Lists devices, optionally filtered by platform, UDID, name or OS version. */
    listDevices(criteria?: GadsDeviceCriteria): Promise<GadsDeviceInfo[]>;
}

/** An Appium session on a GADS device, exposed to tests as `gadsDevice`. */
export interface GadsDevice {
    /** WebDriver session ID assigned by the hub. */
    readonly sessionId: string;
    /** UDID of the allocated device. */
    readonly udid: string;
    /** Device name reported by the hub (if any). */
    readonly name?: string;
    /** Provider nickname the device is attached to (if reported). */
    readonly provider?: string;
    /** Platform the session runs on. */
    readonly platform?: 'ios' | 'android';
    /** URL of the device's remote-control page in the GADS UI (if reported). */
    readonly controlUrl?: string;
    /** Capabilities returned by the hub (the client secret is never included). */
    readonly capabilities: Readonly<Record<string, unknown>>;
    /** The hub's WebDriver endpoint, e.g. `http://gads:10000/grid`. */
    readonly webDriverUrl: string;
    /** Sends a raw WebDriver command relative to the session and returns its `value`. */
    command<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T>;
    /** Finds one element and returns its element ID. */
    findElement(using: GadsLocatorStrategy, value: string): Promise<string>;
    /** Finds all matching elements and returns their element IDs (empty if none). */
    findElements(using: GadsLocatorStrategy, value: string): Promise<string[]>;
    /** Polls until an element is found or `timeout` ms elapse; returns its element ID. */
    waitForElement(using: GadsLocatorStrategy, value: string, timeout?: number): Promise<string>;
    click(elementId: string): Promise<void>;
    sendKeys(elementId: string, text: string): Promise<void>;
    clear(elementId: string): Promise<void>;
    getText(elementId: string): Promise<string>;
    isDisplayed(elementId: string): Promise<boolean>;
    /** Returns the current UI hierarchy as XML. */
    source(): Promise<string>;
    /** Returns a PNG screenshot of the device screen. */
    screenshot(): Promise<Buffer>;
    /** Runs a script, typically an Appium `mobile:` command. */
    execute<T = unknown>(script: string, args?: unknown[]): Promise<T>;
    /** Brings an installed app to the foreground (bundle ID or package name). */
    activateApp(appId: string): Promise<void>;
    /** Stops a running app (bundle ID or package name). */
    terminateApp(appId: string): Promise<boolean>;
    /** Opens a URL or deep link on the device. */
    openUrl(url: string): Promise<void>;
    /** Ends the session and releases the device. Safe to call more than once. */
    release(): Promise<void>;
}

interface HttpResult {
    status: number;
    body: unknown;
}

/** Strips a trailing slash so paths can be appended safely. */
export function normalizeHubUrl(hubUrl: string): string {
    return hubUrl.replace(/\/+$/, '');
}

/**
 * Removes the client secret from a string: the literal value, plus anything
 * `redactCredentials` recognises (Bearer tokens, password=..., JWTs).
 */
export function redactSecret(text: string, secret: string | undefined): string {
    let out = text;
    if (secret) {
        out = out.split(secret).join('[REDACTED]');
    }
    return redactCredentials(out);
}

/** Returns a copy of `caps` with the client secret replaced by `[REDACTED]`. */
export function redactCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
    const out = { ...caps };
    if ('gads:clientSecret' in out) out['gads:clientSecret'] = '[REDACTED]';
    return out;
}

/** Extracts a human-readable error from a WebDriver or GADS error body. */
function errorMessage(body: unknown, status: number): string {
    if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        const value = b.value as Record<string, unknown> | undefined;
        const candidates = [value?.message, value?.error, b.message, b.error];
        for (const c of candidates) {
            if (typeof c === 'string' && c) return `HTTP ${status}: ${c}`;
        }
    }
    if (typeof body === 'string' && body) return `HTTP ${status}: ${body.slice(0, 500)}`;
    return `HTTP ${status}`;
}

async function httpRequest(
    url: string,
    init: { method: string; body?: unknown; headers?: Record<string, string>; timeout: number },
): Promise<HttpResult> {
    const response = await fetch(url, {
        method: init.method,
        headers: {
            Accept: 'application/json',
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeout),
    });
    const text = await response.text();
    let body: unknown = text;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            // Non-JSON body — keep the raw text for error messages.
        }
    }
    return { status: response.status, body };
}

/**
 * Selects matching devices. Available devices come first so a caller picking
 * `[0]` gets a free device when there is one.
 */
export function filterDevices(devices: GadsDeviceInfo[], criteria: GadsDeviceCriteria = {}): GadsDeviceInfo[] {
    const nameRe = criteria.deviceName ? new RegExp(criteria.deviceName, 'i') : undefined;
    const matches = devices.filter((d) => {
        if (criteria.udid && d.udid !== criteria.udid) return false;
        if (criteria.platform && d.os?.toLowerCase() !== criteria.platform) return false;
        if (nameRe && !nameRe.test(d.name ?? '')) return false;
        if (criteria.platformVersion) {
            const wanted = criteria.platformVersion;
            const version = d.os_version ?? '';
            // `17.5.1` must match exactly; `17` matches any 17.x.
            const ok = wanted.includes('.') ? version === wanted : version.split('.')[0] === wanted;
            if (!ok) return false;
        }
        return true;
    });
    return [...matches].sort((a, b) => Number(b.available) - Number(a.available));
}

/** Default Appium automation engine for a platform. */
function defaultAutomationName(platform: 'ios' | 'android' | undefined): string | undefined {
    if (platform === 'ios') return 'XCUITest';
    if (platform === 'android') return 'UiAutomator2';
    return undefined;
}

/**
 * Builds the W3C `alwaysMatch` capabilities for `POST /grid/session`.
 * `udid` overrides `config.udid` (used after resolving a device by name).
 */
export function buildCapabilities(config: GadsFixtureConfig, udid?: string): Record<string, unknown> {
    const caps: Record<string, unknown> = {
        'gads:clientSecret': config.clientSecret,
    };
    const targetUdid = udid ?? config.udid;
    if (config.platform) caps.platformName = config.platform === 'ios' ? 'iOS' : 'Android';
    const automationName = config.automationName ?? defaultAutomationName(config.platform);
    if (automationName) caps['appium:automationName'] = automationName;
    if (targetUdid) caps['appium:udid'] = targetUdid;
    if (config.platformVersion) caps['appium:platformVersion'] = config.platformVersion;
    if (config.queueTimeout !== undefined) caps['gads:queueTimeout'] = config.queueTimeout;
    if (config.newCommandTimeout !== undefined) caps['appium:newCommandTimeout'] = config.newCommandTimeout;

    for (const [key, value] of Object.entries(config.capabilities ?? {})) {
        if (key === 'gads:clientSecret') continue; // never let extra caps override the configured secret
        caps[key] = value;
    }

    if (!caps.platformName && !caps['appium:automationName'] && !caps['appium:udid']) {
        throw new FixtureInitError('gads', 'init', {
            hubUrl: config.hubUrl,
            reason: 'Set platform, udid, deviceName or capabilities.platformName so the hub can pick a device.',
        });
    }
    return caps;
}

function assertConfig(config: GadsFixtureConfig): void {
    const missing: string[] = [];
    if (!config.hubUrl) missing.push('hubUrl (PW_GADS_HUB_URL)');
    if (!config.clientSecret) missing.push('clientSecret (PW_GADS_CLIENT_SECRET)');
    if (missing.length > 0) {
        throw new FixtureInitError('gads', 'init', {
            reason: `GADS configuration is incomplete — missing ${missing.join(', ')}`,
        });
    }
}

/**
 * Creates a hub client for status and device listing.
 */
export function createGadsHubClient(config: GadsFixtureConfig): GadsHubClient {
    assertConfig(config);
    const hubUrl = normalizeHubUrl(config.hubUrl);
    const timeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

    const status = async (): Promise<GadsGridStatus> => {
        let result: HttpResult;
        try {
            result = await httpRequest(`${hubUrl}/grid/status`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${config.clientSecret}` },
                timeout,
            });
        } catch (error) {
            throw new FixtureInitError('gads', 'connect', {
                hubUrl,
                timeout,
                reason: redactSecret(error instanceof Error ? error.message : String(error), config.clientSecret),
            }, error instanceof Error ? error : undefined);
        }
        if (result.status !== 200) {
            throw new FixtureInitError('gads', 'connect', {
                hubUrl,
                reason: redactSecret(errorMessage(result.body, result.status), config.clientSecret),
            });
        }
        const value = ((result.body as { value?: Partial<GadsGridStatus> })?.value ?? {}) as Partial<GadsGridStatus>;
        return {
            ready: Boolean(value.ready),
            message: value.message ?? '',
            queued: value.queued ?? 0,
            devices: value.devices ?? [],
        };
    };

    return {
        hubUrl,
        webDriverUrl: `${hubUrl}/grid`,
        status,
        async listDevices(criteria?: GadsDeviceCriteria) {
            const { devices } = await status();
            return criteria ? filterDevices(devices, criteria) : devices;
        },
    };
}

/**
 * Resolves `deviceName` / `platformVersion`-style criteria to a UDID using the
 * hub's device list. Returns `undefined` when the hub can pick on its own
 * (UDID given, or only platform/version criteria).
 */
async function resolveUdid(hub: GadsHubClient, config: GadsFixtureConfig): Promise<string | undefined> {
    if (config.udid || !config.deviceName) return config.udid;

    const devices = await hub.listDevices();
    const matches = filterDevices(devices, {
        platform: config.platform,
        deviceName: config.deviceName,
        platformVersion: config.platformVersion,
    });
    if (matches.length === 0) {
        throw new FixtureInitError('gads', 'init', {
            hubUrl: hub.hubUrl,
            platform: config.platform,
            deviceName: config.deviceName,
            platformVersion: config.platformVersion,
            reason: `No GADS device matches. Known devices: ${devices.map((d) => `${d.name} (${d.os} ${d.os_version}, ${d.udid})`).join('; ') || 'none'}`,
        });
    }
    // The first match is free if any is; otherwise let the hub queue for it.
    return matches[0].udid;
}

function buildDevice(
    hubUrl: string,
    config: GadsFixtureConfig,
    sessionId: string,
    returnedCaps: Record<string, unknown>,
): GadsDevice {
    const timeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    const sessionUrl = `${hubUrl}/grid/session/${encodeURIComponent(sessionId)}`;
    let released = false;

    const command = async <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> => {
        if (released) {
            throw new FixtureOperationError('gads', 'command', {
                sessionId,
                command: `${method} ${path}`,
                reason: 'Session was already released',
            });
        }
        const suffix = path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;
        let result: HttpResult;
        try {
            result = await httpRequest(`${sessionUrl}${suffix}`, {
                method,
                body: method === 'POST' ? (body ?? {}) : undefined,
                timeout,
            });
        } catch (error) {
            throw new FixtureOperationError('gads', 'command', {
                sessionId,
                command: `${method} ${suffix}`,
                reason: redactSecret(error instanceof Error ? error.message : String(error), config.clientSecret),
            }, error instanceof Error ? error : undefined);
        }
        if (result.status < 200 || result.status >= 300) {
            throw new FixtureOperationError('gads', 'command', {
                sessionId,
                command: `${method} ${suffix}`,
                reason: redactSecret(errorMessage(result.body, result.status), config.clientSecret),
            });
        }
        return (result.body as { value?: T })?.value as T;
    };

    const elementId = (el: unknown): string => {
        const e = el as Record<string, string> | null;
        const id = e?.[W3C_ELEMENT_KEY] ?? e?.ELEMENT;
        if (!id) {
            throw new FixtureOperationError('gads', 'command', {
                sessionId,
                reason: `Unexpected element response: ${JSON.stringify(el)}`,
            });
        }
        return id;
    };

    const el = (id: string) => `/element/${encodeURIComponent(id)}`;

    const device: GadsDevice = {
        sessionId,
        udid: String(returnedCaps['gads:deviceUdid'] ?? returnedCaps['appium:udid'] ?? returnedCaps.udid ?? config.udid ?? ''),
        name: (returnedCaps['gads:deviceName'] ?? returnedCaps['appium:deviceName'] ?? returnedCaps.deviceName) as string | undefined,
        provider: returnedCaps['gads:provider'] as string | undefined,
        platform: (() => {
            const p = String(returnedCaps.platformName ?? config.platform ?? '').toLowerCase();
            return p === 'ios' || p === 'android' ? p : undefined;
        })(),
        controlUrl: returnedCaps['gads:controlUrl'] as string | undefined,
        capabilities: Object.freeze(redactCapabilities(returnedCaps)),
        webDriverUrl: `${hubUrl}/grid`,

        command,

        async findElement(using, value) {
            return elementId(await command('POST', '/element', { using, value }));
        },
        async findElements(using, value) {
            const list = await command<unknown[]>('POST', '/elements', { using, value });
            return (list ?? []).map(elementId);
        },
        async waitForElement(using, value, waitTimeout = 10_000) {
            const deadline = Date.now() + waitTimeout;
            for (;;) {
                const ids = await device.findElements(using, value);
                if (ids.length > 0) return ids[0];
                if (Date.now() >= deadline) {
                    throw new FixtureOperationError('gads', 'command', {
                        sessionId,
                        using,
                        value,
                        timeout: waitTimeout,
                        reason: 'Element not found before timeout',
                    });
                }
                await new Promise((r) => setTimeout(r, 250));
            }
        },
        async click(id) {
            await command('POST', `${el(id)}/click`);
        },
        async sendKeys(id, text) {
            await command('POST', `${el(id)}/value`, { text, value: [...text] });
        },
        async clear(id) {
            await command('POST', `${el(id)}/clear`);
        },
        async getText(id) {
            return command<string>('GET', `${el(id)}/text`);
        },
        async isDisplayed(id) {
            return command<boolean>('GET', `${el(id)}/displayed`);
        },
        async source() {
            return command<string>('GET', '/source');
        },
        async screenshot() {
            return Buffer.from(await command<string>('GET', '/screenshot'), 'base64');
        },
        async execute<T>(script: string, args: unknown[] = []) {
            return command<T>('POST', '/execute/sync', { script, args });
        },
        async activateApp(appId) {
            await device.execute('mobile: activateApp', [{ bundleId: appId, appId }]);
        },
        async terminateApp(appId) {
            return device.execute<boolean>('mobile: terminateApp', [{ bundleId: appId, appId }]);
        },
        async openUrl(url) {
            await command('POST', '/url', { url });
        },
        async release() {
            if (released) return;
            released = true;
            let result: HttpResult;
            try {
                result = await httpRequest(sessionUrl, { method: 'DELETE', timeout });
            } catch (error) {
                throw new FixtureOperationError('gads', 'release', {
                    sessionId,
                    reason: redactSecret(error instanceof Error ? error.message : String(error), config.clientSecret),
                }, error instanceof Error ? error : undefined);
            }
            // 404 means the hub already ended the session (e.g. newCommandTimeout) — the device is free.
            if (result.status !== 404 && (result.status < 200 || result.status >= 300)) {
                throw new FixtureOperationError('gads', 'release', {
                    sessionId,
                    reason: redactSecret(errorMessage(result.body, result.status), config.clientSecret),
                });
            }
        },
    };
    return device;
}

/**
 * Allocates a device through the hub grid and opens an Appium session on it.
 * Call `release()` on the result when done (the fixture does this for you).
 */
export async function startGadsSession(config: GadsFixtureConfig, hub?: GadsHubClient): Promise<GadsDevice> {
    assertConfig(config);
    const hubClient = hub ?? createGadsHubClient(config);
    const hubUrl = hubClient.hubUrl;
    const udid = await resolveUdid(hubClient, config);
    const alwaysMatch = buildCapabilities(config, udid);
    const timeout = config.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;

    const fail = (reason: string, cause?: Error) =>
        new FixtureInitError('gads', 'connect', {
            hubUrl,
            capabilities: redactCapabilities(alwaysMatch),
            timeout,
            reason: redactSecret(reason, config.clientSecret),
        }, cause);

    let result: HttpResult;
    try {
        result = await httpRequest(`${hubUrl}/grid/session`, {
            method: 'POST',
            body: { capabilities: { alwaysMatch, firstMatch: [{}] } },
            timeout,
        });
    } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error), error instanceof Error ? error : undefined);
    }

    if (result.status < 200 || result.status >= 300) {
        throw fail(errorMessage(result.body, result.status));
    }

    const value = (result.body as { value?: { sessionId?: string; capabilities?: Record<string, unknown> } })?.value;
    const sessionId = value?.sessionId ?? (result.body as { sessionId?: string })?.sessionId;
    if (!sessionId) {
        throw fail(`Hub response has no sessionId: ${JSON.stringify(result.body).slice(0, 500)}`);
    }

    return buildDevice(hubUrl, config, sessionId, value?.capabilities ?? {});
}

/**
 * GADS fixture definitions for Playwright's test.extend() pattern.
 *
 * - `gadsHub`: hub client (status, device listing). No device is reserved.
 * - `gadsDevice`: an Appium session on an allocated device, released on teardown.
 */
export const gadsFixture = {
    gadsHub: async (
        { gadsConfig }: { gadsConfig: GadsFixtureConfig },
        use: (hub: GadsHubClient) => Promise<void>,
    ) => {
        await use(createGadsHubClient(gadsConfig));
    },

    gadsDevice: async (
        { gadsConfig, gadsHub }: { gadsConfig: GadsFixtureConfig; gadsHub: GadsHubClient },
        use: (device: GadsDevice) => Promise<void>,
    ) => {
        const device = await startGadsSession(gadsConfig, gadsHub);
        try {
            await use(device);
        } finally {
            try {
                await device.release();
            } catch {
                // Don't fail the test on teardown errors — the hub frees the device
                // after newCommandTimeout anyway.
            }
        }
    },
};
