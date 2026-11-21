/**
 * Unit tests for `propmaster generate openapi` (src/openapi/generate.ts and
 * src/cli/generate.ts).
 *
 * Generated tests use the fictional `ZZ` category so the IDs never collide
 * with real ones. CI also generates tests from the Petstore spec and runs them
 * against Prism (integration-tests.yml → test-openapi).
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSources, nextIds } from '../../src/cli/check-tests';
import { generateOpenApiTests, parseGenerateArgs, type GenerateCliOptions } from '../../src/cli/generate';
import { coveredOperations, exampleFor, generateApiTests, tagFileName, type GenerateOptions } from '../../src/openapi/generate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Sequential ZZ IDs, like next-id on an empty project. */
function allocator(start = 0) {
    let used = start;
    return (n: number) => Array.from({ length: n }, () => `TC-ZZ-${String(++used).padStart(3, '0')}`);
}

const SHOP = {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '2.1' },
    security: [{ bearer: [] }],
    components: {
        securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
        schemas: {
            Product: {
                type: 'object',
                required: ['name', 'price'],
                properties: {
                    id: { type: 'integer', readOnly: true },
                    name: { type: 'string', example: 'Teapot' },
                    price: { type: 'number', minimum: 0.5 },
                    sku: { type: 'string', minLength: 12 },
                    status: { type: 'string', enum: ['draft', 'live'] },
                    category: { $ref: '#/components/schemas/Category' },
                    tags: { type: 'array', items: { type: 'string' } },
                },
            },
            Category: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, parent: { $ref: '#/components/schemas/Category' } },
            },
            Problem: { type: 'object', properties: { title: { type: 'string' } } },
        },
        parameters: {
            ProductId: { name: 'id', in: 'path', required: true, schema: { type: 'integer', format: 'int64' } },
        },
    },
    paths: {
        '/products': {
            get: {
                operationId: 'listProducts',
                tags: ['Catalog'],
                parameters: [
                    { name: 'status', in: 'query', required: true, schema: { type: 'array', items: { type: 'string', enum: ['live', 'draft'] } } },
                    { name: 'page', in: 'query', schema: { type: 'integer' } },
                ],
                responses: {
                    200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } },
                    401: { description: 'no auth' },
                },
            },
            post: {
                operationId: 'createProduct',
                tags: ['Catalog'],
                requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
                responses: {
                    201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
                    400: { description: 'bad', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
                    default: { description: 'error' },
                },
            },
        },
        '/products/{id}': {
            parameters: [{ $ref: '#/components/parameters/ProductId' }],
            get: {
                operationId: 'getProduct',
                tags: ['Catalog'],
                security: [{ apiKey: [] }],
                responses: { 200: { description: 'ok' }, 404: { description: 'missing' } },
            },
        },
        '/slots/{slot}': {
            get: {
                operationId: 'getSlot',
                tags: ['Store Front'],
                security: [{}],
                parameters: [{ name: 'slot', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 10 } }],
                responses: { '2XX': { description: 'ok' }, 404: { description: 'missing' } },
            },
        },
        '/uploads': {
            post: {
                operationId: 'upload',
                tags: ['Store Front'],
                requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
                responses: { 200: { description: 'ok' } },
            },
        },
        '/health': {
            get: { tags: ['Ops'], responses: { 200: { description: 'ok' } } },
        },
        '/ping': {
            get: { operationId: 'ping', tags: ['Ops'], responses: { default: { description: 'pong' } } },
        },
    },
};

const SWAGGER2 = {
    swagger: '2.0',
    info: { title: 'Pets', version: '1' },
    securityDefinitions: { api_key: { type: 'apiKey', in: 'header', name: 'api_key' } },
    paths: {
        '/pet': {
            post: {
                operationId: 'addPet',
                tags: ['pet'],
                consumes: ['application/json'],
                parameters: [{ in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
                responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } }, 405: { description: 'invalid' } },
            },
        },
        '/pet/{petId}': {
            get: {
                operationId: 'getPetById',
                tags: ['pet'],
                security: [{ api_key: [] }],
                parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer', format: 'int64' }],
                responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } }, 404: { description: 'missing' } },
            },
            post: {
                operationId: 'updatePetWithForm',
                tags: ['pet'],
                consumes: ['application/x-www-form-urlencoded'],
                parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer' }, { name: 'name', in: 'formData', type: 'string' }],
                responses: { 405: { description: 'invalid' } },
            },
        },
    },
    definitions: {
        Pet: { type: 'object', required: ['name'], properties: { id: { type: 'integer' }, name: { type: 'string', example: 'doggie' } } },
    },
};

const run = (doc: object, options: Partial<GenerateOptions> = {}) =>
    generateApiTests(doc as Record<string, unknown>, { allocateIds: allocator(), category: 'ZZ', ...options });

const testsOf = (doc: object, options?: Partial<GenerateOptions>) =>
    run(doc, options).files.flatMap((f) => f.tests.map((t) => `${t.id} ${t.operationId} ${t.status} ${t.kind}`));

// ─── Example values ─────────────────────────────────────────────────────────

test.describe('generate — example values', () => {
    const doc = SHOP as unknown as Record<string, unknown>;

    test('uses examples, enums, minimums and formats; leaves out readOnly; stops at recursion', () => {
        expect(exampleFor(doc, { $ref: '#/components/schemas/Product' })).toEqual({
            name: 'Teapot',
            price: 0.5,
            sku: 'example skux',
            status: 'draft',
            category: { name: 'example name' },
            tags: ['example tags'],
        });
    });

    test('formats, defaults, const, allOf, oneOf and 3.1 type arrays', () => {
        expect(exampleFor(doc, { type: 'string', format: 'email' })).toBe('user@example.test');
        expect(exampleFor(doc, { type: 'string', format: 'date-time' })).toBe('2024-01-15T10:30:00Z');
        expect(exampleFor(doc, { type: 'string', format: 'uuid' })).toMatch(/^[0-9a-f-]{36}$/);
        expect(exampleFor(doc, { type: 'integer', default: 7 })).toBe(7);
        expect(exampleFor(doc, { const: 'fixed' })).toBe('fixed');
        expect(exampleFor(doc, { type: 'integer', exclusiveMinimum: 4 })).toBe(5);
        expect(exampleFor(doc, { type: ['null', 'boolean'] })).toBe(true);
        expect(exampleFor(doc, { type: 'string', maxLength: 3 })).toBe('exa');
        expect(exampleFor(doc, { examples: ['first', 'second'] })).toBe('first');
        expect(exampleFor(doc, { allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }, { type: 'object', properties: { b: { type: 'boolean' } } }] })).toEqual({ a: 1, b: true });
        expect(exampleFor(doc, { oneOf: [{ type: 'string', example: 'one' }, { type: 'integer' }] })).toBe('one');
    });

    test('tag file names', () => {
        expect(tagFileName('Store Front')).toBe('store-front');
        expect(tagFileName('userAccounts')).toBe('user-accounts');
        expect(tagFileName('***')).toBe('default');
    });
});

// ─── Planning ───────────────────────────────────────────────────────────────

test.describe('generate — which tests are written', () => {
    test('a test per operation and status; runnable where the generator can provoke the status', () => {
        expect(testsOf(SHOP)).toEqual([
            'TC-ZZ-001 listProducts 200 success',
            'TC-ZZ-002 listProducts 401 fixme',
            'TC-ZZ-003 createProduct 201 success',
            'TC-ZZ-004 createProduct 400 invalid-body',
            'TC-ZZ-005 getProduct 200 success',
            'TC-ZZ-006 getProduct 404 not-found',
            // slot is limited to 1–10: no value is sure to be missing
            'TC-ZZ-007 getSlot 2XX success',
            'TC-ZZ-008 getSlot 404 fixme',
            // multipart bodies need a hand-written request
            'TC-ZZ-009 upload 200 fixme',
        ]);
    });

    test('skips operations it cannot test, saying why', () => {
        expect(run(SHOP).skipped).toEqual([
            { operation: 'GET /health', reason: 'it has no operationId, so openApiClient.client has no method for it' },
            { operation: 'ping (GET /ping)', reason: 'it only documents a default response, so there is no status to assert' },
        ]);
    });

    test('with prism, every numeric status runs through Prefer: code=', () => {
        expect(testsOf(SHOP, { prism: true }).filter((t) => t.includes('fixme'))).toEqual(['TC-ZZ-009 upload 200 fixme']);
        const content = run(SHOP, { prism: true }).files[0].content;
        expect(content).toContain("headers: { Authorization: 'Bearer example-token', Prefer: 'code=401' }");
    });

    test('filters by tag (case-insensitive) and operationId, and reports unknown operationIds', () => {
        expect(run(SHOP, { tags: ['store front'] }).files.map((f) => f.fileName)).toEqual(['store-front.spec.ts']);
        const byOp = run(SHOP, { operations: ['getProduct', 'nope'] });
        expect(byOp.files.flatMap((f) => f.tests.map((t) => `${t.operationId} ${t.status}`))).toEqual(['getProduct 200', 'getProduct 404']);
        expect(byOp.skipped).toEqual([{ operation: 'nope', reason: 'no operation with this operationId in the spec' }]);
    });

    test('skips operation/status pairs that already have a test, and never reuses a file name', () => {
        const result = run(SHOP, {
            existing: coveredOperations([`annotation: { type: 'openapi', description: 'listProducts 200' }`, `{ type: "openapi", description: "getSlot 2XX" }`]),
            takenFiles: new Set(['catalog.spec.ts', 'catalog-2.spec.ts']),
        });
        expect(result.alreadyCovered).toEqual(['listProducts 200', 'getSlot 2XX']);
        expect(result.files.map((f) => f.fileName)).toEqual(['catalog-3.spec.ts', 'store-front.spec.ts']);
        expect(result.files[0].tests[0]).toMatchObject({ id: 'TC-ZZ-001', operationId: 'listProducts', status: '401' });
    });

    test('IDs come from the allocator, in order across files', () => {
        const ids = run(SHOP, { allocateIds: (n) => nextIds('ZZ', [{ id: 'TC-ZZ-041', category: 'ZZ', num: 41, file: 'x', line: 1 }], n) })
            .files.flatMap((f) => f.tests.map((t) => t.id));
        expect(ids[0]).toBe('TC-ZZ-042');
        expect(ids.at(-1)).toBe('TC-ZZ-050');
    });

    test('Swagger 2: body parameters, formData operations, type on the parameter', () => {
        expect(testsOf(SWAGGER2)).toEqual([
            'TC-ZZ-001 addPet 200 success',
            'TC-ZZ-002 addPet 405 fixme',
            'TC-ZZ-003 getPetById 200 success',
            'TC-ZZ-004 getPetById 404 not-found',
            'TC-ZZ-005 updatePetWithForm 405 fixme',
        ]);
    });
});

// ─── Generated code ─────────────────────────────────────────────────────────

test.describe('generate — the generated code', () => {
    const files = run(SHOP).files;
    const catalog = files.find((f) => f.fileName === 'catalog.spec.ts')!.content;

    test('passes propmaster check', () => {
        for (const doc of [SHOP, SWAGGER2]) {
            for (const prism of [false, true]) {
                const sources = run(doc, { prism }).files.map((f) => ({ file: `tests/api/${f.fileName}`, content: f.content, kind: 'test' as const }));
                expect(checkSources(sources).violations).toEqual([]);
            }
        }
    });

    test('has the ID in title and tag, the operationId annotation, and step blocks', () => {
        expect(catalog).toContain(`import { test, expect } from '@inluxc/propmaster';`);
        expect(catalog).toContain(`test.describe('Catalog', () => {`);
        expect(catalog).toContain(`test('[TC-ZZ-001] listProducts: GET /products returns 200', {
        tag: ['@TC-ZZ-001'],
        annotation: { type: 'openapi', description: 'listProducts 200' },
    }, async ({ openApiClient }) => {`);
        expect(catalog).toContain(`await test.step('Step 1: Send GET /products', async () => {`);
        expect(catalog).toContain(`await test.step('Step 2: Verify the response status is 200', async () => {`);
    });

    test('builds requests from the schema: required params only, one value for array queries, a body without readOnly fields', () => {
        expect(catalog).toContain(`response = await client.listProducts({
                status: 'live'
            }, undefined, { validateStatus: () => true });`);
        expect(catalog).toContain(`response = await client.createProduct(null, {
                name: 'Teapot',`);
        expect(catalog).not.toMatch(/createProduct\(null, \{\s+id:/);
    });

    test('expected failures: an empty body without the request check, an unknown path id', () => {
        expect(catalog).toContain(`response = await client.createProduct(null, {}, { validateStatus: () => true, contract: { request: false } });`);
        expect(catalog).toContain(`response = await client.getProduct({
                id: 999999999
            }, undefined, { validateStatus: () => true });`);
        expect(catalog).toContain("returns 400 for a body without its required fields");
        expect(catalog).toContain("returns 404 for an unknown id");
    });

    test('statuses it cannot provoke are test.fixme with a TODO', () => {
        expect(catalog).toContain(`    // TODO: make the API answer 401 (for example with data or credentials that cause it), then change test.fixme to test.
    test.fixme('[TC-ZZ-002] listProducts: GET /products returns 401', {`);
        const storeFront = files.find((f) => f.fileName === 'store-front.spec.ts')!.content;
        expect(storeFront).toContain('// TODO: send a multipart/form-data body, which needs a hand-written request');
    });

    test('a response-schema step only where the response has a JSON schema', () => {
        expect(catalog.match(/checkResponse\(response, '(\w+)'\)/g)).toEqual([
            "checkResponse(response, 'listProducts')",
            "checkResponse(response, 'createProduct')",
            "checkResponse(response, 'createProduct')",
        ]);
        expect(run(SHOP, { contract: false }).files[0].content).not.toContain('checkResponse');
    });

    test('2XX ranges assert the range; credentials needed are named in a comment', () => {
        const storeFront = files.find((f) => f.fileName === 'store-front.spec.ts')!.content;
        expect(storeFront).toContain('expect(response.status).toBeGreaterThanOrEqual(200);');
        expect(storeFront).toContain('expect(response.status).toBeLessThan(300);');
        expect(catalog).toContain('// Needs credentials: apiKey (apiKey in header).');
        // getSlot has security: [{}] (optional); upload inherits the global bearer requirement
        expect(storeFront.match(/Needs credentials: \w+/g)).toEqual(['Needs credentials: bearer']);
        expect(storeFront.indexOf('Needs credentials')).toBeGreaterThan(storeFront.indexOf("'[TC-ZZ-008]"));
    });

    test('typechecks', () => {
        test.setTimeout(60_000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-gen-'));
        const importFrom = path.join(REPO_ROOT, 'src/index.ts');
        const sources = [
            ...run(SHOP, { importFrom }).files,
            ...run(SWAGGER2, { importFrom, prism: true, allocateIds: allocator(100) }).files.map((f) => ({ ...f, fileName: `v2-${f.fileName}` })),
        ];
        for (const f of sources) fs.writeFileSync(path.join(dir, f.fileName), f.content);
        const tsc = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsc'), [
            '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'esnext',
            '--moduleResolution', 'bundler', '--allowImportingTsExtensions', '--types', 'node',
            ...sources.map((f) => path.join(dir, f.fileName)),
        ], { cwd: REPO_ROOT, encoding: 'utf8' });
        expect(tsc.stdout + tsc.stderr).toBe('');
        expect(tsc.status).toBe(0);
    });
});

// ─── CLI ────────────────────────────────────────────────────────────────────

test.describe('generate — CLI', () => {
    test('parses options', () => {
        expect(parseGenerateArgs(['openapi', '--tag', 'pet,store', '--tag=user', '--operation', 'getPetById', '--prism', '--no-contract', '--dry-run', '--category', 'pet', '--root', 'proj'], '/base')).toEqual({
            root: path.resolve('/base/proj'), tags: ['pet', 'store', 'user'], operations: ['getPetById'], out: 'tests/api',
            category: 'PET', prism: true, contract: false, importFrom: '@inluxc/propmaster', dryRun: true,
        });
        expect(parseGenerateArgs([])).toEqual({ help: true });
        expect(parseGenerateArgs(['graphql'])).toEqual({ error: 'Unknown generator "graphql". Available: openapi' });
        expect(parseGenerateArgs(['openapi', '--wat'])).toEqual({ error: 'Unknown option: --wat' });
        expect(parseGenerateArgs(['openapi', '--category', '1x'])).toMatchObject({ error: expect.stringContaining('--category') });
    });

    function project(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-gen-cli-'));
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sample"}');
        fs.writeFileSync(path.join(root, 'shop.json'), JSON.stringify(SHOP));
        fs.writeFileSync(path.join(root, 'environments.json'), JSON.stringify({ environments: { local: { openapi: { specPath: './shop.json', baseUrl: 'http://localhost:4010' } } } }));
        fs.mkdirSync(path.join(root, 'tests'));
        fs.writeFileSync(path.join(root, 'tests/old.spec.ts'), `import { test } from '@inluxc/propmaster';
test('[TC-ZZ-004] existing', { tag: ['@TC-ZZ-004'] }, async () => { await test.step('Step 1: x', async () => {}); });
`);
        return root;
    }
    const opts = (root: string, extra: Partial<GenerateCliOptions> = {}): GenerateCliOptions => ({
        root, tags: [], operations: [], out: 'tests/api', category: 'ZZ', prism: false, importFrom: '@inluxc/propmaster', dryRun: false, ...extra,
    });

    test('writes files with IDs after the ones in use, then adds only what is new, never overwriting', async () => {
        const root = project();
        const first = await generateOpenApiTests(opts(root));
        expect(first.written.map((f) => path.relative(root, f))).toEqual(['tests/api/catalog.spec.ts', 'tests/api/store-front.spec.ts']);
        expect(first.result.files[0].tests[0].id).toBe('TC-ZZ-005');
        const catalogBefore = fs.readFileSync(path.join(root, 'tests/api/catalog.spec.ts'), 'utf8');

        // Nothing new: everything is covered
        const again = await generateOpenApiTests(opts(root));
        expect(again.written).toEqual([]);
        expect(again.result.alreadyCovered).toHaveLength(9);

        // A new operation in the spec goes into a new file
        const spec = structuredClone(SHOP) as typeof SHOP & { paths: Record<string, unknown> };
        spec.paths['/products/{id}/archive'] = { post: { operationId: 'archiveProduct', tags: ['Catalog'], parameters: [{ $ref: '#/components/parameters/ProductId' }], responses: { 204: { description: 'done' } } } };
        fs.writeFileSync(path.join(root, 'shop.json'), JSON.stringify(spec));
        const third = await generateOpenApiTests(opts(root));
        expect(third.written.map((f) => path.basename(f))).toEqual(['catalog-2.spec.ts']);
        expect(third.result.files[0].tests).toEqual([expect.objectContaining({ operationId: 'archiveProduct', status: '204', id: 'TC-ZZ-014' })]);
        expect(fs.readFileSync(path.join(root, 'tests/api/catalog.spec.ts'), 'utf8')).toBe(catalogBefore);
    });

    test('--dry-run writes nothing', async () => {
        const root = project();
        const dry = await generateOpenApiTests(opts(root, { dryRun: true }));
        expect(dry.result.files).toHaveLength(2);
        expect(dry.written).toEqual([]);
        expect(fs.existsSync(path.join(root, 'tests/api'))).toBe(false);
    });

    test('contract steps only when ajv is installed in the project, unless forced', async () => {
        const root = project(); // no node_modules
        const auto = await generateOpenApiTests(opts(root, { dryRun: true }));
        expect(auto.contract).toBe(false);
        expect(auto.contractNote).toContain('npm install --save-dev ajv ajv-formats');
        expect(auto.result.files[0].content).not.toContain('checkResponse');
        const forced = await generateOpenApiTests(opts(root, { dryRun: true, contract: true }));
        expect(forced.result.files[0].content).toContain('checkResponse');
    });

    test('a missing or invalid spec is a clear error', async () => {
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-gen-bare-'));
        fs.writeFileSync(path.join(bare, 'package.json'), '{}');
        await expect(generateOpenApiTests(opts(bare))).rejects.toThrow('No OpenAPI spec: pass --spec');
        fs.writeFileSync(path.join(bare, 'x.json'), '{"hello":1}');
        await expect(generateOpenApiTests(opts(bare, { spec: 'x.json' }))).rejects.toThrow("isn't an OpenAPI document");
    });
});
