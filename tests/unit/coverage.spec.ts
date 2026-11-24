/**
 * Unit tests for the coverage report (src/coverage/*, `propmaster coverage`
 * and the coverage_report MCP tool): the layer of each test, what it touches,
 * API operations and status codes against the spec, the test history, and
 * the code-coverage report parsers. Runs on a small project in a temp folder.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeTestFile, anyStatusesOf, anyTouchesOf, constantsOf, findTestFiles, kindFromPath, statusesOf, touchesOf } from '../../src/coverage/inventory';
import { findOtherTests, languageOf } from '../../src/coverage/languages';
import { findCoverageReports, formatOf, layerOfReport, parseClover, parseCobertura, parseCoveragePy, parseGoProfile, parseIstanbulSummary, parseJacoco, parseLcov, parseOpenCover, parseSimpleCov, readCoverageReport } from '../../src/coverage/code-coverage';
import { coverageReport, formatCoverageReport, pathMatcher } from '../../src/coverage/report';
import { runCoverage } from '../../src/cli/coverage';
import { testTools } from '../../src/mcp/test-tools';
import type { FrameworkConfig } from '../../src/config/schema';

const HEAD = `import { test, expect } from '@inluxc/propmaster';\n`;

const SPEC = {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
        '/orders': {
            get: { operationId: 'listOrders', tags: ['orders'], responses: { 200: { description: 'ok' }, 401: { description: 'no' } } },
            post: { operationId: 'createOrder', tags: ['orders'], responses: { 201: { description: 'ok' }, 400: { description: 'bad' } } },
        },
        '/orders/{id}': {
            get: { operationId: 'getOrder', tags: ['orders'], responses: { 200: { description: 'ok' }, 404: { description: 'missing' } } },
            delete: { operationId: 'deleteOrder', tags: ['orders'], responses: { 204: { description: 'gone' } } },
        },
    },
};

const FILES: Record<string, string> = {
    'tests/api/orders.spec.ts': `${HEAD}
test.describe('Orders', () => {
    test('[TC-API-001] lists orders', { tag: ['@TC-API-001'] }, async ({ openApiClient }) => {
        await test.step('Step 1: List', async () => {
            const res = await (openApiClient.client as any).listOrders();
            expect(res.status).toBe(200);
        });
    });
    test('[TC-API-002] creates an order', { tag: ['@TC-API-002'] }, async ({ openApiClient }) => {
        await test.step('Step 1: Create', async () => {
            const res = await (openApiClient.client as any).createOrder(null, { sku: 'a' });
            expect(res.status).toBe(201);
            const bad = await (openApiClient.client as any).createOrder(null, {}, { validateStatus: () => true });
            expect(bad.status).toBe(400);
        });
    });
    test.skip('[TC-API-003] reads one order', { tag: ['@TC-API-003'] }, async ({ openApiClient }) => {
        await test.step('Step 1: Read', async () => {
            const res = await (openApiClient.client as any).getOrder({ id: 1 });
            expect(res.status).toBe(200);
        });
    });
});
`,
    'tests/integration/orders-db.spec.ts': `${HEAD}
const TOPIC = 'order-events';
test('[TC-DB-001] an order row is stored', { tag: ['@TC-DB-001'] }, async ({ databaseClient, kafkaClient, testData }) => {
    await test.step('Step 1: Insert into the table', async () => {
        await databaseClient.insert('orders', { id: testData.unique('o') });
        const rows = await databaseClient.query('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [1]);
        expect(rows).toHaveLength(1);
        const queue = testData.unique('jobs');
        await kafkaClient.produce(TOPIC, [{ value: 'x' }]);
    });
});
`,
    'tests/e2e/checkout.spec.ts': `${HEAD}
test('[TC-BRW-001] checkout', { tag: ['@TC-BRW-001'] }, async ({ page, openApiClient }) => {
    await test.step('Step 1: Open the cart', async () => {
        await page.goto('/cart');
        await page.goto('/checkout');
    });
});
`,
    'tests/unit/price.spec.ts': `${HEAD}
test('[TC-UNI-001] rounds prices', { tag: ['@TC-UNI-001'] }, async () => {
    await test.step('Step 1: Round', async () => {
        expect(Math.round(1.5)).toBe(2);
    });
});
test('[TC-UNI-002] formats prices', { tag: ['@TC-UNI-002'] }, async () => {
    await test.step('Step 1: Format', async () => {
        expect((1).toFixed(2)).toBe('1.00');
    });
});
`,
    'src/money.test.ts': `import { describe, it, expect } from 'vitest';
describe('money', () => {
    it('adds', () => expect(1 + 1).toBe(2));
    it.skip('subtracts', () => expect(1 - 1).toBe(0));
});
`,
    'tests/support/pages.ts': 'export const x = 1;\n',
    'specs/shop.json': JSON.stringify(SPEC),
    'coverage/lcov.info': ['SF:/app/src/a.ts', 'FNF:2', 'FNH:1', 'LF:10', 'LH:8', 'BRF:4', 'BRH:2', 'end_of_record', 'SF:/app/src/b.ts', 'LF:30', 'LH:3', 'end_of_record', ''].join('\n'),
    'coverage/clover.xml': '<?xml version="1.0"?><coverage generated="1" clover="3.2.0"><project timestamp="1"></project></coverage>',
    'app/coverage/e2e/coverage-summary.json': JSON.stringify({ total: { lines: { total: 100, covered: 75 }, branches: { total: 10, covered: 5 } }, '/app/x.ts': { lines: { total: 100, covered: 75 } } }),
};

const HISTORY = {
    version: 1,
    runs: [
        {
            id: 'r1', startedAt: '2026-11-20T10:00:00.000Z', status: 'failed',
            tests: [
                { id: 'TC-API-001', title: '[TC-API-001] lists orders', file: 'api/orders.spec.ts', project: 'api', outcome: 'passed', retries: 0, duration: 5 },
                { id: 'TC-API-002', title: '[TC-API-002] creates an order', file: 'api/orders.spec.ts', project: 'api', outcome: 'failed', retries: 1, duration: 5 },
                { id: 'TC-UNI-001', title: '[TC-UNI-001] rounds prices', file: 'unit/price.spec.ts', project: 'unit', outcome: 'passed', retries: 0, duration: 1 },
            ],
        },
        {
            id: 'r2', startedAt: '2026-11-21T10:00:00.000Z', status: 'passed',
            tests: [
                { id: 'TC-API-001', title: '[TC-API-001] lists orders', file: 'api/orders.spec.ts', project: 'api', outcome: 'flaky', retries: 1, duration: 5 },
                { id: 'TC-API-002', title: '[TC-API-002] creates an order', file: 'api/orders.spec.ts', project: 'api', outcome: 'failed', retries: 1, duration: 5 },
            ],
        },
    ],
};

let root: string;
const CONFIG = { environment: 'local', openapi: { specPath: './specs/shop.json' }, database: { type: 'sqlite' }, redis: { host: 'localhost' } } as unknown as FrameworkConfig;

test.beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-coverage-'));
    for (const [file, content] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"shop-tests"}');
    fs.mkdirSync(path.join(root, '.propmaster'));
    fs.writeFileSync(path.join(root, '.propmaster/test-history.json'), JSON.stringify(HISTORY));
});

test.afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

test.describe('coverage — test inventory', () => {
    test('test files are found outside tests/ too; support files and build output are not', () => {
        expect(findTestFiles(root)).toEqual(['src/money.test.ts', 'tests/api/orders.spec.ts', 'tests/e2e/checkout.spec.ts', 'tests/integration/orders-db.spec.ts', 'tests/unit/price.spec.ts']);
    });

    test('layer from fixtures: helpers like testData say nothing, a browser wins over API fixtures, no fixtures is unit', () => {
        const kinds = (file: string) => analyzeTestFile(FILES[file], file).map((t) => `${t.kind}/${t.layer}`);
        expect(kinds('tests/api/orders.spec.ts')).toEqual(['api/integration', 'api/integration', 'api/integration']);
        expect(kinds('tests/integration/orders-db.spec.ts')).toEqual(['integration/integration']);
        expect(kinds('tests/e2e/checkout.spec.ts')).toEqual(['e2e/e2e']);
        expect(kinds('tests/unit/price.spec.ts')).toEqual(['unit/unit', 'unit/unit']);
        // Other runners' tests are unit tests, with it.skip as not active
        expect(analyzeTestFile(FILES['src/money.test.ts'], 'src/money.test.ts').map((t) => [t.title, t.runner, t.layer, t.state])).toEqual([
            ['adds', 'other', 'unit', 'active'],
            ['subtracts', 'other', 'unit', 'skip'],
        ]);
    });

    test('layer from the path when fixtures do not tell', () => {
        expect(kindFromPath('tests/e2e/login.spec.ts')).toBe('e2e');
        expect(kindFromPath('tests/foo.mobile.spec.ts')).toBe('mobile');
        expect(kindFromPath('tests/properties/x.prop.ts')).toBe('property');
        expect(kindFromPath('tests/integration/x.spec.ts')).toBe('integration');
        expect(kindFromPath('tests/x.spec.ts')).toBeNull();
    });

    test('touches: SQL tables (not step titles), client arguments through constants, routes, gRPC, GraphQL', () => {
        const [db] = analyzeTestFile(FILES['tests/integration/orders-db.spec.ts'], 'tests/integration/orders-db.spec.ts');
        expect(db.touches).toEqual([
            { kind: 'table', name: 'orders' },
            { kind: 'topic', name: 'order-events' },
            { kind: 'table', name: 'customers' },
        ]);
        const [e2e] = analyzeTestFile(FILES['tests/e2e/checkout.spec.ts'], 'tests/e2e/checkout.spec.ts');
        expect(e2e.touches).toEqual([{ kind: 'route', name: '/cart' }, { kind: 'route', name: '/checkout' }]);

        expect(touchesOf(`await grpcClient.call('orders.v1.Orders/Get', {}); await graphqlClient.query(\`query ListUsers { users { id } }\`);`, ['grpcClient', 'graphqlClient'])).toEqual([
            { kind: 'graphql', name: 'query ListUsers' },
            { kind: 'grpc', name: 'orders.v1.Orders/Get' },
        ]);
        expect(touchesOf("await cassandraClient.insert(`${ks}.orders`, row); await sqsClient.send(q, {})", ['cassandraClient', 'sqsClient'], undefined, new Map([['q', 'jobs']]))).toEqual([
            { kind: 'table', name: 'orders' },
            { kind: 'queue', name: 'jobs' },
        ]);
        expect(constantsOf("const a = 'x'; const b = testData.unique('jobs'); const c = `t-${id}`;")).toEqual(new Map([['a', 'x'], ['b', 'jobs']]));
    });

    test('operations: with a spec any call to an operationId counts; without one only calls on the client', () => {
        const body = "const r = await api.listOrders(); await (client as any).getOrder(1); await client.getOperations();";
        expect(touchesOf(body, ['openApiClient']).map((t) => t.name)).toEqual(['getOrder']);
        expect(touchesOf(body, ['openApiClient'], new Set(['listOrders', 'getOrder'])).map((t) => t.name)).toEqual(['listOrders', 'getOrder']);
        expect(statusesOf('expect(res.status).toBe(200); expect(bad.status).toBe(404); await expect(r).toHaveStatus(204); if (r.status === 500) {}')).toEqual([200, 204, 404, 500]);
    });
});

test.describe('coverage — code-coverage reports', () => {
    test('LCOV, Istanbul summary, Cobertura and JaCoCo totals', () => {
        const lcov = parseLcov(FILES['coverage/lcov.info']);
        expect(lcov.lines).toEqual({ covered: 11, total: 40, pct: 27.5 });
        expect(lcov.branches).toEqual({ covered: 2, total: 4, pct: 50 });
        expect(lcov.functions).toEqual({ covered: 1, total: 2, pct: 50 });
        expect(parseIstanbulSummary(FILES['app/coverage/e2e/coverage-summary.json']).lines.pct).toBe(75);

        const cobertura = parseCobertura(`<?xml version="1.0"?><coverage line-rate="0.5" lines-valid="4" lines-covered="2" branches-valid="0"><packages><package><classes>
            <class name="a" filename="app/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>
            <class name="b" filename="app/b.py"><lines><line number="1" hits="3"/><line number="2" hits="0"/></lines></class>
        </classes></package></packages></coverage>`);
        expect(cobertura.lines).toEqual({ covered: 2, total: 4, pct: 50 });
        expect(cobertura.files.map((f) => f.file)).toEqual(['app/a.py', 'app/b.py']);

        const jacoco = parseJacoco(`<report name="shop"><package name="com/shop"><sourcefile name="Order.java"><counter type="LINE" missed="5" covered="15"/></sourcefile>
            <counter type="LINE" missed="5" covered="15"/></package><counter type="LINE" missed="10" covered="30"/><counter type="BRANCH" missed="1" covered="3"/><counter type="METHOD" missed="0" covered="4"/></report>`);
        expect(jacoco.lines).toEqual({ covered: 30, total: 40, pct: 75 });
        expect(jacoco.branches?.pct).toBe(75);
        expect(jacoco.files).toEqual([{ file: 'com/shop/Order.java', lines: { covered: 15, total: 20, pct: 75 } }]);
    });

    test('reports are found in the project; the layer comes from the path; worst files first', () => {
        expect(findCoverageReports(root)).toEqual(['app/coverage/e2e/coverage-summary.json', 'coverage/lcov.info']);
        expect(layerOfReport('app/coverage/e2e/coverage-summary.json')).toBe('e2e');
        expect(layerOfReport('build/integration/lcov.info')).toBe('integration');
        expect(layerOfReport('coverage/lcov.info')).toBe('unit');
        const lcov = readCoverageReport(root, 'coverage/lcov.info');
        expect('error' in lcov ? lcov.error : lcov.lowest.map((f) => f.file)).toEqual(['/app/src/b.ts', '/app/src/a.ts']);
        expect(readCoverageReport(root, 'tests/support/pages.ts')).toMatchObject({ error: expect.stringContaining('not a coverage report') });
    });
});

test.describe('coverage — the report', () => {
    test('layers, API operations and statuses, history, backends and gaps', async () => {
        const r = await coverageReport({ root, config: CONFIG, tests: true });
        expect(r.totals).toEqual({ tests: 9, files: 5, byLayer: { unit: 4, integration: 4, e2e: 1 }, unclassified: 0 });

        const integration = r.layers.find((l) => l.layer === 'integration')!;
        expect(integration).toMatchObject({ tests: 4, files: 2, kinds: { api: 3, integration: 1 }, notActive: 1 });
        expect(integration.lastRun).toEqual({ at: '2026-11-21T10:00:00.000Z', passed: 0, flaky: 1, failed: 1, skipped: 0, notRun: 2 });
        // 4 runs of integration tests: passed, failed, flaky (a pass), failed
        expect(integration.passRate).toBe(0.5);
        expect(integration.touches.operation).toEqual({ listOrders: 1, createOrder: 1, getOrder: 1 });

        expect(r.api).toMatchObject({ operations: 4, tested: 3, operationPct: 75 });
        // documented: 200, 401, 201, 400, 200, 404, 204 = 7; asserted: listOrders 200, createOrder 201 + 400, getOrder 200 = 4
        expect(r.api!.statusPct).toBe(57.1);
        expect(r.api!.untested.map((o) => o.operationId)).toEqual(['deleteOrder']);
        expect(r.api!.partial.map((o) => `${o.operationId}: ${o.missing.join(',')}`)).toEqual(['listOrders: 401', 'getOrder: 404']);

        expect(r.backends).toEqual([
            { backend: 'openapi', configured: true, fixtures: ['openApiClient'], tests: 4 },
            { backend: 'database', configured: true, fixtures: ['databaseClient'], tests: 1 },
            { backend: 'kafka', configured: false, fixtures: ['kafkaClient'], tests: 1 },
            { backend: 'redis', configured: true, fixtures: ['redisClient'], tests: 0 },
        ]);

        const gaps = Object.fromEntries(r.gaps.map((g) => [g.kind, g]));
        expect(gaps['operation-untested'].items).toEqual(['deleteOrder DELETE /orders/{id}']);
        expect(gaps['error-paths-untested'].items).toEqual(['listOrders — documented 401', 'getOrder — documented 404']);
        expect(gaps['backend-untested'].items).toEqual(['redis (redisClient)']);
        expect(gaps['not-active'].items).toEqual(['src/money.test.ts:4 subtracts (skip)', 'TC-API-003 reads one order (skip)']);
        expect(gaps['failing'].items).toEqual(['TC-API-002 creates an order']);
        expect(gaps['never-run'].items).toEqual(['TC-BRW-001 checkout', 'TC-DB-001 an order row is stored', 'TC-UNI-002 formats prices']);
        expect(gaps['low-code-coverage'].message).toBe('coverage/lcov.info: 27.5% of lines covered (unit).');
        expect(gaps['empty-layer']).toBeUndefined();

        expect(r.codeCoverage.map((c) => ('error' in c ? c.error : `${c.layer} ${c.lines.pct}`))).toEqual(['e2e 75', 'unit 27.5']);
        expect(r.tests!.find((t) => t.id === 'TC-API-001')).toMatchObject({ recent: '✓~', statuses: [200] });
        expect(r.nextSteps.some((s) => s.includes('information_schema'))).toBe(true);
    });

    test('one layer; no spec; explicit report files', async () => {
        const r = await coverageReport({ root, config: CONFIG, layer: 'e2e', spec: false, reports: ['coverage/lcov.info'] });
        expect(r.layers.map((l) => l.layer)).toEqual(['e2e']);
        expect(r.layers[0].touches.route).toEqual({ '/cart': 1, '/checkout': 1 });
        expect(r.api).toBeUndefined();
        expect(r.codeCoverage).toHaveLength(1);
        // The unit report isn't this layer's
        expect(r.gaps.map((g) => g.kind)).toEqual(['never-run']);
        expect(r.nextSteps[0]).toContain('No OpenAPI spec');
    });

    test('an empty project: every layer is a gap, and the report says how to sharpen it', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-coverage-empty-'));
        try {
            const r = await coverageReport({ root: empty });
            expect(r.gaps.map((g) => `${g.kind}${g.layer ? `:${g.layer}` : ''}`)).toEqual(['empty-layer:unit', 'empty-layer:integration', 'empty-layer:e2e', 'no-code-coverage']);
            expect(r.nextSteps.some((s) => s.includes('No test history'))).toBe(true);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });

    test('text output and the CLI', async () => {
        const text = formatCoverageReport(await coverageReport({ root, config: CONFIG }));
        expect(text).toContain('Coverage: 9 tests in 5 files');
        expect(text).toMatch(/integration\s+4 tests \(api 3, integration 1\), 1 skipped\/fixme · last run 0✓ 1~ 1✗ 2 not run · pass rate 50%/);
        expect(text).toContain('3/4 operations tested (75%), 57.1% of documented status codes asserted');

        const out: string[] = [];
        expect(await runCoverage(['--root', root, '--json', '--layer', 'unit', '--no-spec'], (l) => out.push(l ?? ''))).toBe(0);
        expect(JSON.parse(out.join('\n')).layers).toMatchObject([{ layer: 'unit', tests: 4, kinds: { unit: 4 } }]);
        const errors: string[] = [];
        expect(await runCoverage(['--root', root, '--layer', 'smoke'], (l) => errors.push(l ?? ''))).toBe(2);
        expect(errors[0]).toContain('--layer must be one of unit, integration, e2e');
    });

    test('MCP tool: read-only, checks its arguments, keeps report paths inside the project', async () => {
        const tool = testTools({ root, environment: 'local', production: true, config: CONFIG }).find((t) => t.name === 'coverage_report')!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        const r = (await tool.handler({ layer: 'integration' })) as Awaited<ReturnType<typeof coverageReport>>;
        expect(r.api?.tested).toBe(3);
        expect(r.tests).toBeUndefined();
        await expect(tool.handler({ layer: 'smoke' })).rejects.toThrow('layer must be one of');
        await expect(tool.handler({ reports: ['../../etc/passwd'] })).rejects.toThrow('paths inside the project');
        await expect(tool.handler({ reports: ['/etc/passwd'] })).rejects.toThrow('paths inside the project');
    });
});

// ─── Any language ───────────────────────────────────────────────────────────

const POLYGLOT: Record<string, string> = {
    'app/tests/test_orders.py': `import pytest

def test_lists_orders(client):
    res = client.get("/v1/orders")
    assert res.status_code == 200

@pytest.mark.skip(reason="flaky")
def test_reads_order(client):
    res = client.get(f"/v1/orders/{order_id}")
    assert res.status_code == status.HTTP_404_NOT_FOUND

@pytest.mark.integration
async def test_stores_order(db):
    await db.execute("INSERT INTO orders (id) VALUES ($1)", 1)
`,
    'svc/orders_test.go': `//go:build integration

package orders

func TestCreateOrder(t *testing.T) {
    req := httptest.NewRequest(http.MethodPost, "/orders", body)
    if rec.Code != http.StatusCreated { t.Fatal() }
}

func helper(t *testing.T) {}
`,
    'api/src/test/java/shop/OrderControllerTest.java': `class OrderControllerTest {
    @Test
    void deletesAnOrder() throws Exception {
        mvc.perform(delete("/orders/" + id)).andExpect(status().isNoContent());
    }

    @Disabled
    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    public void rejectsBadIds(int id) {}
}
`,
    'api/src/test/java/shop/OrderFlowIT.java': `class OrderFlowIT {
    @Test
    void wholeFlow() {}
}
`,
    'web/Shop.Tests/OrderTests.cs': `public class OrderTests {
    [Fact]
    public async Task ListsOrders() { var res = await client.GetAsync("/orders"); Assert.Equal(HttpStatusCode.OK, res.StatusCode); }

    [Fact(Skip = "later")]
    public void Ignored() {}

    [Theory]
    [InlineData(1)]
    [Trait("Category", "Integration")]
    public void ReadsOrder(int id) {}
}
`,
    'spec/orders_spec.rb': `describe "orders" do
  it "lists orders" do
    get "/orders"
    expect(response).to have_http_status(:ok)
  end
  xit "is pending" do
  end
end
`,
    'tests/OrderTest.php': `<?php
class OrderTest extends TestCase {
    public function testListsOrders(): void { $this->get('/orders')->assertStatus(200); }
}
`,
    'crate/src/lib.rs': `pub fn add() {}
#[cfg(test)]
mod tests {
    #[test]
    fn adds() {}
    #[test]
    #[ignore]
    fn slow() {}
}
`,
    'crate/tests/api.rs': `#[tokio::test]
async fn serves_orders() {}
`,
    'crate/src/main.rs': 'fn main() {}\n',
};

test.describe('coverage — tests in any language', () => {
    test('test files by language; plain source files are not tests', () => {
        expect(languageOf('app/tests/test_orders.py')).toBe('python');
        expect(languageOf('app/orders.py')).toBeNull();
        expect(languageOf('svc/orders_test.go')).toBe('go');
        expect(languageOf('api/src/test/java/shop/OrderControllerTest.java')).toBe('java');
        expect(languageOf('api/src/test/kotlin/OrderSpec.kt')).toBe('kotlin');
        expect(languageOf('api/src/main/java/shop/Order.java')).toBeNull();
        expect(languageOf('web/Shop.Tests/OrderTests.cs')).toBe('csharp');
        expect(languageOf('spec/orders_spec.rb')).toBe('ruby');
        expect(languageOf('tests/OrderTest.php')).toBe('php');
        expect(languageOf('crate/src/lib.rs')).toBe('rust');
        expect(languageOf('ShopTests/OrderTests.swift')).toBe('swift');
        expect(languageOf('test/order_test.exs')).toBe('elixir');
    });

    test('declarations, skips and layers in each language', () => {
        const tests = (file: string) => analyzeTestFile(POLYGLOT[file], file).map((t) => `${t.title} ${t.layer} ${t.state}`);
        expect(tests('app/tests/test_orders.py')).toEqual(['test_lists_orders unit active', 'test_reads_order unit skip', 'test_stores_order integration active']);
        // A Go build tag makes the file integration; helper() isn't a test
        expect(tests('svc/orders_test.go')).toEqual(['TestCreateOrder integration active']);
        expect(tests('api/src/test/java/shop/OrderControllerTest.java')).toEqual(['deletesAnOrder unit active', 'rejectsBadIds unit skip']);
        // Maven's *IT convention
        expect(tests('api/src/test/java/shop/OrderFlowIT.java')).toEqual(['wholeFlow integration active']);
        expect(tests('web/Shop.Tests/OrderTests.cs')).toEqual(['ListsOrders unit active', 'Ignored unit skip', 'ReadsOrder integration active']);
        expect(tests('spec/orders_spec.rb')).toEqual(['lists orders unit active', 'is pending unit skip']);
        expect(tests('tests/OrderTest.php')).toEqual(['testListsOrders unit active']);
        expect(tests('crate/src/lib.rs')).toEqual(['adds unit active', 'slow unit skip']);
        // Rust's tests/ folder holds integration tests
        expect(tests('crate/tests/api.rs')).toEqual(['serves_orders integration active']);
        expect(analyzeTestFile(POLYGLOT['crate/src/main.rs'], 'crate/src/main.rs')).toEqual([]);
        expect(findOtherTests('test "adds" do\nend\n@tag :skip\ntest "later" do\nend', 'elixir').map((t) => [t.title, t.skipped])).toEqual([['adds', false], ['later', true]]);
    });

    test('HTTP calls, SQL and asserted statuses in any language, by number or by name', () => {
        const [list, read, store] = analyzeTestFile(POLYGLOT['app/tests/test_orders.py'], 'app/tests/test_orders.py');
        expect(list.touches).toEqual([{ kind: 'http', name: 'GET /v1/orders' }]);
        expect(read).toMatchObject({ touches: [{ kind: 'http', name: 'GET /v1/orders/{order_id}' }], statuses: [404] });
        expect(store.touches).toEqual([{ kind: 'table', name: 'orders' }]);
        expect(analyzeTestFile(POLYGLOT['svc/orders_test.go'], 'svc/orders_test.go')[0]).toMatchObject({ touches: [{ kind: 'http', name: 'POST /orders' }], statuses: [201] });
        expect(analyzeTestFile(POLYGLOT['api/src/test/java/shop/OrderControllerTest.java'], 'x/src/test/java/OrderControllerTest.java')[0]).toMatchObject({ touches: [{ kind: 'http', name: 'DELETE /orders/' }], statuses: [204] });
        expect(anyTouchesOf('await client.GetAsync("/orders?page=2")')).toEqual([{ kind: 'http', name: 'GET /orders' }]);
        expect(anyStatusesOf('expect(response).to have_http_status(:not_found)\n.expect(201)\nlet total = 300')).toEqual([201, 404]);
    });

    test('a call matches an operation by method and path template, with any base path', () => {
        const get = pathMatcher({ method: 'get', path: '/orders/{id}' });
        expect(get('GET /orders/42')).toBe('exact');
        expect(get('GET /v1/orders/${id}')).toBe('exact');
        expect(get('GET /orders/#{order.id}')).toBe('exact');
        expect(get('GET /orders/')).toBe('segment');
        expect(get('POST /orders/42')).toBe(false);
        expect(get('GET /orders/42/items')).toBe(false);
        expect(pathMatcher({ method: 'get', path: '/orders' })('GET /orders/')).toBe('exact');
    });

    test('the report: languages per layer, and API operations covered by tests in other languages', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-coverage-polyglot-'));
        try {
            for (const [file, content] of Object.entries({ ...POLYGLOT, 'specs/shop.json': JSON.stringify(SPEC) })) {
                fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
                fs.writeFileSync(path.join(dir, file), content);
            }
            const r = await coverageReport({ root: dir, spec: './specs/shop.json' });
            expect(r.totals).toMatchObject({ tests: 16, files: 9 });
            expect(r.layers.find((l) => l.layer === 'unit')!.languages).toEqual({ python: 2, java: 2, csharp: 2, ruby: 2, php: 1, rust: 2 });
            expect(r.layers.find((l) => l.layer === 'integration')!.languages).toEqual({ python: 1, go: 1, java: 1, csharp: 1, rust: 1 });
            // listOrders (Python, C#, Ruby, PHP), createOrder (Go), getOrder (Python), deleteOrder (Java, "/orders/" + id)
            expect(r.api).toMatchObject({ operations: 4, tested: 4, untested: [] });
            expect(r.api!.partial.map((o) => `${o.operationId}: ${o.missing.join(',')}`)).toEqual(['listOrders: 401', 'createOrder: 400', 'getOrder: 200']);
            // Tests outside Playwright aren't in its history, so they're never "never run"
            expect(r.gaps.map((g) => g.kind)).not.toContain('never-run');
            expect(formatCoverageReport(r)).toMatch(/in java 2, python 2, rust 2, ruby 2, csharp 2, php 1\n.*touches 4 HTTP calls/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test.describe('coverage — reports from other languages', () => {
    test('Go cover profile: statements, a block counted once across test binaries', () => {
        const go = parseGoProfile('mode: atomic\nshop/a.go:1.1,3.2 2 1\nshop/a.go:4.1,6.2 3 0\nshop/a.go:4.1,6.2 3 5\nshop/b.go:1.1,2.2 5 0\n');
        expect(go.measure).toBe('statements');
        expect(go.lines).toEqual({ covered: 5, total: 10, pct: 50 });
        expect(go.files).toEqual([{ file: 'shop/a.go', lines: { covered: 5, total: 5, pct: 100 } }, { file: 'shop/b.go', lines: { covered: 0, total: 5, pct: 0 } }]);
    });

    test('coverage.py JSON, Clover, OpenCover and SimpleCov', () => {
        const py = parseCoveragePy(JSON.stringify({ meta: { version: '7.6' }, files: { 'app/a.py': { summary: { covered_lines: 3, num_statements: 4 } } }, totals: { covered_lines: 3, num_statements: 4, num_branches: 2, covered_branches: 1 } }));
        expect(py).toMatchObject({ measure: 'statements', lines: { pct: 75 }, branches: { pct: 50 }, files: [{ file: 'app/a.py' }] });

        const clover = parseClover(`<coverage generated="1"><project timestamp="1"><file name="Order.php" path="/app/src/Order.php">
            <class name="Order"><metrics statements="99"/></class>
            <line num="3" type="method" count="1"/><line num="4" type="stmt" count="1"/><line num="5" type="stmt" count="0"/>
            <metrics loc="10" statements="2" coveredstatements="1"/></file></project></coverage>`);
        expect(clover).toMatchObject({ lines: { covered: 1, total: 2 }, functions: { covered: 1, total: 1 } });

        const opencover = parseOpenCover(`<CoverageSession><Summary numSequencePoints="4" visitedSequencePoints="3" numBranchPoints="2" visitedBranchPoints="1"/>
            <Modules><Module><Files><File uid="1" fullPath="C:\\src\\Order.cs"/></Files>
            <SequencePoint vc="1" fileid="1"/><SequencePoint vc="0" fileid="1"/></Module></Modules></CoverageSession>`);
        expect(opencover).toMatchObject({ lines: { covered: 3, total: 4, pct: 75 }, branches: { pct: 50 }, files: [{ file: 'C:\\src\\Order.cs', lines: { covered: 1, total: 2 } }] });

        const simplecov = parseSimpleCov(JSON.stringify({ RSpec: { coverage: { '/app/order.rb': { lines: [1, null, 0, 0] } } }, Minitest: { coverage: { '/app/order.rb': { lines: [0, null, 2, 0] } } } }));
        expect(simplecov.lines).toEqual({ covered: 2, total: 3, pct: 66.7 });
    });

    test('formats from the content when the name is generic; one report per folder', () => {
        expect(formatOf('coverage.out', 'mode: set\na.go:1.1,2.2 1 1')).toBe('go');
        expect(formatOf('coverage.out', 'something else')).toBeNull();
        expect(formatOf('coverage.json', '{"meta": {"version": "7.6"}, "files": {}, "totals": {}}')).toBe('coverage-py');
        expect(formatOf('coverage.json', '{"name": "x"}')).toBeNull();
        expect(formatOf('coverage.xml', '<coverage line-rate="0.5" version="7">')).toBe('cobertura');
        expect(formatOf('clover.xml', '<coverage generated="1" clover="3.2.0"><project>')).toBe('clover');
        expect(formatOf('x.opencover.xml', '<?xml?><CoverageSession>')).toBe('opencover');
        expect(formatOf('jacoco.xml', '<report name="x">')).toBe('jacoco');
        // coverage/ has lcov.info and clover.xml from the same run: lcov.info only
        expect(findCoverageReports(root)).toEqual(['app/coverage/e2e/coverage-summary.json', 'coverage/lcov.info']);
    });
});
