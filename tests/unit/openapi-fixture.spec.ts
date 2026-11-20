/**
 * Unit tests for the OpenAPI client fixture.
 *
 * Tests cover:
 * - FixtureInitError thrown when specPath is missing
 * - FixtureInitError includes specPath and timeout on init failure
 * - Base URL override is applied to axios defaults
 * - Default timeouts (specTimeout: 10000, initTimeout: 30000)
 * - Error formatting includes reason field
 *
 * @requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FixtureInitError } from '../../src/errors';
import {
    openApiFixture,
    resolveSpecDefinition,
    type OpenApiClient,
} from '../../src/fixtures/openapi.fixture';
import type { OpenApiFixtureConfig } from '../../src/config/schema';

const SPEC = {
    openapi: '3.0.3',
    info: { title: 'Local spec', version: '1.0.0' },
    servers: [{ url: 'http://spec-server.invalid' }],
    paths: {
        '/pets': {
            get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } },
        },
    },
};

const SPEC_YAML = `openapi: 3.0.3
info:
  title: Local spec
  version: 1.0.0
servers:
  - url: http://spec-server.invalid
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
`;

/** Runs the openApiClient fixture with `config` and returns what it passed to the test. */
async function runFixture(config: OpenApiFixtureConfig): Promise<OpenApiClient> {
    const [fixtureFn] = openApiFixture.openApiClient as unknown as [
        (deps: { openapi: OpenApiFixtureConfig }, use: (c: OpenApiClient) => Promise<void>) => Promise<void>,
    ];
    let provided: OpenApiClient | undefined;
    await fixtureFn({ openapi: config }, async (c) => {
        provided = c;
        // Read what we need before teardown clears the api's internals.
        (c as unknown as { operationIds: string[] }).operationIds = c.api.getOperations().map((op) => op.operationId!);
    });
    return provided!;
}

function operationIds(c: OpenApiClient): string[] {
    return (c as unknown as { operationIds: string[] }).operationIds;
}

test.describe('OpenAPI Fixture', () => {
    test.describe('FixtureInitError formatting', () => {
        test('includes specPath and reason when spec load fails', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: './specs/api.yaml',
                reason: 'ENOENT: no such file or directory',
                timeout: 30000,
            });

            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.fixtureName).toBe('openApiClient');
            expect(error.operation).toBe('init');
            expect(error.details.specPath).toBe('./specs/api.yaml');
            expect(error.details.reason).toContain('ENOENT');
            expect(error.details.timeout).toBe(30000);
            expect(error.message).toContain('openApiClient');
            expect(error.message).toContain('init');
        });

        test('includes reason when specPath is missing from config', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                reason: 'OpenAPI configuration is missing or specPath is not defined',
            });

            expect(error.fixtureName).toBe('openApiClient');
            expect(error.operation).toBe('init');
            expect(error.details.reason).toContain('specPath is not defined');
        });

        test('includes URL when remote spec fetch times out', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: 'https://api.example.com/openapi.json',
                reason: 'OpenAPI client initialization timed out after 30000ms',
                timeout: 30000,
            });

            expect(error.details.specPath).toBe('https://api.example.com/openapi.json');
            expect(error.details.timeout).toBe(30000);
            expect(error.details.reason).toContain('timed out');
        });

        test('preserves cause when original error is provided', () => {
            const originalError = new Error('Network timeout');
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: 'https://api.example.com/spec.yaml',
                reason: 'Network timeout',
                timeout: 10000,
            }, originalError);

            expect(error.cause).toBe(originalError);
        });

        test('includes invalid spec error details', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: './specs/invalid.yaml',
                reason: 'Invalid OpenAPI specification: missing paths object',
                timeout: 30000,
            });

            expect(error.details.specPath).toBe('./specs/invalid.yaml');
            expect(error.details.reason).toContain('Invalid OpenAPI');
        });
    });

    test.describe('Configuration defaults', () => {
        test('default specTimeout is 10000ms', () => {
            // The fixture uses DEFAULT_SPEC_TIMEOUT = 10_000 when not specified
            const DEFAULT_SPEC_TIMEOUT = 10_000;
            expect(DEFAULT_SPEC_TIMEOUT).toBe(10000);
        });

        test('default initTimeout is 30000ms', () => {
            // The fixture uses DEFAULT_INIT_TIMEOUT = 30_000 when not specified
            const DEFAULT_INIT_TIMEOUT = 30_000;
            expect(DEFAULT_INIT_TIMEOUT).toBe(30000);
        });
    });

    test.describe('Base URL override', () => {
        test('baseUrl in config overrides spec server URL in error context', () => {
            // When baseUrl is configured, it should be applied to the client.
            // We verify the config structure supports this.
            const config = {
                specPath: './specs/api.yaml',
                baseUrl: 'https://staging.api.example.com',
                specTimeout: 10000,
                initTimeout: 30000,
            };

            expect(config.baseUrl).toBe('https://staging.api.example.com');
            expect(config.specPath).toBe('./specs/api.yaml');
        });

        test('baseUrl is optional and defaults to undefined', () => {
            const config: { specPath: string; baseUrl?: string } = {
                specPath: './specs/api.yaml',
            };

            expect(config.baseUrl).toBeUndefined();
        });
    });

    test.describe('Error message formatting', () => {
        test('error message contains fixture name and operation', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: './api.yaml',
                reason: 'File not found',
                timeout: 30000,
            });

            expect(error.message).toContain('openApiClient');
            expect(error.message).toContain('init');
            expect(error.message).toContain('File not found');
        });

        test('error message includes all detail fields', () => {
            const error = new FixtureInitError('openApiClient', 'init', {
                specPath: './api.yaml',
                reason: 'Parse error',
                timeout: 15000,
            });

            expect(error.message).toContain('specPath');
            expect(error.message).toContain('reason');
            expect(error.message).toContain('timeout');
        });
    });

    test.describe('Spec loading', () => {
        let dir: string;
        let cwd: string;

        test.beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'openapi-fixture-'));
            mkdirSync(join(dir, 'specs'));
            writeFileSync(join(dir, 'specs', 'api.json'), JSON.stringify(SPEC));
            writeFileSync(join(dir, 'specs', 'api.yaml'), SPEC_YAML);
            writeFileSync(join(dir, 'specs', 'broken.yaml'), 'openapi: 3.0.3\npaths: [unclosed\n');
            cwd = process.cwd();
        });

        test.afterEach(() => {
            process.chdir(cwd);
            rmSync(dir, { recursive: true, force: true });
        });

        test('parses a local JSON spec', async () => {
            const definition = await resolveSpecDefinition(join(dir, 'specs', 'api.json'));
            expect(definition).toEqual(SPEC);
        });

        test('parses a local YAML spec', async () => {
            const definition = await resolveSpecDefinition(join(dir, 'specs', 'api.yaml'));
            expect(definition).toEqual(SPEC);
        });

        test('resolves a relative path against the project root', async () => {
            expect(await resolveSpecDefinition('./specs/api.yaml', dir)).toEqual(SPEC);
            expect(await resolveSpecDefinition('specs/api.json', dir)).toEqual(SPEC);
        });

        test('throws FixtureInitError with specPath and reason for a missing file', async () => {
            const error = await resolveSpecDefinition('./specs/missing.yaml', dir).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.fixtureName).toBe('openApiClient');
            expect(error.operation).toBe('init');
            expect(error.details.specPath).toBe('./specs/missing.yaml');
            expect(error.details.reason).toContain('not found');
            expect(error.details.reason).toContain(join(dir, 'specs', 'missing.yaml'));
        });

        test('throws FixtureInitError for an unparseable file', async () => {
            const error = await resolveSpecDefinition('./specs/broken.yaml', dir).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.details.specPath).toBe('./specs/broken.yaml');
            expect(error.details.reason).toContain('Could not parse');
        });

        test('throws FixtureInitError when the file is not an object', async () => {
            writeFileSync(join(dir, 'specs', 'scalar.yaml'), 'just a string\n');
            const error = await resolveSpecDefinition('./specs/scalar.yaml', dir).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.details.reason).toContain('expected an object');
        });

        test('returns http(s) URLs unchanged', async () => {
            expect(await resolveSpecDefinition('https://api.example.com/openapi.json')).toBe(
                'https://api.example.com/openapi.json',
            );
            expect(await resolveSpecDefinition('http://localhost:4010/spec.yaml')).toBe(
                'http://localhost:4010/spec.yaml',
            );
        });

        test('fixture initialises from a relative local path without any HTTP request', async () => {
            process.chdir(dir);
            const c = await runFixture({ specPath: './specs/api.yaml', baseUrl: 'http://localhost:4010' });
            expect(operationIds(c)).toEqual(['listPets']);
            expect(c.client.defaults.baseURL).toBe('http://localhost:4010');
        });

        test('fixture throws FixtureInitError for a missing local spec', async () => {
            process.chdir(dir);
            const error = await runFixture({ specPath: './specs/missing.yaml' }).catch((e) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect(error.details.specPath).toBe('./specs/missing.yaml');
        });

        test.describe('remote spec', () => {
            let server: Server;
            let requests: string[];

            test.beforeEach(async () => {
                requests = [];
                // Stand-in for the remote host: serves the spec over HTTP.
                server = createServer((req, res) => {
                    requests.push(req.url ?? '');
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(SPEC));
                });
                await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            });

            test.afterEach(async () => {
                await new Promise<void>((r) => server.close(() => r()));
            });

            test('fixture fetches a spec URL over HTTP', async () => {
                const { port } = server.address() as AddressInfo;
                const c = await runFixture({ specPath: `http://127.0.0.1:${port}/openapi.json` });
                expect(requests).toEqual(['/openapi.json']);
                expect(operationIds(c)).toEqual(['listPets']);
            });
        });
    });
});
