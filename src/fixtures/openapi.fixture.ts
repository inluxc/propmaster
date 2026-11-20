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
import type { OpenApiFixtureConfig } from '../config/schema.js';
import { FixtureInitError, MissingPackageError } from '../errors.js';
import { ConfigLoader } from '../config/loader.js';

/**
 * The OpenAPI client object provided to tests.
 */
export interface OpenApiClient {
    /** Axios instance extended with operation methods from the spec. */
    client: AxiosInstance;
    /** The underlying OpenAPIClientAxios instance. */
    api: OpenAPIClientAxios;
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

/**
 * Parses spec text as JSON, or as YAML when it isn't JSON. js-yaml is an
 * optional peer dependency, loaded only for YAML specs.
 */
async function parseSpec(raw: string, filePath: string): Promise<unknown> {
    if (extname(filePath).toLowerCase() === '.json') {
        return JSON.parse(raw);
    }
    try {
        return JSON.parse(raw);
    } catch {
        const yaml = await loadOptional<typeof import('js-yaml')>('js-yaml', 'openApiClient (YAML spec file)');
        return yaml.load(raw, { filename: filePath });
    }
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
 *   when relative, read from disk, and parsed as JSON or YAML.
 *
 * Throws `FixtureInitError('openApiClient', 'init', { specPath, reason })` when
 * the file is missing, unreadable, or does not parse to an object.
 */
export async function resolveSpecDefinition(
    specPath: string,
    cwd: string = process.cwd(),
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
        parsed = await parseSpec(raw, filePath);
    } catch (error) {
        if (error instanceof MissingPackageError) throw error;
        throw new FixtureInitError(
            'openApiClient',
            'init',
            {
                specPath,
                reason: `Could not parse OpenAPI spec file ${filePath} as JSON or YAML: ${error instanceof Error ? error.message : String(error)}`,
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
            { openapi }: { openapi: OpenApiFixtureConfig | undefined },
            use: (client: OpenApiClient) => Promise<void>,
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

            // Provide the client to the test
            await use({ client, api });

            // Teardown: clear internal references
            (api as any).instance = null;
            (api as any).document = null;
            (api as any).definition = null;
        },
        { scope: 'test' },
    ],
};
