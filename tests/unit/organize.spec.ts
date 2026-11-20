/**
 * Unit tests for `stagehand organize` (src/cli/organize.ts): fixture parsing,
 * classification, destinations, import rewriting, and planning/applying moves
 * in throwaway projects.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    analyzeSource,
    applyOrganize,
    classifyFixtures,
    destinationFor,
    fixturesOf,
    planOrganize,
    resolveSpecifier,
    rewriteImports,
} from '../../src/cli/organize';

const STAGEHAND = "import { test, expect } from '@inluxc/stagehand';\n";

test.describe('organize — fixturesOf', () => {
    test('reads destructured names, aliases, defaults and function syntax', () => {
        expect(fixturesOf('async ({ page, openApiClient: api }) => {}')).toEqual(['page', 'openApiClient']);
        expect(fixturesOf('async ({ databaseClient, retries = 2 }, testInfo) => {}')).toEqual(['databaseClient', 'retries']);
        expect(fixturesOf('async function ({ redisClient }) {}')).toEqual(['redisClient']);
        expect(fixturesOf('async ({\n  page,\n  ...rest\n}) => {}')).toEqual(['page']);
    });

    test('returns [] without parameters and null when the parameter is not destructured', () => {
        expect(fixturesOf('async () => {}')).toEqual([]);
        expect(fixturesOf('async (fixtures) => {}')).toBeNull();
    });
});

test.describe('organize — classifyFixtures', () => {
    test('device and browser fixtures win over service and HTTP fixtures', () => {
        expect(classifyFixtures(['appiumDriver', 'page'])).toEqual({ type: 'mobile' });
        expect(classifyFixtures(['page', 'openApiClient', 'databaseClient'])).toEqual({ type: 'e2e' });
        expect(classifyFixtures(['databaseClient', 'openApiClient'])).toEqual({ type: 'integration' });
        expect(classifyFixtures(['graphqlClient', 'request'])).toEqual({ type: 'api' });
    });

    test('neutral fixtures (OTP, options, *Config) do not change the type', () => {
        expect(classifyFixtures(['openApiClient', 'otpClient', 'baseURL', 'otpConfig'])).toEqual({ type: 'api' });
    });

    test('custom fixtures are ambiguous unless a browser or device decides', () => {
        expect(classifyFixtures(['loginPage']).type).toBeNull();
        expect(classifyFixtures(['loginPage', 'databaseClient']).type).toBeNull();
        expect(classifyFixtures(['loginPage', 'page'])).toEqual({ type: 'e2e' });
    });

    test('tests with no deciding fixture are ambiguous', () => {
        const c = classifyFixtures(['otpClient']);
        expect(c.type).toBeNull();
        expect(c.reason).toContain('unit-style');
    });
});

test.describe('organize — analyzeSource', () => {
    test('ignores files from other test runners', () => {
        expect(analyzeSource("import { test } from 'vitest';\ntest('x', () => {});").playwright).toBe(false);
        expect(analyzeSource("test('jest global', () => {});").playwright).toBe(false);
    });

    test('a semicolon-less vitest import followed by a relative import is still not Playwright', () => {
        const src = "import { test } from 'vitest'\nimport { helper } from './helper'\ntest('x', () => {})\n";
        expect(analyzeSource(src).playwright).toBe(false);
    });

    test('accepts @playwright/test, the framework and a local fixtures module', () => {
        for (const from of ['@playwright/test', '@inluxc/stagehand', '../support/fixtures']) {
            const a = analyzeSource(`import { expect, test } from '${from}';\ntest('t', async ({ page }) => {});`);
            expect(a).toMatchObject({ playwright: true, type: 'e2e' });
        }
    });

    test('hook fixtures count for every test in the file', () => {
        const src = `${STAGEHAND}test.beforeEach(async ({ redisClient }) => {});\ntest('t', async ({ openApiClient }) => {});`;
        expect(analyzeSource(src).type).toBe('integration');
    });

    test('a file mixing types is ambiguous, with counts', () => {
        const src = `${STAGEHAND}test('a', async ({ page }) => {});\ntest('b', async ({ request }) => {});\ntest('c', async ({ request }) => {});`;
        const a = analyzeSource(src);
        expect(a.type).toBeNull();
        expect(a.reason).toContain('e2e (1), api (2)');
    });

    test('reports the first test it cannot place, with its line', () => {
        const src = `${STAGEHAND}test('ok', async ({ page }) => {});\ntest('opaque', async (fx) => {});`;
        expect(analyzeSource(src).reason).toContain('"opaque" (line 3)');
    });

    test('a file without test() calls is ambiguous', () => {
        expect(analyzeSource(`${STAGEHAND}export const x = 1;`)).toMatchObject({ playwright: true, type: null, reason: 'no test() calls found' });
    });
});

test.describe('organize — destinationFor', () => {
    test('drops one root folder and one type-like folder, keeping sub-folders', () => {
        expect(destinationFor('tests/specs/users/create.spec.ts', 'api')).toBe('tests/api/users/create.spec.ts');
        expect(destinationFor('e2e/login.spec.ts', 'e2e')).toBe('tests/e2e/login.spec.ts');
        expect(destinationFor('tests/E2E/checkout/pay.spec.ts', 'e2e')).toBe('tests/e2e/checkout/pay.spec.ts');
        expect(destinationFor('tests/orders.spec.ts', 'integration')).toBe('tests/integration/orders.spec.ts');
    });

    test('keeps a file already in its folder, even with a type-named sub-folder', () => {
        expect(destinationFor('tests/e2e/api/mocked.spec.ts', 'e2e')).toBe('tests/e2e/api/mocked.spec.ts');
        expect(destinationFor('tests/api/users.spec.ts', 'api')).toBe('tests/api/users.spec.ts');
    });

    test('turns the old .browser/.mobile/.e2e suffixes into .spec', () => {
        expect(destinationFor('tests/specs/cart.browser.ts', 'e2e')).toBe('tests/e2e/cart.spec.ts');
        expect(destinationFor('tests/specs/app.mobile.js', 'mobile')).toBe('tests/mobile/app.spec.js');
        expect(destinationFor('tests/flows/buy.e2e.ts', 'e2e')).toBe('tests/e2e/flows/buy.spec.ts');
        expect(destinationFor('tests/users.test.ts', 'api')).toBe('tests/api/users.test.ts');
    });
});

test.describe('organize — import rewriting', () => {
    const files = new Set([
        'tests/specs/a.spec.ts',
        'tests/pages/login.page.ts',
        'tests/data/users.json',
        'tests/support/index.ts',
        'tests/report.ts',
    ]);

    test('resolves extensionless, .js (ESM) and index specifiers', () => {
        expect(resolveSpecifier('tests/specs/a.spec.ts', '../pages/login.page', files)?.file).toBe('tests/pages/login.page.ts');
        expect(resolveSpecifier('tests/specs/a.spec.ts', '../pages/login.page.js', files)?.file).toBe('tests/pages/login.page.ts');
        expect(resolveSpecifier('tests/specs/a.spec.ts', '../support', files)?.file).toBe('tests/support/index.ts');
        expect(resolveSpecifier('tests/specs/a.spec.ts', '../missing', files)).toBeNull();
    });

    test('a moved file keeps pointing at the same targets, in the same style', () => {
        const src = [
            "import { LoginPage } from '../pages/login.page';",
            "import { LoginPage as P } from '../pages/login.page.js';",
            "import users from '../data/users.json';",
            "import * as support from '../support';",
            "const lazy = await import('../pages/login.page');",
            "import { x } from '../missing';",
            "import { test } from '@inluxc/stagehand';",
        ].join('\n');
        const moves = new Map([['tests/specs/a.spec.ts', 'tests/e2e/deep/a.spec.ts']]);
        const { content, changed } = rewriteImports(src, 'tests/specs/a.spec.ts', 'tests/e2e/deep/a.spec.ts', moves, files);
        expect(changed).toBe(5);
        expect(content).toContain("from '../../pages/login.page';");
        expect(content).toContain("from '../../pages/login.page.js';");
        expect(content).toContain("from '../../data/users.json';");
        expect(content).toContain("from '../../support';");
        expect(content).toContain("import('../../pages/login.page')");
        expect(content).toContain("from '../missing';"); // unresolvable: untouched
        expect(content).toContain("from '@inluxc/stagehand';");
    });

    test('a file that stays is updated when what it imports moves', () => {
        const moves = new Map([['tests/specs/a.spec.ts', 'tests/api/a.spec.ts']]);
        const { content, changed } = rewriteImports("export * from './specs/a.spec';", 'tests/report.ts', 'tests/report.ts', moves, files);
        expect(changed).toBe(1);
        expect(content).toBe("export * from './api/a.spec';");
    });

    test('nothing changes when neither side moves', () => {
        const src = "import { LoginPage } from './pages/login.page';";
        expect(rewriteImports(src, 'tests/report.ts', 'tests/report.ts', new Map(), files)).toEqual({ content: src, changed: 0 });
    });
});

test.describe('organize — plan and apply', () => {
    let root: string;

    const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    };
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'stagehand-organize-'));
        write('package.json', '{ "name": "sample" }');
        write('tests/helpers/user.ts', 'export const user = { name: "A" };');
        write('tests/specs/users.spec.ts', `${STAGEHAND}import { user } from '../helpers/user';\ntest('u', async ({ openApiClient }) => {});`);
        write('tests/cart.browser.ts', `${STAGEHAND}import { user } from './helpers/user';\ntest('c', async ({ page }) => {});`);
        write('tests/db/orders.spec.ts', `${STAGEHAND}test('o', async ({ databaseClient }) => { readFileSync(__dirname); });`);
        write('tests/mixed.spec.ts', `${STAGEHAND}test('a', async ({ page }) => {});\ntest('b', async ({ request }) => {});`);
        write('tests/unit/math.test.ts', "import { test } from 'vitest'\ntest('m', () => {})");
    });

    test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('plans moves, keeps ambiguous files, flags relative paths and ignores other runners', () => {
        const plan = planOrganize(root);
        expect(plan.moves.map((m) => [m.from, m.to]).sort()).toEqual([
            ['tests/cart.browser.ts', 'tests/e2e/cart.spec.ts'],
            ['tests/db/orders.spec.ts', 'tests/integration/db/orders.spec.ts'],
            ['tests/specs/users.spec.ts', 'tests/api/users.spec.ts'],
        ]);
        expect(plan.ambiguous.map((a) => a.file)).toEqual(['tests/mixed.spec.ts']);
        expect(plan.warnings.map((w) => w.file)).toEqual(['tests/integration/db/orders.spec.ts']);
        expect(plan.edits).toEqual([{ file: 'tests/e2e/cart.spec.ts', imports: 1 }]);
    });

    test('reports a conflict instead of overwriting an existing file', () => {
        write('tests/api/users.spec.ts', `${STAGEHAND}test('already here', async ({ request }) => {});`);
        const plan = planOrganize(root);
        expect(plan.conflicts).toEqual([
            { file: 'tests/specs/users.spec.ts', to: 'tests/api/users.spec.ts', reason: 'tests/api/users.spec.ts already exists' },
        ]);
        expect(plan.inPlace.map((f) => f.file)).toContain('tests/api/users.spec.ts');
    });

    test('apply moves files, rewrites imports and removes emptied folders (no git)', () => {
        applyOrganize(planOrganize(root));
        expect(fs.existsSync(path.join(root, 'tests/specs'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'tests/db'))).toBe(false);
        expect(read('tests/e2e/cart.spec.ts')).toContain("from '../helpers/user'");
        expect(read('tests/api/users.spec.ts')).toContain("from '../helpers/user'");
        expect(read('tests/mixed.spec.ts')).toContain("test('a'"); // left alone
        expect(fs.existsSync(path.join(root, 'tests/unit/math.test.ts'))).toBe(true);
        expect(planOrganize(root).moves).toEqual([]); // idempotent
    });

    test('apply uses git mv for tracked files, so git sees renames', () => {
        const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.name=organize test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root }).toString();
        try {
            git('init', '-q');
        } catch {
            test.skip(true, 'git is not available');
        }
        git('add', '-A');
        git('commit', '-qm', 'before');
        applyOrganize(planOrganize(root));
        const status = git('status', '--porcelain');
        expect(status).toContain('R  tests/specs/users.spec.ts -> tests/api/users.spec.ts');
        expect(status).toContain('tests/cart.browser.ts -> tests/e2e/cart.spec.ts');
    });
});
