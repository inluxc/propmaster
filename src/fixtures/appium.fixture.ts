/**
 * Appium fixture for the Playwright Framework Template.
 *
 * Opens an Appium session with WebdriverIO (`remote()`) and gives the test the
 * WebdriverIO `Browser` as `appiumDriver`. It works with any Appium-compatible
 * server: a local `appium` server, Selenium Grid, a cloud farm, or a GADS hub.
 *
 * GADS preset (https://github.com/shamanec/GADS) — set `appium.gads`:
 *   - sessions go through the hub's `/grid` endpoint, which allocates a device
 *     (queueing up to `gads.queueTimeout` seconds when all are busy)
 *   - `gads:clientSecret` / `gads:queueTimeout` capabilities are added
 *   - `deviceName` is a regex resolved to a UDID from `GET /grid/status`, free devices first
 *   - `gadsHub` lists devices and reports hub status without reserving one
 *
 * Lifecycle:
 *   Setup:    build capabilities → (GADS: resolve device) → POST /session via WebdriverIO
 *   Teardown: DELETE /session/<id> → the server (or GADS hub) frees the device
 *
 * Error handling:
 *   - FixtureInitError when the server is unreachable, rejects the credentials,
 *     or no matching device can be allocated — the GADS client secret is redacted
 *   - WebdriverIO's own errors for commands inside the test
 */

import { errorReason } from '../network-error.js';
import type {} from 'webdriverio'; // brings in the global WebdriverIO types
import { loadOptional } from './optional-package.js';
import type { AppiumFixtureConfig } from '../config/schema.js';
import { FixtureInitError } from '../errors.js';
import { redactCredentials } from '../annotations/truncation.js';

/** The WebdriverIO session given to tests as `appiumDriver`. */
export type AppiumDriver = WebdriverIO.Browser;

/** Default session creation timeout (ms): covers device queueing and app install. */
const DEFAULT_SESSION_TIMEOUT = 240_000;
/** Default timeout for GADS hub REST calls (ms). */
const HUB_REQUEST_TIMEOUT = 30_000;

/** A device as reported by GADS `GET <hub>/grid/status`. */
export interface GadsDeviceInfo {
    udid: string;
    name: string;
    os: string;
    os_version: string;
    provider: string;
    available: boolean;
    in_use_by_automation: boolean;
}

/** GADS hub readiness as reported by `GET <hub>/grid/status`. */
export interface GadsGridStatus {
    ready: boolean;
    message: string;
    queued: number;
    devices: GadsDeviceInfo[];
}

/** Criteria for picking a GADS device. All fields are optional and combined with AND. */
export interface GadsDeviceCriteria {
    platform?: 'ios' | 'android';
    udid?: string;
    /** Regular expression matched against the device name (case-insensitive). */
    deviceName?: string;
    /** Exact OS version (`17.5.1`) or a major version (`17`). */
    platformVersion?: string;
}

/** GADS hub operations that don't need a device session. */
export interface GadsHubClient {
    /** Hub base URL, without trailing slash or `/grid`. */
    readonly hubUrl: string;
    /** Returns hub readiness, queue length and every automation-enabled device. */
    status(): Promise<GadsGridStatus>;
    /** Lists devices, optionally filtered; free devices come first. */
    listDevices(criteria?: GadsDeviceCriteria): Promise<GadsDeviceInfo[]>;
}

/** Device details GADS adds to the session capabilities. */
export interface GadsSessionInfo {
    udid?: string;
    name?: string;
    provider?: string;
    /** URL of the device's remote-control page in the GADS UI. */
    controlUrl?: string;
}

/** Strips trailing slashes, and for GADS a trailing `/grid`, so paths can be appended safely. */
export function normalizeServerUrl(serverUrl: string, gads: boolean): string {
    let url = serverUrl.replace(/\/+$/, '');
    if (gads) url = url.replace(/\/grid$/, '');
    return url;
}

/**
 * Removes a secret from a string: the literal value, plus anything
 * `redactCredentials` recognises (Bearer tokens, password=..., JWTs).
 */
export function redactSecret(text: string, secret: string | undefined): string {
    let out = text;
    if (secret) out = out.split(secret).join('[REDACTED]');
    return redactCredentials(out);
}

/** Returns a copy of `caps` with `gads:clientSecret` replaced by `[REDACTED]`. */
export function redactCapabilities(caps: Record<string, unknown>): Record<string, unknown> {
    const out = { ...caps };
    if ('gads:clientSecret' in out) out['gads:clientSecret'] = '[REDACTED]';
    return out;
}

/** Selects matching GADS devices, free devices first. */
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
 * Builds the W3C capabilities for the session. `udid` overrides `config.udid`
 * (used after resolving a GADS device by name).
 */
export function buildCapabilities(config: AppiumFixtureConfig, udid?: string): Record<string, unknown> {
    const caps: Record<string, unknown> = {};
    const gads = config.gads;

    if (config.platform) caps.platformName = config.platform === 'ios' ? 'iOS' : 'Android';
    const automationName = config.automationName ?? defaultAutomationName(config.platform);
    if (automationName) caps['appium:automationName'] = automationName;
    const targetUdid = udid ?? config.udid;
    if (targetUdid) caps['appium:udid'] = targetUdid;
    // For GADS the name is resolved to a UDID; plain Appium gets it as a capability.
    if (config.deviceName && !gads) caps['appium:deviceName'] = config.deviceName;
    if (config.platformVersion) caps['appium:platformVersion'] = config.platformVersion;
    if (config.app) caps['appium:app'] = config.app;
    if (config.newCommandTimeout !== undefined) caps['appium:newCommandTimeout'] = config.newCommandTimeout;

    for (const [key, value] of Object.entries(config.capabilities ?? {})) {
        if (key === 'gads:clientSecret') continue; // never let extra caps override the configured secret
        caps[key] = value;
    }

    if (gads) {
        caps['gads:clientSecret'] = gads.clientSecret;
        if (gads.queueTimeout !== undefined) caps['gads:queueTimeout'] = gads.queueTimeout;
    }

    if (!caps.platformName) {
        throw new FixtureInitError('appium', 'init', {
            serverUrl: config.serverUrl,
            reason: 'platformName is required. Set appium.platform (PW_APPIUM_PLATFORM) or capabilities.platformName.',
        });
    }
    return caps;
}

function assertConfig(config: AppiumFixtureConfig): void {
    const missing: string[] = [];
    if (!config.serverUrl) missing.push('serverUrl (PW_APPIUM_SERVER_URL)');
    if (config.gads && !config.gads.clientSecret) missing.push('gads.clientSecret (PW_GADS_CLIENT_SECRET)');
    if (missing.length > 0) {
        throw new FixtureInitError('appium', 'init', {
            reason: `Appium configuration is incomplete — missing ${missing.join(', ')}`,
        });
    }
}

/** Extracts a human-readable error from a WebDriver or GADS error body. */
function hubErrorMessage(body: unknown, status: number): string {
    if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        const value = b.value as Record<string, unknown> | undefined;
        for (const c of [value?.message, value?.error, b.message, b.error]) {
            if (typeof c === 'string' && c) return `HTTP ${status}: ${c}`;
        }
    }
    return `HTTP ${status}`;
}

/**
 * Creates a GADS hub client for status and device listing.
 * Requires `config.gads`.
 */
export function createGadsHubClient(config: AppiumFixtureConfig): GadsHubClient {
    assertConfig(config);
    if (!config.gads) {
        throw new FixtureInitError('gads', 'init', {
            reason: 'GADS is not configured. Set appium.gads (PW_GADS_CLIENT_SECRET) and point serverUrl at the hub.',
        });
    }
    const secret = config.gads.clientSecret;
    const hubUrl = normalizeServerUrl(config.serverUrl, true);

    const status = async (): Promise<GadsGridStatus> => {
        let response: Response;
        let body: unknown;
        try {
            response = await fetch(`${hubUrl}/grid/status`, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
                signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT),
            });
            const text = await response.text();
            try {
                body = text ? JSON.parse(text) : undefined;
            } catch {
                body = text;
            }
        } catch (error) {
            throw new FixtureInitError('gads', 'connect', {
                hubUrl,
                reason: redactSecret(errorReason(error), secret),
            }, error instanceof Error ? error : undefined);
        }
        if (response.status !== 200) {
            throw new FixtureInitError('gads', 'connect', {
                hubUrl,
                reason: redactSecret(hubErrorMessage(body, response.status), secret),
            });
        }
        const value = ((body as { value?: Partial<GadsGridStatus> })?.value ?? {}) as Partial<GadsGridStatus>;
        return {
            ready: Boolean(value.ready),
            message: value.message ?? '',
            queued: value.queued ?? 0,
            devices: value.devices ?? [],
        };
    };

    return {
        hubUrl,
        status,
        async listDevices(criteria?: GadsDeviceCriteria) {
            const { devices } = await status();
            return filterDevices(devices, criteria);
        },
    };
}

/** Resolves a GADS `deviceName` regex to a UDID. Returns undefined when the hub can pick on its own. */
async function resolveGadsUdid(hub: GadsHubClient, config: AppiumFixtureConfig): Promise<string | undefined> {
    if (config.udid || !config.deviceName) return config.udid;

    const devices = (await hub.status()).devices;
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
    // The first match is free if any is; otherwise the hub queues for it.
    return matches[0].udid;
}

/** Reads the device details GADS adds to the session capabilities. */
export function gadsSessionInfo(driver: AppiumDriver): GadsSessionInfo {
    const caps = (driver.capabilities ?? {}) as Record<string, unknown>;
    return {
        udid: (caps['gads:deviceUdid'] ?? caps['appium:udid'] ?? caps.udid) as string | undefined,
        name: (caps['gads:deviceName'] ?? caps['appium:deviceName'] ?? caps.deviceName) as string | undefined,
        provider: caps['gads:provider'] as string | undefined,
        controlUrl: caps['gads:controlUrl'] as string | undefined,
    };
}

/**
 * Opens an Appium session and returns the WebdriverIO Browser.
 * Call `driver.deleteSession()` when done (the fixture does this for you).
 */
export async function startAppiumSession(config: AppiumFixtureConfig, hub?: GadsHubClient): Promise<AppiumDriver> {
    assertConfig(config);
    const isGads = Boolean(config.gads);
    const secret = config.gads?.clientSecret;

    let udid = config.udid;
    if (isGads) {
        udid = await resolveGadsUdid(hub ?? createGadsHubClient(config), config);
    }
    const capabilities = buildCapabilities(config, udid);

    const base = new URL(normalizeServerUrl(config.serverUrl, isGads));
    const path = isGads ? `${base.pathname.replace(/\/+$/, '')}/grid` : (base.pathname || '/');
    const timeout = config.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
    // webdriverio is an optional peer dependency, loaded on first use.
    const { remote } = await loadOptional<typeof import('webdriverio')>('webdriverio', 'appiumDriver');

    try {
        return await remote({
            protocol: base.protocol.replace(':', '') as 'http' | 'https',
            hostname: base.hostname,
            port: base.port ? Number(base.port) : base.protocol === 'https:' ? 443 : 80,
            path,
            capabilities: capabilities as WebdriverIO.Capabilities,
            logLevel: config.logLevel ?? 'warn',
            connectionRetryTimeout: timeout,
            // A failed allocation (no device, bad secret) won't succeed on retry.
            connectionRetryCount: 0,
        });
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new FixtureInitError(isGads ? 'gads' : 'appium', 'connect', {
            serverUrl: `${base.origin}${path}`,
            capabilities: redactCapabilities(capabilities),
            timeout,
            reason: redactSecret(cause.message, secret),
        });
    }
}

/**
 * Appium fixture definitions for Playwright's test.extend() pattern.
 *
 * - `appiumDriver`: a WebdriverIO Browser for an Appium session, ended on teardown.
 * - `gadsHub`: GADS hub status and device listing (requires `appium.gads`). Reserves nothing.
 */
export const appiumFixture = {
    gadsHub: async (
        { appiumConfig }: { appiumConfig: AppiumFixtureConfig },
        use: (hub: GadsHubClient) => Promise<void>,
    ) => {
        await use(createGadsHubClient(appiumConfig));
    },

    appiumDriver: async (
        { appiumConfig }: { appiumConfig: AppiumFixtureConfig },
        use: (driver: AppiumDriver) => Promise<void>,
    ) => {
        const driver = await startAppiumSession(appiumConfig);
        try {
            await use(driver);
        } finally {
            try {
                await driver.deleteSession();
            } catch {
                // Don't fail the test on teardown errors — the server frees the
                // device after newCommandTimeout anyway.
            }
        }
    },
};
