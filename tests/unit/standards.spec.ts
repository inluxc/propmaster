/**
 * Unit tests for QA standards: propmaster.standards.json validation, every
 * rule type through the checker, the pages, `propmaster standards`, and the
 * MCP standards tool and resources.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSources, collect, findDescribes, skipNonCode, type SourceInput } from '../../src/cli/check-tests';
import {
    SAMPLE_STANDARDS,
    initStandards,
    listPages,
    loadStandards,
    maskNonCode,
    precedingDoc,
    readPage,
    runStandards,
    tagsOf,
    validateStandards,
    type StandardRule,
    type Standards,
} from '../../src/cli/standards';
import { projectTools, standardsResources } from '../../src/mcp/project-tools';
import { McpServer } from '../../src/mcp/protocol';
import { createPropmasterMcpServer } from '../../src/mcp/server';

const HEAD = "import { test, expect } from '@inluxc/propmaster';\n";
const T = (id: string, title: string, opts = '', body = "await test.step('Step 1: s', async () => {});") =>
    `test('[${id}] ${title}', { tag: ['@${id}'${opts}] }, async ({ page }) => {\n    ${body}\n});\n`;

function check(rules: StandardRule[], content: string, file = 'tests/api/a.spec.ts') {
    const standards: Standards = { pages: 'standards', rules };
    const sources: SourceInput[] = [{ file, content, kind: 'test' }];
    const { violations, warnings } = checkSources(sources, standards);
    const own = (v: { rule: string }) => v.rule.startsWith('standard:');
    return { errors: violations.filter(own), warnings: warnings.filter(own), builtIn: violations.filter((v) => !own(v)) };
}

function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-standards-'));
    for (const [rel, content] of Object.entries({ 'package.json': '{ "name": "scratch" }', ...files })) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

test.describe('standards file', () => {
    test('the sample set is valid; every kind of mistake is named', () => {
        expect(validateStandards(SAMPLE_STANDARDS).problems).toEqual([]);
        expect(validateStandards([]).problems).toEqual(['must be an object with a "rules" array']);
        expect(validateStandards({ rules: {} }).problems).toEqual(['"rules" must be an array']);
        const { problems } = validateStandards({
            pages: 3,
            rules: [
                { id: 'Owner Tag', type: 'required-tag' },
                { id: 'a', type: 'nope' },
                { id: 'b', type: 'required-tag' },
                { id: 'c', type: 'title-pattern', pattern: '(' },
                { id: 'd', type: 'banned-call', calls: ['page.wait For'] },
                { id: 'e', type: 'max-steps', max: 0 },
                { id: 'f', type: 'min-steps' },
                { id: 'g', type: 'banned-pattern', pattern: 'x', level: 'info', files: 'tests/' },
                { id: 'g', type: 'requirements-doc' },
            ],
        });
        expect(problems).toEqual([
            '"pages" must be a folder name',
            'rules[0]: "id" must be kebab-case, e.g. "owner-tag"',
            '"a": "type" must be one of required-tag, title-pattern, describe-pattern, banned-call, banned-pattern, max-steps, min-steps, requirements-doc',
            '"b": a required-tag rule needs "pattern"',
            expect.stringMatching(/^"c": "pattern" isn't a valid regular expression: /),
            '"d": a banned-call rule needs "calls", e.g. ["page.waitForTimeout"]',
            '"e": a max-steps rule needs "max", a positive whole number',
            '"f": a min-steps rule needs "min", a positive whole number',
            '"g": "level" must be "error" or "warn"',
            '"g": "files" must be an array of paths',
            '"g" is listed twice',
        ]);
    });

    test('a page a rule points at must exist', () => {
        const root = project({ 'standards/tagging.md': '# Tagging\n' });
        expect(validateStandards({ rules: [{ id: 'a', type: 'requirements-doc', page: 'tagging.md#owners' }, { id: 'b', type: 'requirements-doc', page: 'gone.md' }] }, root).problems).toEqual([
            '"b": page standards/gone.md not found',
        ]);
    });

    test('an invalid file fails the check and its rules are not applied', () => {
        const root = project({ 'propmaster.standards.json': '{ "rules": [ { "id": "x" ', 'tests/a.spec.ts': HEAD + T('TC-API-001', 'a') });
        const { violations } = collect(root);
        expect(violations).toEqual([{ file: 'propmaster.standards.json', line: 1, rule: 'standards', message: expect.stringMatching(/^not valid JSON: /) }]);
        expect(loadStandards(project({})).standards).toBeNull();
    });
});

test.describe('rules', () => {
    test('required-tag: on the test, its describe (even several levels up), or in a title', () => {
        const rule: StandardRule = { id: 'owner', type: 'required-tag', pattern: '^@owner-', example: '@owner-payments', page: 'tagging.md#owners' };
        const src =
            HEAD +
            T('TC-API-001', 'tagged', ", '@owner-a'") +
            "test.describe('Outer', { tag: '@owner-b' }, () => {\n  test.describe('Inner', () => {\n" +
            T('TC-API-002', 'inherited') +
            '  });\n});\n' +
            T('TC-API-003', 'in the title @owner-c') +
            T('TC-API-004', 'missing');
        const { errors } = check([rule], src);
        expect(errors).toEqual([
            {
                file: 'tests/api/a.spec.ts',
                line: 15,
                rule: 'standard:owner',
                test: '[TC-API-004] missing',
                message: "Needs a tag matching /^@owner-/, e.g. '@owner-payments' (on the test or its describe). See standards/tagging.md#owners.",
            },
        ]);
    });

    test('title-pattern skips the ID prefix and parameterized titles; describe-pattern checks describes', () => {
        const src = HEAD + "test.describe('orders', () => {\n" + T('TC-API-001', 'a lowercase title') + T('TC-API-002', 'Capitalised') + '});\n' + "for (const c of cases) test(`[${c.id}] Dynamic`, { tag: [`@${c.id}`] }, async () => { await test.step('s', async () => {}); });\n";
        const { errors } = check([{ id: 'titles', type: 'title-pattern', pattern: '^[a-z]' }, { id: 'describes', type: 'describe-pattern', pattern: '^[A-Z]' }], src);
        expect(errors.map((e) => [e.rule, e.line, e.message])).toEqual([
            ['standard:titles', 6, 'Title "Capitalised" doesn\'t match /^[a-z]/ (checked without the [TC-...] prefix).'],
            ['standard:describes', 2, 'Describe "orders" doesn\'t match /^[A-Z]/.'],
        ]);
    });

    test('banned-call: real calls only, not in comments, strings or longer names; test.only too', () => {
        const src =
            HEAD +
            T('TC-API-001', 'a', '', "await test.step('s', async () => { await page.waitForTimeout(100); });") +
            "// page.waitForTimeout(1) in a comment\nconst s = 'page.waitForTimeout(1)';\nmypage.waitForTimeout(1);\n" +
            "test.only('[TC-API-002] b', { tag: ['@TC-API-002'] }, async () => { await test.step('s', async () => {}); });\n";
        const { errors } = check([{ id: 'no-waits', type: 'banned-call', calls: ['page.waitForTimeout', 'test.only'] }], src);
        expect(errors.map((e) => [e.line, e.message])).toEqual([
            [3, '`page.waitForTimeout()` isn\'t allowed here.'],
            [8, '`test.only()` isn\'t allowed here.'],
        ]);
    });

    test('banned-pattern matches the raw source, strings included', () => {
        const src = HEAD + T('TC-API-001', 'a', '', "await test.step('s', async () => { await page.goto('https://staging.example.com/x'); });");
        const { errors } = check([{ id: 'no-hosts', type: 'banned-pattern', pattern: 'https?://[\\w.-]+\\.example\\.com', message: 'Use baseURL, not a host.' }], src);
        expect(errors).toMatchObject([{ line: 3, message: 'Use baseURL, not a host.' }]);
    });

    test('max-steps and min-steps; a *Steps class satisfies min-steps', () => {
        const three = "await test.step('a', async () => {}); await test.step('b', async () => {}); await test.step('c', async () => {});";
        const src = HEAD + T('TC-API-001', 'three', '', three) + T('TC-API-002', 'one') + T('TC-API-003', 'steps class', '', 'await new OrderSteps(api).create();');
        const { errors } = check([{ id: 'max', type: 'max-steps', max: 2 }, { id: 'min', type: 'min-steps', min: 2 }], src);
        expect(errors.map((e) => [e.rule, e.test, e.message])).toEqual([
            ['standard:max', '[TC-API-001] three', 'Has 3 steps; at most 2 (split the test, or move steps into a *Steps class).'],
            ['standard:min', '[TC-API-002] one', 'Has 1 step; at least 2.'],
        ]);
    });

    test('requirements-doc: on the test, on its describe, or at the top of the file', () => {
        const rule: StandardRule = { id: 'req', type: 'requirements-doc' };
        const onTest = HEAD + '/** @requirements PAY-1 */\n' + T('TC-API-001', 'a') + T('TC-API-002', 'b');
        expect(check([rule], onTest).errors.map((e) => e.test)).toEqual(['[TC-API-002] b']);
        const onDescribe = HEAD + "/**\n * Refunds\n * @requirements PAY-2\n */\ntest.describe('Refunds', () => {\n" + T('TC-API-001', 'a') + '});\n';
        expect(check([rule], onDescribe).errors).toEqual([]);
        const onFile = '/** @requirements PAY-3 */\n' + HEAD + T('TC-API-001', 'a');
        expect(check([rule], onFile).errors).toEqual([]);
    });

    test('level warn reports without failing; files and exclude scope a rule; built-in rules are untouched', () => {
        const rules: StandardRule[] = [
            { id: 'e2e-owner', type: 'required-tag', pattern: '^@owner-', files: ['tests/e2e/'], exclude: ['tests/e2e/legacy/'] },
            { id: 'soft', type: 'title-pattern', pattern: '^never', level: 'warn' },
        ];
        const src = HEAD + T('TC-API-001', 'a');
        expect(check(rules, src, 'tests/api/a.spec.ts')).toMatchObject({ errors: [], warnings: [{ rule: 'standard:soft' }], builtIn: [] });
        expect(check(rules, src, 'tests/e2e/a.spec.ts').errors).toMatchObject([{ rule: 'standard:e2e-owner' }]);
        expect(check(rules, src, 'tests/e2e/legacy/a.spec.ts').errors).toEqual([]);
    });

    test('helpers: describes, tags, preceding docs and masking', () => {
        const src = "test.describe.serial('S', { tag: ['@a'] }, () => { test.describe('T', () => {}); });\n// test.describe('C', () => {})\n";
        expect(findDescribes(src).map((d) => [d.title, d.options])).toEqual([
            ['S', "{ tag: ['@a'] }"],
            ['T', null],
        ]);
        expect(tagsOf("{ tag: ['@x', \"@y\"] }", 'title @smoke')).toEqual(['@x', '@y', '@smoke']);
        expect(precedingDoc('/** doc */\n  test(', 13)).toBe('/** doc */');
        expect(precedingDoc('// line\ntest(', 8)).toBeNull();
        const masked = maskNonCode("a('x.y()') // b()\nc()", skipNonCode);
        expect(masked).toHaveLength("a('x.y()') // b()\nc()".length);
        expect(masked).toBe(`a('${' '.repeat(5)}')${' '.repeat(' // b()'.length)}\nc()`);
    });
});

test.describe('pages, the command and MCP', () => {
    test('standards init writes the sample set once; list shows rules and pages, README first', () => {
        const root = project({});
        const first = initStandards(root);
        expect(first.written).toEqual(['propmaster.standards.json', 'standards/README.md', 'standards/writing-tests.md', 'standards/tagging.md', 'standards/traceability.md']);
        expect(initStandards(root)).toEqual({ written: [], skipped: first.written });
        expect(loadStandards(root).problems).toEqual([]);
        const pages = listPages(root);
        expect(pages.map((p) => [p.file, p.title])).toEqual([
            ['README.md', 'Testing standards'],
            ['tagging.md', 'Tagging'],
            ['traceability.md', 'Traceability'],
            ['writing-tests.md', 'Writing tests'],
        ]);
        expect(pages[1].summary).toBe('Tags let us run, route and report on tests by who owns them and how much they matter.');
        expect(readPage(root, 'tagging.md#owners')).toContain('## Owners');
        expect(readPage(root, '../package.json')).toBeUndefined();
        expect(readPage(root, 'missing.md')).toBeUndefined();

        const lines: string[] = [];
        expect(runStandards(['--json'], root, (l = '') => void lines.push(l))).toBe(0);
        expect(JSON.parse(lines.join('\n'))).toMatchObject({ problems: [], rules: SAMPLE_STANDARDS.rules, pages: expect.any(Array) });
    });

    test('the sample rules run on a real test file, through collect()', () => {
        const root = project({ 'tests/api/a.spec.ts': HEAD + T('TC-API-001', 'Untagged', '', "await test.step('s', async () => { await page.waitForTimeout(5); });") });
        initStandards(root);
        const { violations, warnings } = collect(root);
        expect(violations.map((v) => v.rule)).toEqual(['standard:owner-tag', 'standard:no-fixed-waits']);
        expect(warnings.map((v) => v.rule)).toEqual(['standard:priority-tag', 'standard:title-style', 'standard:traceability']);
    });

    test('MCP: the standards tool, standards:// resources, and the server telling agents to read them', async () => {
        const root = project({ 'environments.json': '{ "environments": { "local": {} } }' });
        const tool = projectTools(root).find((t) => t.name === 'standards')!;
        expect(await tool.handler({})).toMatchObject({ standards: false });
        initStandards(root);
        const listed = (await tool.handler({})) as { pages: Array<{ file: string }>; rules: unknown[] };
        expect(listed.pages.map((p) => p.file)).toContain('tagging.md');
        expect(listed.rules).toHaveLength(SAMPLE_STANDARDS.rules.length);
        expect(await tool.handler({ page: 'tagging.md' })).toContain('# Tagging');
        await expect(tool.handler({ page: 'nope.md' })).rejects.toThrow('no page "nope.md". Pages: README.md, tagging.md, traceability.md, writing-tests.md');

        const server = new McpServer({ name: 't', version: '1', tools: [], resources: standardsResources(root) });
        const init = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))!.result as { capabilities: Record<string, unknown> };
        expect(init.capabilities.resources).toEqual({ listChanged: false });
        const list = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }))!.result as { resources: Array<{ uri: string; title: string }> };
        expect(list.resources[0]).toMatchObject({ uri: 'standards://README.md', title: 'Testing standards', mimeType: 'text/markdown' });
        const read = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'standards://tagging.md' } }))!.result as { contents: Array<{ text: string }> };
        expect(read.contents[0].text).toContain('## Priority');
        expect((await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'standards://../x.md' } }))!.error).toMatchObject({ message: 'Unknown resource: standards://../x.md' });

        const created = await createPropmasterMcpServer({ root, environment: 'local', allowWrites: false, allowProd: false }, () => undefined);
        try {
            const result = (await created.server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))!.result as { instructions: string };
            expect(result.instructions).toContain('This project has testing standards: read them with the standards tool');
        } finally {
            await created.close();
        }
    });
});
