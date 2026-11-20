/**
 * Unit tests for OpenAPI contract checks (src/openapi/contract.ts) and the
 * openApiClient's validateResponses / validateRequests options.
 *
 * Covers: valid and invalid responses, readable violations (JSON path,
 * expected, actual), missing schemas, undocumented statuses and content
 * types, path matching, request bodies, Swagger 2.0 / OpenAPI 3.0 / 3.1,
 * and the fixture end to end against a local HTTP server.
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ContractError, formatViolation } from '../../src/errors';
import { ContractValidator, assertContract, jsonPath, normalizeDocument, parseContractMode } from '../../src/openapi/contract';
import { openApiFixture, type OpenApiClient } from '../../src/fixtures/openapi.fixture';
import { OpenApiSteps } from '../../src/steps/openapi.steps';
import type { OpenApiFixtureConfig } from '../../src/config/schema';
import { ConfigLoader } from '../../src/config/loader';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const OAS30 = {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1.0.0' },
    paths: {
        '/products': {
            get: {
                operationId: 'listProducts',
                responses: {
                    '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } },
                },
            },
            post: {
                operationId: 'createProduct',
                requestBody: { $ref: '#/components/requestBodies/NewProduct' },
                responses: {
                    '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
                    '4XX': { $ref: '#/components/responses/Problem' },
                },
            },
        },
        '/products/search': {
            get: { operationId: 'searchProducts', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } } },
        },
        '/products/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: {
                operationId: 'getProduct',
                responses: {
                    '200': {
                        description: 'ok',
                        content: {
                            'application/json': { schema: { $ref: '#/components/schemas/Product' } },
                            'application/xml': { schema: { $ref: '#/components/schemas/Product' } },
                        },
                    },
                    '404': { description: 'not found' },
                    default: { $ref: '#/components/responses/Problem' },
                },
            },
            delete: { operationId: 'deleteProduct', responses: { '204': { description: 'gone' } } },
        },
        '/categories/{id}': {
            get: {
                operationId: 'getCategory',
                responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Category' } } } } },
            },
        },
        '/health': {
            get: { operationId: 'health', responses: { '200': { description: 'ok', content: { 'text/plain': {} } } } },
        },
    },
    components: {
        schemas: {
            Product: {
                type: 'object',
                required: ['id', 'name', 'price'],
                additionalProperties: false,
                properties: {
                    id: { type: 'integer', format: 'int32' },
                    name: { type: 'string', minLength: 1 },
                    price: { type: 'number', minimum: 0, exclusiveMinimum: true },
                    status: { type: 'string', enum: ['active', 'retired'] },
                    note: { type: 'string', nullable: true },
                    updatedAt: { type: 'string', format: 'date-time' },
                    tags: { type: 'array', items: { type: 'string' } },
                    'x-ref': { type: 'string' },
                },
            },
            // Recursive: a category holds child categories.
            Category: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Category' } } },
            },
            Problem: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, status: { type: 'integer' } } },
        },
        requestBodies: {
            NewProduct: {
                required: true,
                content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' } } } } },
            },
        },
        responses: {
            Problem: { description: 'problem', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
        },
    },
};

const SWAGGER2 = {
    swagger: '2.0',
    info: { title: 'Pets', version: '1' },
    basePath: '/v2',
    paths: {
        '/pet': {
            post: {
                operationId: 'addPet',
                parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
                responses: { '405': { description: 'Invalid input' } },
            },
        },
        '/pet/{petId}': {
            get: {
                operationId: 'getPetById',
                produces: ['application/json', 'application/xml'],
                responses: { '200': { description: 'ok', schema: { $ref: '#/definitions/Pet' } }, '404': { description: 'not found' } },
            },
        },
    },
    definitions: {
        Pet: {
            type: 'object',
            required: ['name', 'photoUrls'],
            properties: {
                id: { type: 'integer', format: 'int64' },
                name: { type: 'string', example: 'doggie' },
                photoUrls: { type: 'array', items: { type: 'string' } },
                nickname: { type: 'string', 'x-nullable': true },
            },
        },
    },
};

const OAS31 = {
    openapi: '3.1.0',
    info: { title: 'Notes', version: '1' },
    paths: {
        '/notes/{id}': {
            get: {
                operationId: 'getNote',
                responses: {
                    '200': {
                        description: 'ok',
                        content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, body: { type: ['string', 'null'] } } } } },
                    },
                },
            },
        },
    },
};

const product = { id: 1, name: 'Lamp', price: 12.5, status: 'active', note: null, updatedAt: '2026-11-20T10:00:00Z' };

test.describe('Contract checks', () => {
    let oas30: ContractValidator;

    test.beforeAll(async () => {
        oas30 = await ContractValidator.create(OAS30);
    });

    test.describe('valid responses', () => {
        test('a response matching its schema has no violations', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/products/1', status: 200, headers: JSON_HEADERS, data: product });
            expect(result.violations).toEqual([]);
            expect(result.skipped).toBeUndefined();
            expect(result.operation).toEqual({ operationId: 'getProduct', method: 'get', path: '/products/{id}' });
            expect(result.contentType).toBe('application/json');
        });

        test('arrays, $refs, nullable and recursive schemas validate', () => {
            expect(oas30.checkResponse({ method: 'get', url: '/products', status: 200, headers: JSON_HEADERS, data: [product, { ...product, id: 2 }] }).violations).toEqual([]);
            const tree = { name: 'root', children: [{ name: 'a', children: [{ name: 'a1' }] }] };
            expect(oas30.checkResponse({ method: 'get', url: '/categories/1', status: 200, headers: JSON_HEADERS, data: tree }).violations).toEqual([]);
        });

        test('range (4XX) and default responses, through components/responses', () => {
            const problem = { 'content-type': 'application/problem+json' };
            expect(oas30.checkResponse({ method: 'post', url: '/products', status: 409, headers: problem, data: { title: 'dup' } }).violations).toEqual([]);
            expect(oas30.checkResponse({ method: 'get', url: '/products/1', status: 500, headers: problem, data: { title: 'boom' } }).violations).toEqual([]);
            const bad = oas30.checkResponse({ method: 'get', url: '/products/1', status: 500, headers: problem, data: { status: 500 } });
            expect(bad.violations).toEqual([{ path: '$.title', message: 'is required' }]);
        });

        test('AxiosHeaders-style headers (a get() method) are read', () => {
            const headers = { get: (n: string) => (n === 'content-type' ? 'application/json' : undefined) };
            expect(oas30.checkResponse({ method: 'get', url: '/products/1', status: 200, headers, data: product }).contentType).toBe('application/json');
        });
    });

    test.describe('invalid responses', () => {
        test('each mismatch has a JSON path, expected and actual value', () => {
            const data = { id: 'abc', price: 0, status: 'lost', tags: ['a', 3], extra: true, 'x-ref': 1, note: 5 };
            const { violations } = oas30.checkResponse({ method: 'get', url: '/products/7', status: 200, headers: JSON_HEADERS, data });
            expect(violations).toEqual(
                expect.arrayContaining([
                    { path: '$.name', message: 'is required' },
                    { path: '$.id', message: 'must be integer', expected: 'integer', actual: 'abc' },
                    expect.objectContaining({ path: '$.price', actual: 0 }),
                    { path: '$.status', message: 'must be one of the allowed values', expected: ['active', 'retired'], actual: 'lost' },
                    { path: '$.tags[1]', message: 'must be string', expected: 'string', actual: 3 },
                    { path: '$.extra', message: "isn't in the schema (additionalProperties: false)", actual: true },
                    { path: '$["x-ref"]', message: 'must be string', expected: 'string', actual: 1 },
                    { path: '$.note', message: 'must be string or null', expected: 'string or null', actual: 5 },
                ]),
            );
        });

        test('OpenAPI formats are checked (int32 range, date-time)', () => {
            const { violations } = oas30.checkResponse({
                method: 'get', url: '/products/1', status: 200, headers: JSON_HEADERS,
                data: { ...product, id: 2 ** 40, updatedAt: 'yesterday' },
            });
            expect(violations.map((v) => v.path).sort()).toEqual(['$.id', '$.updatedAt']);
        });

        test('nested arrays of objects report the item index', () => {
            const { violations } = oas30.checkResponse({ method: 'get', url: '/products', status: 200, headers: JSON_HEADERS, data: [product, { ...product, price: 'free' }] });
            expect(violations).toEqual([{ path: '$[1].price', message: 'must be number', expected: 'number', actual: 'free' }]);
        });

        test('a status the operation does not document is a violation', () => {
            const { violations } = oas30.checkResponse({ method: 'get', url: '/products', status: 418, headers: JSON_HEADERS, data: {} });
            expect(violations).toEqual([{ path: '$', message: "status 418 isn't documented for this operation", expected: '200', actual: 418 }]);
        });

        test('a content type the status does not document is a violation', () => {
            const { violations } = oas30.checkResponse({ method: 'get', url: '/products/1', status: 200, headers: { 'content-type': 'text/html' }, data: '<html>' });
            expect(violations).toEqual([
                { path: '$', message: "content type isn't documented for this status", expected: 'application/json, application/xml', actual: 'text/html' },
            ]);
        });

        test('ContractError lists every violation in a readable message', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/products/1', status: 200, headers: JSON_HEADERS, data: { id: 'x', name: 'n', price: 1 } });
            let error: unknown;
            try {
                assertContract(result);
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(ContractError);
            const err = error as ContractError;
            expect(err.message).toBe(
                "The response from getProduct (GET /products/{id}) with status 200 (application/json) doesn't match the OpenAPI spec:\n" +
                    '  - $.id: must be integer (expected integer, got "x")',
            );
            expect(err.kind).toBe('response');
            expect(err.status).toBe(200);
            expect(err.violations).toHaveLength(1);
            expect(() => assertContract({ ...result, violations: [] })).not.toThrow();
        });

        test('long lists are cut at 20 lines', () => {
            const many = Array.from({ length: 25 }, (_, i) => ({ path: `$[${i}]`, message: 'must be object' }));
            const err = new ContractError('response', { method: 'get', path: '/x' }, many, 200);
            expect(err.message).toContain('  - $[19]: must be object');
            expect(err.message).not.toContain('$[20]');
            expect(err.message).toContain('... and 5 more');
        });

        test('formatViolation truncates long actual values', () => {
            const line = formatViolation({ path: '$.blob', message: 'must be number', expected: 'number', actual: 'x'.repeat(200) });
            expect(line.length).toBeLessThan(140);
            expect(line).toContain('...');
        });
    });

    test.describe('missing schemas', () => {
        test('a documented status without a body schema passes', () => {
            const result = oas30.checkResponse({ method: 'delete', url: '/products/1', status: 204, data: '' });
            expect(result.violations).toEqual([]);
            expect(result.skipped).toBeUndefined();
        });

        test('a status without content, but a body, is skipped (nothing to check against)', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/products/1', status: 404, headers: JSON_HEADERS, data: { error: 'nope' } });
            expect(result.violations).toEqual([]);
            expect(result.skipped).toBe('status 404 documents no body');
        });

        test('a media type without a schema is skipped', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/health', status: 200, headers: { 'content-type': 'text/plain' }, data: 'ok' });
            expect(result).toMatchObject({ violations: [], skipped: 'text/plain has no schema' });
        });

        test('a non-JSON body (XML) is skipped', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/products/1', status: 200, headers: { 'content-type': 'application/xml' }, data: '<Product/>' });
            expect(result).toMatchObject({ violations: [], skipped: "application/xml body isn't JSON" });
        });

        test('a request no operation matches is skipped', () => {
            const result = oas30.checkResponse({ method: 'get', url: '/nowhere', status: 200, data: {} });
            expect(result.operation).toBeUndefined();
            expect(result.skipped).toBe('no operation in the spec matches GET /nowhere');
            expect(oas30.checkResponse({ method: 'get', url: '/x', status: 200, data: {}, operationId: 'nope' }).skipped).toBe('no operation "nope" in the spec');
        });
    });

    test.describe('operation matching', () => {
        test('literal paths win over templates', () => {
            expect(oas30.findOperation('get', '/products/search')?.operationId).toBe('searchProducts');
            expect(oas30.findOperation('get', '/products/42')?.operationId).toBe('getProduct');
            expect(oas30.findOperation('GET', '/products/42/')?.operationId).toBe('getProduct');
            expect(oas30.findOperation('delete', '/products/42')?.operationId).toBe('deleteProduct');
            expect(oas30.findOperation('put', '/products/42')).toBeUndefined();
        });

        test('query strings, absolute URLs and server base paths are ignored', () => {
            expect(oas30.findOperation('get', '/products?limit=5')?.operationId).toBe('listProducts');
            expect(oas30.findOperation('get', 'http://api.test/api/v1/products/9', 'http://api.test/api/v1')?.operationId).toBe('getProduct');
            expect(oas30.findOperation('get', 'http://api.test/v1/products/9')?.operationId).toBe('getProduct');
        });

        test('operationId picks the operation directly', () => {
            const result = oas30.checkResponse({ method: 'get', url: 'whatever', status: 200, headers: JSON_HEADERS, data: [], operationId: 'listProducts' });
            expect(result.operation?.operationId).toBe('listProducts');
            expect(result.violations).toEqual([]);
        });

        test('allOperations lists the spec', () => {
            expect(oas30.allOperations.map((o) => o.operationId).sort()).toEqual(
                ['createProduct', 'deleteProduct', 'getCategory', 'getProduct', 'health', 'listProducts', 'searchProducts'],
            );
        });
    });

    test.describe('request bodies', () => {
        test('a valid body passes, an invalid one has violations', () => {
            expect(oas30.checkRequest({ method: 'post', url: '/products', data: { name: 'Lamp', price: 3 } }).violations).toEqual([]);
            expect(oas30.checkRequest({ method: 'post', url: '/products', data: { name: 5 } }).violations).toEqual([
                { path: '$.price', message: 'is required' },
                { path: '$.name', message: 'must be string', expected: 'string', actual: 5 },
            ]);
        });

        test('a JSON string body is parsed first', () => {
            expect(oas30.checkRequest({ method: 'post', url: '/products', data: '{"name":"a","price":1}' }).violations).toEqual([]);
        });

        test('a missing required body, and an unaccepted content type, are violations', () => {
            expect(oas30.checkRequest({ method: 'post', url: '/products', data: undefined }).violations).toEqual([{ path: '$', message: 'request body is required' }]);
            expect(oas30.checkRequest({ method: 'post', url: '/products', contentType: 'text/csv', data: 'a,b' }).violations).toEqual([
                { path: '$', message: "content type isn't accepted by this operation", expected: 'application/json', actual: 'text/csv' },
            ]);
        });

        test('operations without a request body are skipped', () => {
            expect(oas30.checkRequest({ method: 'get', url: '/products', data: undefined })).toMatchObject({ violations: [], skipped: 'operation takes no body' });
        });
    });

    test.describe('Swagger 2.0', () => {
        let swagger: ContractValidator;

        test.beforeAll(async () => {
            swagger = await ContractValidator.create(SWAGGER2);
        });

        test('responses validate against definitions', () => {
            const ok = swagger.checkResponse({ method: 'get', url: '/pet/1', status: 200, headers: JSON_HEADERS, data: { id: 1, name: 'Rex', photoUrls: [], nickname: null } });
            expect(ok.violations).toEqual([]);
            const bad = swagger.checkResponse({ method: 'get', url: '/pet/1', status: 200, headers: JSON_HEADERS, data: { id: 1.5, photoUrls: 'x' } });
            expect(bad.violations.map((v) => v.path).sort()).toEqual(['$.id', '$.name', '$.photoUrls']);
        });

        test('statuses without a schema are skipped; XML bodies too', () => {
            expect(swagger.checkResponse({ method: 'get', url: '/pet/1', status: 404, data: '' }).skipped).toBe('status 404 has no schema');
            expect(swagger.checkResponse({ method: 'get', url: '/pet/1', status: 200, headers: { 'content-type': 'application/xml' }, data: '<Pet/>' }).skipped).toBe(
                "application/xml body isn't JSON",
            );
        });

        test('body parameters are checked', () => {
            expect(swagger.checkRequest({ method: 'post', url: '/pet', data: { name: 'Rex', photoUrls: [] } }).violations).toEqual([]);
            expect(swagger.checkRequest({ method: 'post', url: '/pet', data: { name: 'Rex' } }).violations).toEqual([{ path: '$.photoUrls', message: 'is required' }]);
            expect(swagger.checkRequest({ method: 'post', url: '/pet', data: undefined }).violations).toEqual([{ path: '$', message: 'request body is required' }]);
        });
    });

    test.describe('OpenAPI 3.1', () => {
        test('JSON Schema 2020-12 type arrays work', async () => {
            const v31 = await ContractValidator.create(OAS31);
            expect(v31.checkResponse({ method: 'get', url: '/notes/a', status: 200, headers: JSON_HEADERS, data: { id: 'a', body: null } }).violations).toEqual([]);
            expect(v31.checkResponse({ method: 'get', url: '/notes/a', status: 200, headers: JSON_HEADERS, data: { id: 1 } }).violations).toEqual([
                { path: '$.id', message: 'must be string', expected: 'string', actual: 1 },
            ]);
        });
    });

    test.describe('helpers', () => {
        test('jsonPath', () => {
            expect(jsonPath('')).toBe('$');
            expect(jsonPath('/a/0/b~1c/d~0e')).toBe('$.a[0]["b/c"]["d~e"]');
        });

        test('normalizeDocument rewrites the OpenAPI 3.0 dialect and leaves the input alone', () => {
            const input = { openapi: '3.0.0', components: { schemas: { A: { type: 'integer', minimum: 1, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: false, nullable: true, enum: [1, 2] } } } };
            const out = normalizeDocument(input);
            expect(out.components.schemas.A).toEqual({ type: ['integer', 'null'], exclusiveMinimum: 1, maximum: 9, enum: [1, 2, null] });
            expect(input.components.schemas.A.exclusiveMinimum).toBe(true);
        });

        test('parseContractMode', () => {
            expect(parseContractMode('true')).toBe(true);
            expect(parseContractMode('WARN')).toBe('warn');
            expect(parseContractMode('off')).toBe(false);
            expect(parseContractMode('maybe')).toBeUndefined();
            expect(parseContractMode(undefined)).toBeUndefined();
        });

        test('PW_OPENAPI_VALIDATE_RESPONSES / _REQUESTS reach the config', () => {
            const saved = { ...process.env };
            try {
                process.env.PW_OPENAPI_SPEC_PATH = './spec.json';
                process.env.PW_OPENAPI_VALIDATE_RESPONSES = 'warn';
                process.env.PW_OPENAPI_VALIDATE_REQUESTS = 'true';
                const config = new ConfigLoader().load();
                expect(config.openapi?.validateResponses).toBe('warn');
                expect(config.openapi?.validateRequests).toBe(true);
            } finally {
                process.env = saved;
            }
        });
    });
});

// --- The fixture end to end, against a local server serving OAS30 ---

type Annotation = { type: string; description?: string };

function fakeTestInfo() {
    const annotations: Annotation[] = [];
    const attachments: Array<{ name: string; body: string }> = [];
    return {
        annotations,
        attachments,
        attach: async (name: string, o: { body: string }) => {
            attachments.push({ name, body: o.body });
        },
    };
}

async function withClient(config: Partial<OpenApiFixtureConfig>, baseUrl: string, fn: (c: OpenApiClient, info: ReturnType<typeof fakeTestInfo>) => Promise<void>) {
    const [fixtureFn] = openApiFixture.openApiClient as unknown as [
        (deps: { openapi: OpenApiFixtureConfig }, use: (c: OpenApiClient) => Promise<void>, testInfo: unknown) => Promise<void>,
    ];
    const info = fakeTestInfo();
    await fixtureFn({ openapi: { specPath: specFile, baseUrl, ...config } }, (c) => fn(c, info), info);
}

let specFile: string;

test.describe('openApiClient contract options', () => {
    let server: Server;
    let baseUrl: string;
    /** What GET /products/:id returns next. */
    let body: unknown = product;

    test.beforeAll(async () => {
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'contract-'));
        specFile = join(dir, 'spec.json');
        writeFileSync(specFile, JSON.stringify(OAS30));
        server = createServer((req, res) => {
            if (req.url?.startsWith('/products/') && req.method === 'GET') {
                if (req.url.endsWith('/broken')) {
                    res.writeHead(500, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ status: 500 }));
                    return;
                }
                if (req.url.endsWith('/missing')) {
                    res.writeHead(404, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ title: 'Not found' }));
                    return;
                }
                res.writeHead(200, JSON_HEADERS).end(JSON.stringify(body));
                return;
            }
            if (req.url === '/products' && req.method === 'POST') {
                res.writeHead(201, JSON_HEADERS).end(JSON.stringify(product));
                return;
            }
            res.writeHead(404).end();
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    test.afterAll(async () => {
        await new Promise((r) => server.close(r));
    });

    test.beforeEach(() => {
        body = product;
    });

    test('validateResponses: true passes conforming responses', async () => {
        await withClient({ validateResponses: true }, baseUrl, async ({ client }, info) => {
            const res = await (client as any).getProduct({ id: 1 });
            expect(res.data).toEqual(product);
            expect(info.annotations).toEqual([]);
        });
    });

    test('validateResponses: true fails the call with a ContractError and attaches the result', async () => {
        body = { ...product, price: 'free' };
        await withClient({ validateResponses: true }, baseUrl, async ({ client }, info) => {
            const error = await (client as any).getProduct({ id: 1 }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ContractError);
            expect((error as Error).message).toContain('  - $.price: must be number (expected number, got "free")');
            expect(info.annotations).toEqual([{ type: 'contract-violation', description: 'response getProduct: $.price: must be number (expected number, got "free")' }]);
            expect(info.attachments[0].name).toBe('contract response getProduct');
            expect(JSON.parse(info.attachments[0].body).violations).toHaveLength(1);
        });
    });

    test('non-2xx responses are checked too, and the Axios error is the cause', async () => {
        await withClient({ validateResponses: true }, baseUrl, async ({ client }) => {
            // 404 with a Problem body: documented through `default`, so the Axios error comes through.
            const notFound = await (client as any).getProduct({ id: 'missing' }).catch((e: any) => e);
            expect(notFound.isAxiosError).toBe(true);
            expect(notFound.response.status).toBe(404);

            // 500 whose Problem body lacks `title`: a ContractError, with the Axios error as its cause.
            const broken = await (client as any).getProduct({ id: 'broken' }).catch((e: any) => e);
            expect(broken).toBeInstanceOf(ContractError);
            expect(broken.status).toBe(500);
            expect(broken.message).toContain('$.title: is required');
            expect(broken.cause.isAxiosError).toBe(true);
        });
    });

    test("validateResponses: 'warn' records the mismatch and returns the response", async () => {
        body = { id: 1 };
        await withClient({ validateResponses: 'warn' }, baseUrl, async ({ client }, info) => {
            const res = await (client as any).getProduct({ id: 1 });
            expect(res.status).toBe(200);
            expect(info.annotations).toHaveLength(1);
            expect(info.annotations[0].type).toBe('contract-warning');
            expect(info.annotations[0].description).toContain('$.name: is required');
        });
    });

    test('validateRequests: true stops an invalid body before it is sent', async () => {
        await withClient({ validateRequests: true }, baseUrl, async ({ client }) => {
            const error = await (client as any).createProduct(null, { name: 'x' }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ContractError);
            expect((error as ContractError).kind).toBe('request');
            expect((error as Error).message).toMatch(/^The request body for createProduct \(POST \/products\)/);
            const ok = await (client as any).createProduct(null, { name: 'x', price: 2 });
            expect(ok.status).toBe(201);
            // A negative test sends a bad body on purpose: opt that call out.
            const sent = await (client as any).createProduct(null, { name: 'x' }, { contract: { request: false } });
            expect(sent.status).toBe(201);
        });
    });

    test('{ contract: false } skips both checks for one call', async () => {
        body = { id: 'nope' };
        await withClient({ validateResponses: true, validateRequests: true }, baseUrl, async ({ client }, info) => {
            const res = await (client as any).getProduct({ id: 1 }, null, { contract: false });
            expect(res.data).toEqual({ id: 'nope' });
            expect(info.annotations).toEqual([]);
            await expect((client as any).getProduct({ id: 1 }, null, { contract: { request: false } })).rejects.toThrow(ContractError);
        });
    });

    test('off by default; checkResponse and verifyMatchesSchema work anyway', async () => {
        body = { ...product, id: 'one' };
        await withClient({}, baseUrl, async (openApiClient, info) => {
            const res = await (openApiClient.client as any).getProduct({ id: 1 });
            expect(info.annotations).toEqual([]);
            const result = await openApiClient.checkResponse(res);
            expect(result.violations).toEqual([{ path: '$.id', message: 'must be integer', expected: 'integer', actual: 'one' }]);

            const steps = new OpenApiSteps(openApiClient);
            await expect(steps.verifyMatchesSchema(res)).rejects.toThrow(ContractError);
            await expect(steps.verifyMatchesSchema({ status: 200, data: {}, config: { url: '/nowhere' } })).rejects.toThrow(/no operation in the spec matches GET \/nowhere/);
            body = product;
            const good = await (openApiClient.client as any).getProduct({ id: 1 });
            await expect(steps.verifyMatchesSchema(good, 'getProduct')).resolves.toMatchObject({ violations: [] });
        });
    });
});
