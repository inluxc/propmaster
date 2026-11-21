/**
 * Unit tests for `propmaster init` (src/cli/init.ts) and the layout it
 * scaffolds (src/cli/layout.ts), in throwaway folders.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect } from '../../src/cli/check-tests';
import { existingPlaywrightConfigs, initProject } from '../../src/cli/init';
import { ROOT_CONFIG_TEMPLATE, TEST_TYPES, configSnippet } from '../../src/cli/layout';

const quiet = () => {};

test.describe('init — layout', () => {
    let root: string;
    const exists = (p: string) => fs.existsSync(path.join(root, p));
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-init-'));
    });
    test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('a new project gets one folder per type, each with projects.ts, plus tests/support', () => {
        const result = initProject(root, quiet);
        for (const t of TEST_TYPES) expect(exists(`${t.dir}/projects.ts`)).toBe(true);
        for (const d of ['pages', 'fixtures', 'data', 'models', 'utils', 'config']) expect(exists(`tests/support/${d}`)).toBe(true);
        expect(exists('tests/specs')).toBe(false);
        expect(result.plan).toBeNull();
        expect(result.existingConfigs).toEqual([]);
        expect(result.created).toContain('playwright.config.ts');
    });

    test('a new project gets .mcp.json for the Propmaster MCP server', () => {
        initProject(root, quiet);
        expect(JSON.parse(read('.mcp.json'))).toEqual({ mcpServers: { propmaster: { command: 'npx', args: ['propmaster', 'mcp'] } } });
        expect(read('AGENTS.md')).toContain('## Propmaster MCP server');
    });

    test('the root config imports and spreads every projects.ts', () => {
        initProject(root, quiet);
        const config = read('playwright.config.ts');
        for (const t of TEST_TYPES) {
            expect(config).toContain(`import { ${t.exportName} } from './${t.dir}/projects';`);
            expect(config).toContain(`...${t.exportName}(config),`);
            expect(read(`${t.dir}/projects.ts`)).toContain(`export const ${t.exportName} =`);
            expect(read(`${t.dir}/projects.ts`)).toContain(`testDir: './${t.dir}'`);
        }
        expect(config).toBe(ROOT_CONFIG_TEMPLATE);
    });

    test('package.json scripts and checker settings match the layout', () => {
        initProject(root, quiet);
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.scripts['test:api']).toContain('--project=api');
        expect(pkg.scripts['test:e2e']).toContain("--project='e2e-*'");
        expect(pkg.propmaster.testDirs).toEqual(['tests']);
    });

    test('templates generate no comment-closing globs and their doc samples pass `propmaster check`', () => {
        initProject(root, quiet);
        for (const t of TEST_TYPES) {
            const src = read(`${t.dir}/projects.ts`);
            const firstComment = src.slice(src.indexOf('/**'), src.indexOf('*/') + 2);
            expect(firstComment).toContain('Specs:'); // the comment wasn't closed early by a `**/` glob
        }
        expect(collect(root).violations).toEqual([]);
    });

    test('an existing project: nothing is moved or overwritten, and its tests are reported', () => {
        fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "mine" }');
        fs.writeFileSync(path.join(root, 'playwright.config.js'), 'export default {};');
        fs.mkdirSync(path.join(root, 'e2e'));
        const spec = "import { test } from '@playwright/test';\ntest('home', async ({ page }) => {});\n";
        fs.writeFileSync(path.join(root, 'e2e/home.spec.ts'), spec);

        const lines: string[] = [];
        const result = initProject(root, (l = '') => lines.push(l));

        expect(result.existingConfigs).toEqual(['playwright.config.js']);
        expect(exists('playwright.config.ts')).toBe(false); // no second config
        expect(read('package.json')).toBe('{ "name": "mine" }');
        expect(read('e2e/home.spec.ts')).toBe(spec);
        expect(result.plan?.moves).toEqual([{ from: 'e2e/home.spec.ts', to: 'tests/e2e/home.spec.ts', type: 'e2e', tests: 1 }]);
        const out = lines.join('\n');
        expect(out).toContain('Nothing was moved or overwritten.');
        expect(out).toContain('npx propmaster organize');
        expect(out).toContain("import { e2eProjects } from './tests/e2e/projects';");
    });

    test('running init twice changes nothing', () => {
        initProject(root, quiet);
        const second = initProject(root, quiet);
        expect(second.created).toEqual([]);
    });
});

test.describe('init — helpers', () => {
    test('existingPlaywrightConfigs finds every config extension', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-cfg-'));
        for (const f of ['playwright.config.mjs', 'playwright.config.ts', 'other.config.ts']) fs.writeFileSync(path.join(dir, f), '');
        expect(existingPlaywrightConfigs(dir)).toEqual(['playwright.config.mjs', 'playwright.config.ts']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('configSnippet lists only the requested types', () => {
        const snippet = configSnippet(['api', 'e2e']);
        expect(snippet).toContain('...apiProjects(config),');
        expect(snippet).toContain('...e2eProjects(config),');
        expect(snippet).not.toContain('mobileProjects');
    });
});
