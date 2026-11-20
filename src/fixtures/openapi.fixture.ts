/**
 * OpenAPI Client Fixture for Playwright.
 *
 * Provides an initialized openapi-client-axios instance as a Playwright fixture.
 * Loads an OpenAPI spec from a local file or remote URL, initializes the client
 * with operation methods, and supports base URL override from config.
 *
 * Usage:
 *   import { test } from '../fixtures';
 *   test('my api test', async ({ openApiClient }) => {
 *     const response = await openApiClient.client.someOperation();
 *   });
 */

import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { OpenAPIClientAxios, AxiosInstance, Document } from 'openapi-client-axios';
import { loadOptional } from './optional-package.js';
import type { AuthConfig } from '../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { authApplies, bearerSource } from '../auth/apply.js';
import type { OpenApiFixtureConfig } from '../config/schema.js';
import { FixtureInitError, MissingPackageError, formatViolation } from '../errors.js';
import { ConfigLoader } from '../config/loader.js';
import { ContractValidator, assertContract, type ContractMode, type ContractResult } from '../openapi/contract.js';

/**
 * The OpenAPI client object provided to tests.
 */
export interface OpenApiClient {
    /** Axios instance extended with operation methods from the spec. */
    client: AxiosInstance;
    /** The underlying OpenAPIClientAxios instance. */
    api: OpenAPIClientAxios;
    /**
     * Checks a response (from `client`) against the spec: status, content type
     * and body schema. Returns the violations instead of throwing, and works
     * whether or not `validateResponses` is on. Matches the operation by the
     * request's method and URL, or by `operationId` when given.
     */
    checkResponse(response: AxiosResponseLike, operationId?: string): Promise<ContractResult>;
}

/** The parts of an Axios response a contract check reads. */
export interface AxiosResponseLike {
    status: number;
    headers?: any;
    data: unknown;
    config?: { method?: string; url?: string; baseURL?: string };
}

/**
 * Per-call opt-out, in the Axios config (the 3rd argument of an operation):
 * `{ contract: false }` skips both checks for that call, and
 * `{ contract: { request: false } }` only the request check, for a negative
 * test that sends an invalid body on purpose (its 400 response is still checked).
 */
export type ContractCallOption = false | { request?: boolean; response?: boolean };

function wants(config: { contract?: ContractCallOption } | undefined, kind: 'request' | 'response'): boolean {
    const option = config?.contract;
    if (option === false) return false;
    return option?.[kind] !== false;
}

/** Minimal TestInfo: where contract results are attached. */
interface ContractTestInfo {
    annotations: Array<{ type: string; description?: string }>;
    attach(name: string, options: { body: string; contentType: string }): Promise<void>;
}

/**
 * Records a contract mismatch on the test (an annotation plus a JSON
 * attachment), then throws a ContractError unless `mode` is 'warn'.
 */
async function reportContract(result: ContractResult, mode: ContractMode, testInfo: ContractTestInfo | undefined, cause?: Error): Promise<void> {
    if (!result.violations.length) return;
    const op = result.operation;
    const name = `${result.kind} ${op?.operationId ?? `${op?.method.toUpperCase()} ${op?.path}`}`;
    if (testInfo) {
        testInfo.annotations.push({
            type: mode === 'warn' ? 'contract-warning' : 'contract-violation',
            description: `${name}: ${result.violations.map(formatViolation).join('; ')}`,
        });
        await testInfo.attach(`contract ${name}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    }
    if (mode !== 'warn') assertContract(result, cause);
}

/** Builds the contract validator once, the first time a check needs it. */
function lazyContract(api: OpenAPIClientAxios): () => Promise<ContractValidator> {
    let pending: Promise<ContractValidator> | undefined;
    return () => (pending ??= ContractValidator.create((api as any).document));
}

function toResponseInput(response: AxiosResponseLike, operationId?: string) {
    return {
        method: response.config?.method ?? 'get',
        url: response.config?.url ?? '/',
        status: response.status,
        headers: response.headers,
        data: response.data,
        operationId,
    };
}

/** Default timeout for remote spec retrieval (ms). */
const DEFAULT_SPEC_TIMEOUT = 10_000;

/** Default timeout for client initialization (ms). */
const DEFAULT_INIT_TIMEOUT = 30_000;

/**
 * Creates a promise that rejects after the specified timeout.
 */
function createTimeout(ms: number, label: string): { promise: Promise<never>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
    });
    const clear = () => clearTimeout(timer!);
    return { promise, clear };
}

/** Loads js-yaml, an optional peer dependency needed only for YAML spec files. */
export type YamlLoader = () => Promise<typeof import('js-yaml')>;

const loadJsYaml: YamlLoader = () =>
    loadOptional<typeof import('js-yaml')>('js-yaml', 'openApiClient (YAML spec)');

/** Parses spec text: YAML for `.yaml`/`.yml` files (loading js-yaml), JSON otherwise. */
async function parseSpec(raw: string, filePath: string, loadYaml: YamlLoader): Promise<unknown> {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.yaml' || ext === '.yml') {
        const yaml = await loadYaml();
        return yaml.load(raw, { filename: filePath });
    }
    return JSON.parse(raw);
}

/** True when `specPath` is an http(s) URL that openapi-client-axios should fetch itself. */
export function isRemoteSpec(specPath: string): boolean {
    return /^https?:\/\//i.test(specPath.trim());
}

/**
 * Resolves `specPath` to the `definition` passed to openapi-client-axios.
 *
 * - http(s) URLs are returned unchanged; openapi-client-axios fetches them.
 * - Anything else is a local file: resolved against `cwd` (the project root)
 *   when relative, read from disk, and parsed as YAML (`.yaml`/`.yml`, which
 *   needs js-yaml installed) or JSON (anything else).
 *
 * A YAML spec without js-yaml installed throws `MissingPackageError`.
 * Throws `FixtureInitError('openApiClient', 'init', { specPath, reason })` when
 * the file is missing, unreadable, or does not parse to an object.
 */
export async function resolveSpecDefinition(
    specPath: string,
    cwd: string = process.cwd(),
    loadYaml: YamlLoader = loadJsYaml,
): Promise<string | Document> {
    if (isRemoteSpec(specPath)) {
        return specPath;
    }

    const filePath = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);

    let raw: string;
    try {
        raw = await readFile(filePath, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason = code === 'ENOENT'
            ? `OpenAPI spec file not found: ${filePath}`
            : `Could not read OpenAPI spec file ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
        throw new FixtureInitError('openApiClient', 'init', { specPath, reason }, error instanceof Error ? error : undefined);
    }

    let parsed: unknown;
    try {
        parsed = await parseSpec(raw, filePath, loadYaml);
    } catch (error) {
        if (error instanceof MissingPackageError) throw error;
        throw new FixtureInitError(
            'openApiClient',
            'init',
            {
                specPath,
                reason: `Could not parse OpenAPI spec file ${filePath} as ${/\.ya?ml$/i.test(filePath) ? 'YAML' : 'JSON'}: ${error instanceof Error ? error.message : String(error)}`,
            },
            error instanceof Error ? error : undefined,
        );
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new FixtureInitError('openApiClient', 'init', {
            specPath,
            reason: `OpenAPI spec file ${filePath} does not contain an OpenAPI document (expected an object)`,
        });
    }

    return parsed as Document;
}

/**
 * OpenAPI fixture definition for use with Playwright's test.extend().
 *
 * Spread this into your fixture registry:
 *   export const test = base.extend({ ...openApiFixture });
 */
export const openApiFixture = {
    openApiClient: [
        async (
            {
                openapi,
                authConfig,
                authRole,
                authTokens,
            }: { openapi: OpenApiFixtureConfig | undefined; authConfig: AuthConfig | undefined; authRole: string | undefined; authTokens: TokenManager },
            use: (client: OpenApiClient) => Promise<void>,
            testInfo?: ContractTestInfo,
        ) => {
            // Use config from project `use` block if provided, otherwise fall back to ConfigLoader
            let openapiConfig: OpenApiFixtureConfig | undefined = openapi;

            if (!openapiConfig) {
                const configLoader = new ConfigLoader();
                const config = configLoader.load();
                openapiConfig = config.openapi;
            }

            if (!openapiConfig || !openapiConfig.specPath) {
                throw new FixtureInitError('openApiClient', 'init', {
                    reason: 'OpenAPI configuration is missing or specPath is not defined',
                });
            }

            const specPath = openapiConfig.specPath;
            const baseUrl = openapiConfig.baseUrl;
            const specTimeout = openapiConfig.specTimeout ?? DEFAULT_SPEC_TIMEOUT;
            const initTimeout = openapiConfig.initTimeout ?? DEFAULT_INIT_TIMEOUT;

            // openapi-client-axios is an optional peer dependency, loaded on first use.
            const { OpenAPIClientAxios: OpenAPIClientAxiosClass } = await loadOptional<typeof import('openapi-client-axios')>(
                'openapi-client-axios',
                'openApiClient',
            );

            // Local files are read and parsed here; a string definition would be
            // fetched over HTTP (relative to the API base URL) by openapi-client-axios.
            const definition = await resolveSpecDefinition(specPath);

            let api: OpenAPIClientAxios;
            let client: AxiosInstance;

            try {
                // Build OpenAPIClientAxios options
                const opts: ConstructorParameters<typeof OpenAPIClientAxios>[0] = {
                    definition,
                    axiosConfigDefaults: {
                        timeout: specTimeout,
                    },
                };

                // If a base URL override is provided, set it via axiosConfigDefaults
                if (baseUrl) {
                    opts.axiosConfigDefaults = {
                        ...opts.axiosConfigDefaults,
                        baseURL: baseUrl,
                    };
                }

                api = new OpenAPIClientAxiosClass(opts);

                // Initialize with timeout
                const timeout = createTimeout(initTimeout, 'OpenAPI client initialization');

                try {
                    client = await Promise.race([api.init(), timeout.promise]);
                } finally {
                    timeout.clear();
                }

                // Apply base URL override after init (ensures it takes precedence over spec servers)
                if (baseUrl) {
                    client.defaults.baseURL = baseUrl;
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                throw new FixtureInitError(
                    'openApiClient',
                    'init',
                    {
                        specPath,
                        reason,
                        timeout: initTimeout,
                    },
                    error instanceof Error ? error : undefined
                );
            }

            // Auth helpers: send the role's bearer token on every request, unless the call sets its own.
            if (authApplies(authConfig, 'openapi')) {
                const token = bearerSource(authTokens, authConfig, authRole);
                client.interceptors.request.use(async (request) => {
                    if (!request.headers.has('Authorization')) request.headers.set('Authorization', `Bearer ${await token()}`);
                    return request;
                });
            }

            // Contract checks: requests and responses against the spec (Ajv, loaded on first use).
            const contract = lazyContract(api);
            const requestMode = openapiConfig.validateRequests ?? false;
            const responseMode = openapiConfig.validateResponses ?? false;
            if (requestMode || responseMode) await contract(); // a missing ajv fails here, not mid-test
            if (requestMode) {
                client.interceptors.request.use(async (request) => {
                    if (!wants(request as { contract?: ContractCallOption }, 'request')) return request;
                    const result = (await contract()).checkRequest(
                        {
                            method: request.method ?? 'get',
                            url: request.url ?? '/',
                            contentType: request.headers?.get?.('Content-Type')?.toString() ?? undefined,
                            data: request.data,
                        },
                        request.baseURL,
                    );
                    await reportContract(result, requestMode, testInfo);
                    return request;
                });
            }
            if (responseMode) {
                const check = async (response: AxiosResponseLike, cause?: Error) => {
                    if (!wants(response.config as { contract?: ContractCallOption } | undefined, 'response')) return;
                    const result = (await contract()).checkResponse(toResponseInput(response), response.config?.baseURL);
                    await reportContract(result, responseMode, testInfo, cause);
                };
                client.interceptors.response.use(
                    async (response) => {
                        await check(response);
                        return response;
                    },
                    async (error) => {
                        // Non-2xx responses are checked too: a 404 body is part of the contract.
                        if (error?.response) await check(error.response, error);
                        throw error;
                    },
                );
            }

            const checkResponse = async (response: AxiosResponseLike, operationId?: string) =>
                (await contract()).checkResponse(toResponseInput(response, operationId), response.config?.baseURL ?? client.defaults.baseURL);

            // Provide the client to the test
            await use({ client, api, checkResponse });

            // Teardown: clear internal references
            (api as any).instance = null;
            (api as any).document = null;
            (api as any).definition = null;
        },
        { scope: 'test' },
    ],
};
