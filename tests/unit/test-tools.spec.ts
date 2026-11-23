/**
 * Unit tests for the test-loop MCP tools (src/mcp/test-tools.ts): run_tests
 * against a real, nested Playwright run, last_failures and `propmaster
 * failures` reading the last-run file the reporter writes, flaky_tests and
 * generate_api_tests.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestStep } from '@playwright/test/reporter';
import { playwrightArgs, testTools, type RunTestsResult } from '../../src/mcp/test-tools';
import { failedStepOf, formatLastRun, plain, readLastRun } from '../../src/reporter/last-run';
import { appendRun, readHistory } from '../../src/reporter/history';
import { runFailures } from '../../src/cli/failures';
import type { ToolDefinition } from '../../src/mcp/protocol';

const REPO = path.resolve(import.meta.dirname, '../..');

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

const step = (title: string, category: string, error?: boolean, steps: TestStep[] = []): TestStep =>
    ({ title, category, error: error ? { message: 'x' } : undefined, steps }) as unknown as TestStep;

test.describe('last-run file — pieces', () => {
    test('the failed step is the innermost failed test.step, with its parents; other steps are left out', () => {
        const steps = [
            step('Step 1: Create the order', 'test.step'),
            step('Step 2: Check the order', 'test.step', true, [
                step('Step 2.1: Read it back', 'test.step', true, [step('expect.toBe', 'expect', true)]),
            ]),
        ];
        expect(failedStepOf(steps)).toBe('Step 2: Check the order › Step 2.1: Read it back');
        // A failure outside any test.step (a hook, a bare expect) has no step
        expect(failedStepOf([step('beforeEach hook', 'hook', true, [step('expect.toBe', 'expect', true)])])).toBeUndefined();
        expect(failedStepOf([step('Step 1', 'test.step')])).toBeUndefined();
    });

    test('colours are stripped from error text', () => {
        expect(plain('\u001b[31mExpected\u001b[39m: 2')).toBe('Expected: 2');
    });

    test('playwright arguments: ids become one grep; bad arguments are refused', () => {
        const args = playwrightArgs({ ids: ['TC-API-001', 'TC-API-012'], files: ['tests/api'], projects: ['api'], retries: 0, timeout: 60 }, '/r.js');
        expect(args).toEqual([
            'test', 'tests/api', '--grep=(TC-API-001(?!\\d)|TC-API-012(?!\\d))', '--project=api', '--retries=0', '--global-timeout=60000', '--reporter=dot,/r.js',
        ]);
        const grep = new RegExp(args[2].slice('--grep='.length));
        expect(grep.test('[TC-API-001] lists orders @TC-API-001')).toBe(true);
        expect(grep.test('[TC-API-0011] other')).toBe(false);
        expect(() => playwrightArgs({ ids: ['API-1'] }, 'r')).toThrow('Not TestCaseIDs: API-1');
        expect(() => playwrightArgs({ ids: ['TC-API-001'], grep: 'x' }, 'r')).toThrow('ids or grep, not both');
        expect(() => playwrightArgs({ files: ['--config=/etc/x'] }, 'r')).toThrow('files must be test file paths');
    });
});

const CONFIG = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: '.',
    outputDir: './test-output',
    retries: 1,
    use: { trace: 'retain-on-failure' },
    reporter: [['line']],
    projects: [{ name: 'unit' }],
});
`;

const SPEC = `
import { test, expect } from '@playwright/test';

test('[TC-XY-001] passes', { tag: ['@TC-XY-001'] }, async () => {
    await test.step('Step 1: Do nothing', async () => {});
});

test('[TC-XY-002] fails in a step', { tag: ['@TC-XY-002'] }, async () => {
    await test.step('Step 1: Build the order', async () => {});
    await test.step('Step 2: Check the total', async () => {
        expect(1 + 1).toBe(3);
    });
});

test('[TC-XY-003] passes on the retry', { tag: ['@TC-XY-003'] }, async ({}, testInfo) => {
    await test.step('Step 1: Flip a coin', async () => {
        expect(testInfo.retry).toBe(1);
    });
});
`;

test.describe('run_tests and last_failures — real Playwright runs', () => {
    test.describe.configure({ mode: 'serial' });
    let root: string;
    let tools: ToolDefinition[];

    test.beforeAll(() => {
        root = path.join(REPO, '.propmaster', `test-tools-${process.pid}`);
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'nested', private: true, type: 'module' }));
        fs.writeFileSync(path.join(root, 'playwright.config.ts'), CONFIG);
        fs.writeFileSync(path.join(root, 'orders.spec.ts'), SPEC);
        tools = testTools({ root, environment: 'local', production: false });
    });
    test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    test('a run returns each failure with its step, error and code, and the flaky tests; no history by default', async () => {
        const result = (await tool(tools, 'run_tests').handler({ files: ['orders.spec.ts'], timeout: 120 })) as RunTestsResult;
        expect(result).toMatchObject({ ok: false, status: 'failed', exitCode: 1, counts: { total: 3, passed: 1, failed: 1, flaky: 1, skipped: 0 }, errors: [] });
        expect(result.failures).toHaveLength(1);
        const [failure] = result.failures;
        expect(failure).toMatchObject({ id: 'TC-XY-002', location: 'orders.spec.ts:8', project: 'unit', outcome: 'failed', retries: 1, failedStep: 'Step 2: Check the total' });
        expect(failure.errors[0].message).toContain('Expected: 3');
        expect(failure.errors[0].message).not.toContain('\u001b[');
        expect(failure.errors[0].location).toBe('orders.spec.ts:11:23');
        expect(failure.errors[0].snippet).toContain('expect(1 + 1).toBe(3)');
        expect(failure.attachments?.find((a) => a.name === 'trace')?.path).toMatch(/^test-output\/.+\/trace\.zip$/);
        expect(result.flaky).toEqual([{ id: 'TC-XY-003', title: '[TC-XY-003] passes on the retry', location: 'orders.spec.ts:15', project: 'unit', failedStep: 'Step 1: Flip a coin' }]);
        expect(result.command).toBe('npx playwright test orders.spec.ts');
        // Runs while writing a test aren't flakes
        expect(fs.existsSync(path.join(root, '.propmaster', 'test-history.json'))).toBe(false);
    });

    test('last_failures reads the same run back, and propmaster failures prints it', async () => {
        const result = (await tool(tools, 'last_failures').handler({})) as { source: string; failures: Array<{ id: string; failedStep: string }>; flaky: Array<{ id: string }> };
        expect(result.source).toBe('last-run');
        expect(result.failures.map((f) => [f.id, f.failedStep])).toEqual([['TC-XY-002', 'Step 2: Check the total']]);
        expect(result.flaky.map((f) => f.id)).toEqual(['TC-XY-003']);
        expect(((await tool(tools, 'last_failures').handler({ flaky: false })) as { flaky: unknown[] }).flaky).toEqual([]);

        const lines: string[] = [];
        expect(runFailures(['--root', root], (l = '') => lines.push(l))).toBe(0);
        const out = lines.join('\n');
        expect(out).toMatch(/Last run .*: failed\. 1 passed, 1 failed, 1 flaky, 0 skipped\./);
        expect(out).toContain('✗ failed  [TC-XY-002] fails in a step  (unit, orders.spec.ts:8)');
        expect(out).toContain('  in step: Step 2: Check the total');
        expect(out).toContain('  at orders.spec.ts:11:23');
        expect(out).toMatch(/trace: npx playwright show-trace test-output\/.+\/trace\.zip/);
    });

    test('by TestCaseID, with history: only that test runs, and the run is in the test history', async () => {
        const result = (await tool(tools, 'run_tests').handler({ ids: ['TC-XY-001'], history: true })) as RunTestsResult;
        expect(result).toMatchObject({ ok: true, status: 'passed', exitCode: 0, counts: { total: 1, passed: 1 }, failures: [], flaky: [] });
        expect(result.output).toBeUndefined();
        expect(readHistory(path.join(root, '.propmaster', 'test-history.json')).runs[0].tests.map((t) => t.id)).toEqual(['TC-XY-001']);
        // The last run is now this one
        expect(readLastRun(path.join(root, '.propmaster', 'last-run.json'))?.counts.total).toBe(1);
    });

    test("no matching test: Playwright's own error comes back", async () => {
        const result = (await tool(tools, 'run_tests').handler({ grep: 'nothing-is-called-this' })) as RunTestsResult;
        expect(result.ok).toBe(false);
        expect(`${result.errors.join('\n')}\n${result.output}`).toContain('No tests found');
    });

    test('last_failures adds the recent history of each failing test', async () => {
        const history = path.join(root, '.propmaster', 'test-history.json');
        const t = { title: '[TC-XY-002] fails in a step', file: 'orders.spec.ts', project: 'unit', retries: 0, duration: 1 };
        appendRun(history, { id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'passed', tests: [{ ...t, id: 'TC-XY-002', outcome: 'passed' }] });
        appendRun(history, { id: 'r2', startedAt: '2026-01-02T00:00:00Z', status: 'failed', tests: [{ ...t, id: 'TC-XY-002', outcome: 'failed' }] });
        await tool(tools, 'run_tests').handler({ ids: ['TC-XY-002'], retries: 0 });
        const result = (await tool(tools, 'last_failures').handler({})) as { failures: Array<{ id: string; recent?: string }> };
        expect(result.failures).toMatchObject([{ id: 'TC-XY-002', recent: expect.stringMatching(/✓✗$/) }]);
    });

    test('a run that takes too long is stopped and says so', async () => {
        fs.writeFileSync(path.join(root, 'slow.spec.ts'), `
import { test } from '@playwright/test';
test('[TC-XY-009] slow', { tag: ['@TC-XY-009'] }, async () => {
    await test.step('Step 1: Wait', async () => { await new Promise((r) => setTimeout(r, 60_000)); });
});
`);
        try {
            const result = (await tool(tools, 'run_tests').handler({ ids: ['TC-XY-009'], timeout: 10 })) as RunTestsResult;
            expect(result).toMatchObject({ ok: false, status: 'timedout', timedOut: true });
            expect(result.durationMs).toBeLessThan(40_000);
        } finally {
            fs.rmSync(path.join(root, 'slow.spec.ts'));
        }
    });
});

test.describe('last_failures, flaky_tests and generate_api_tests — from files', () => {
    let root: string;
    test.beforeEach(({}, testInfo) => {
        root = path.join(REPO, '.propmaster', `test-tools-files-${process.pid}-${testInfo.testId}`);
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","private":true}');
    });
    test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('without a last-run file the newest history run is used, without errors; with neither, it says how to get one', async () => {
        const tools = testTools({ root, environment: 'local', production: false });
        const none = (await tool(tools, 'last_failures').handler({})) as { source: string; message: string };
        expect(none).toMatchObject({ source: 'none', message: expect.stringContaining('@inluxc/propmaster/reporter') });

        appendRun(path.join(root, '.propmaster', 'test-history.json'), {
            id: 'r1', startedAt: '2026-01-01T00:00:00Z', status: 'failed',
            tests: [{ id: 'TC-AB-001', title: '[TC-AB-001] x', file: 'a.spec.ts', project: 'p', outcome: 'failed', retries: 0, duration: 5 }],
        });
        const fromHistory = (await tool(tools, 'last_failures').handler({})) as { source: string; failures: Array<{ id: string; errors: unknown[] }> };
        expect(fromHistory).toMatchObject({ source: 'history', failures: [{ id: 'TC-AB-001', errors: [] }] });
    });

    test('flaky_tests ranks the history, with limit and minRate', async () => {
        const tools = testTools({ root, environment: 'local', production: false });
        expect(await tool(tools, 'flaky_tests').handler({})).toMatchObject({ runs: 0, message: expect.stringContaining('No test history') });
        const file = path.join(root, '.propmaster', 'test-history.json');
        const t = (id: string, outcome: 'passed' | 'flaky' | 'failed') => ({ id, title: id, file: 'a.spec.ts', project: 'p', outcome, retries: 0, duration: 1 });
        for (let i = 0; i < 4; i++) {
            appendRun(file, { id: `r${i}`, startedAt: `2026-01-0${i + 1}T00:00:00Z`, status: 'passed', tests: [t('TC-AB-001', i === 0 ? 'flaky' : 'passed'), t('TC-AB-002', i % 2 ? 'flaky' : 'passed')] });
        }
        const all = (await tool(tools, 'flaky_tests').handler({})) as { runs: number; tests: Array<{ id: string; flakeRate: number }> };
        expect(all.runs).toBe(4);
        expect(all.tests.map((r) => [r.id, r.flakeRate])).toEqual([['TC-AB-002', 0.5], ['TC-AB-001', 0.25]]);
        expect(await tool(tools, 'flaky_tests').handler({ limit: 1 })).toMatchObject({ tests: [{ id: 'TC-AB-002' }], more: 1 });
        expect(((await tool(tools, 'flaky_tests').handler({ minRate: 0.3 })) as { tests: unknown[] }).tests).toHaveLength(1);
        await expect(tool(tools, 'flaky_tests').handler({ minRate: 2 })).rejects.toThrow('minRate must be a number from 0 to 1');
    });

    test('generate_api_tests previews the files with fresh IDs, and writes them only with apply', async () => {
        fs.writeFileSync(path.join(root, 'shop.json'), JSON.stringify({
            openapi: '3.0.3',
            info: { title: 'Shop', version: '1' },
            paths: {
                '/products': { get: { operationId: 'listProducts', tags: ['Catalog'], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } } } },
            },
        }));
        const tools = testTools({ root, environment: 'local', production: false });
        const preview = (await tool(tools, 'generate_api_tests').handler({ spec: './shop.json' })) as {
            applied: boolean; reason: string; files: Array<{ file: string; tests: Array<{ id: string; operationId: string; status: string }>; content: string }>;
        };
        expect(preview).toMatchObject({ applied: false, reason: expect.stringContaining('apply: true') });
        expect(preview.files.map((f) => f.file)).toEqual(['tests/api/catalog.spec.ts']);
        expect(preview.files[0].tests).toMatchObject([{ id: 'TC-API-001', operationId: 'listProducts', status: '200' }]);
        expect(preview.files[0].content).toContain("test('[TC-API-001]");
        expect(fs.existsSync(path.join(root, 'tests'))).toBe(false);

        const written = (await tool(tools, 'generate_api_tests').handler({ spec: './shop.json', apply: true, content: false })) as { applied: boolean; written: string[]; files: Array<{ content?: string }> };
        expect(written).toMatchObject({ applied: true, written: ['tests/api/catalog.spec.ts'] });
        expect(written.files[0].content).toBeUndefined();
        // The operation has a test now: nothing more to generate
        expect(await tool(tools, 'generate_api_tests').handler({ spec: './shop.json' })).toMatchObject({ files: [], reason: 'Nothing to generate.', alreadyCovered: ['listProducts 200'] });
        await expect(tool(tools, 'generate_api_tests').handler({})).rejects.toThrow('No OpenAPI spec');
    });

    test('no run_tests for a production environment', () => {
        const names = testTools({ root, environment: 'prod', production: true }).map((t) => t.name);
        expect(names).toEqual(['last_failures', 'flaky_tests', 'generate_api_tests']);
    });

    test('the text output lists failures first and skips flaky tests on request', () => {
        const run = {
            version: 1 as const, startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:05.000Z', status: 'failed',
            counts: { total: 2, passed: 0, flaky: 1, failed: 1, skipped: 0 }, errors: ['Error: globalSetup threw'],
            tests: [
                { id: 'TC-AB-001', title: '[TC-AB-001] a', location: 'a.spec.ts:3', project: 'p', outcome: 'failed' as const, retries: 0, duration: 1, errors: [{ message: 'boom' }], recent: '✓✓✗' },
                { id: 'TC-AB-002', title: '[TC-AB-002] b', location: 'a.spec.ts:9', project: 'p', outcome: 'flaky' as const, retries: 1, duration: 1, errors: [{ message: 'flip' }] },
            ],
        };
        const text = formatLastRun(run);
        expect(text).toContain('Last run 2026-01-01 10:00:05: failed.');
        expect(text).toContain('Error outside the tests: Error: globalSetup threw');
        expect(text).toContain('  history: ✓✓✗ (oldest first)');
        expect(text).toContain('~ flaky   [TC-AB-002] b');
        expect(formatLastRun(run, { flaky: false })).not.toContain('TC-AB-002');
    });
});
