/**
 * Unit tests for the test-convention scanner behind `propmaster check` /
 * `propmaster next-id` (src/cli/check-tests.ts).
 *
 * Sample sources use the fictional `ZZ` category so the IDs this file
 * mentions (which the checker reserves) never collide with real ones.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    checkSources,
    collect,
    findTests,
    loadConfig,
    nextIds,
    DEFAULT_CONFIG,
    type SourceInput,
} from '../../src/cli/check-tests';

const spec = (content: string, file = 'tests/specs/a.spec.ts'): SourceInput => ({ file, content, kind: 'test' });
const rules = (sources: SourceInput[]) => checkSources(sources).violations.map((v) => v.rule).sort();

const GOOD = `
import { test, expect } from '@inluxc/propmaster';

test('[TC-ZZ-001] does a thing', { tag: ['@TC-ZZ-001'] }, async () => {
    await test.step('Step 1: Do it', async () => {
        expect(1).toBe(1);
    });
});
`;

test.describe('check-tests — findTests', () => {
    test('finds test, test.only/skip/fixme/fail and ignores describe, step and comments', () => {
        const src = `
            // test('[TC-ZZ-009] commented out', async () => {});
            /* test('[TC-ZZ-009] block comment', async () => {}); */
            const s = "test('[TC-ZZ-009] in a string', async () => {})";
            test.describe('group', () => {
                test('a', async () => {});
                test.only('b', async () => {});
                test.skip('c', async () => {});
                test.fixme('d', async () => {});
                test.fail('e', async () => {});
                test.step('not a test', async () => {});
                mytest('not a test', async () => {});
            });
        `;
        expect(findTests(src).map((t) => t.title)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    test('ignores test.skip() conditions without a title literal', () => {
        expect(findTests(`test.skip(!process.env.CI, 'needs CI');`)).toEqual([]);
        expect(findTests(`test.skip();`)).toEqual([]);
    });

    test('splits options and body even when they contain commas and nested brackets', () => {
        const [t] = findTests(`test('[TC-ZZ-001] x', { tag: ['@TC-ZZ-001', '@smoke'], annotation: { type: 'a, b' } }, async ({ page }) => {
            const arr = [1, 2, (3, 4)];
            await test.step('s', async () => {});
        });`);
        expect(t.options).toContain("'@TC-ZZ-001'");
        expect(t.options).toContain("'@smoke'");
        expect(t.body).toContain('test.step');
        expect(t.dynamic).toBe(false);
    });

    test('marks template-literal titles with interpolation as dynamic', () => {
        const [a, b] = findTests('test(`[${c.id}] x`, async () => {}); test(`[TC-ZZ-001] plain`, async () => {});');
        expect(a.dynamic).toBe(true);
        expect(b.dynamic).toBe(false);
        expect(b.title).toBe('[TC-ZZ-001] plain');
    });
});

test.describe('check-tests — rules', () => {
    test('a well-formed test passes', () => {
        expect(checkSources([spec(GOOD)]).violations).toEqual([]);
    });

    test('reports missing ID, missing tag and missing steps', () => {
        expect(rules([spec(`test('no id', async () => {});`)])).toEqual(['tc-id', 'test-step']);
        expect(rules([spec(`test('[TC-ZZ-001] no tag', async () => { await test.step('s', async () => {}); });`)])).toEqual(['tc-tag']);
        expect(
            rules([spec(`test('[TC-ZZ-001] wrong tag', { tag: ['@TC-ZZ-002'] }, async () => { await test.step('s', async () => {}); });`)]),
        ).toEqual(['tc-tag']);
    });

    test('accepts a *Steps class instead of test.step()', () => {
        const src = `test('[TC-ZZ-001] x', { tag: ['@TC-ZZ-001'] }, async ({ databaseClient }) => {
            const db = new DatabaseSteps(databaseClient);
            await db.query('SELECT 1');
        });`;
        expect(rules([spec(src)])).toEqual([]);
    });

    test('reports the line of the offending test', () => {
        const [v] = checkSources([spec(`\n\n\ntest('bad', { tag: ['@x'] }, async () => { await test.step('s', async () => {}); });`)]).violations;
        expect(v).toMatchObject({ file: 'tests/specs/a.spec.ts', line: 4, rule: 'tc-id', test: 'bad' });
    });
});

test.describe('check-tests — dynamic titles', () => {
    test('a parameterized title with an ID expression and matching tag passes', () => {
        const src = `for (const c of cases) {
            test(\`[\${c.id}] renders at \${c.width}px\`, { tag: [\`@\${c.id}\`] }, async ({ page }) => {
                await test.step('Step 1: Render', async () => {});
            });
        }`;
        expect(rules([spec(src)])).toEqual([]);
    });

    test('a parameterized title must start with an ID expression', () => {
        const src = 'test(`renders at ${w}px`, { tag: [`@${w}`] }, async () => { await test.step("s", async () => {}); });';
        expect(rules([spec(src)])).toEqual(['tc-id']);
    });

    test('a parameterized test must tag the same ID expression', () => {
        const src = 'test(`[${c.id}] x`, { tag: ["@smoke"] }, async () => { await test.step("s", async () => {}); });';
        expect(rules([spec(src)])).toEqual(['tc-tag']);
    });

    test('IDs in data rows of parameterized files are reserved for next-id', () => {
        const src = `const cases = [{ id: 'TC-ZZ-007' }, { id: 'TC-ZZ-008' }];
            for (const c of cases) test(\`[\${c.id}] x\`, { tag: [\`@\${c.id}\`] }, async () => { await test.step('s', async () => {}); });`;
        const { ids, violations } = checkSources([spec(src)]);
        expect(violations).toEqual([]);
        expect(nextIds('ZZ', ids)).toEqual(['TC-ZZ-009']);
    });
});

test.describe('check-tests — duplicates', () => {
    test('reports every reuse of an ID across files, pointing at all locations', () => {
        const { violations } = checkSources([spec(GOOD, 'tests/specs/a.spec.ts'), spec(GOOD, 'tests/specs/b.spec.ts'), spec(GOOD, 'tests/specs/c.spec.ts')]);
        expect(violations.map((v) => [v.rule, v.file])).toEqual([
            ['tc-unique', 'tests/specs/b.spec.ts'],
            ['tc-unique', 'tests/specs/c.spec.ts'],
        ]);
        expect(violations[0].message).toContain('tests/specs/a.spec.ts:4');
    });

    test('mentions in exempt files reserve IDs but are not duplicates', () => {
        const exempt: SourceInput = { file: 'tests/unit/x.spec.ts', content: `'TC-ZZ-001' 'TC-ZZ-001' 'TC-ZZ-005'`, kind: 'exempt' };
        const { violations, ids } = checkSources([spec(GOOD), exempt]);
        expect(violations).toEqual([]);
        expect(nextIds('ZZ', ids)).toEqual(['TC-ZZ-006']);
    });

    test('doc samples never count as duplicates of real tests', () => {
        const doc: SourceInput = { file: 'AGENTS.md', content: '```typescript\n' + GOOD + '```\n', kind: 'doc' };
        expect(checkSources([spec(GOOD), doc]).violations).toEqual([]);
    });
});

test.describe('check-tests — placeholders', () => {
    const PLACEHOLDER = `test('[TC-ZZ-NNN] x', { tag: ['@TC-ZZ-NNN'] }, async () => { await test.step('s', async () => {}); });`;

    test('placeholder IDs are rejected in test files with a next-id hint', () => {
        const [v] = checkSources([spec(PLACEHOLDER)]).violations;
        expect(v.rule).toBe('tc-id');
        expect(v.message).toContain('npm run next-id -- ZZ');
    });

    test('TC-XXX-NNN placeholder hints at a category', () => {
        const [v] = checkSources([spec(PLACEHOLDER.replaceAll('ZZ', 'XXX'))]).violations;
        expect(v.message).toContain('next-id -- <CATEGORY>');
    });

    test('placeholder IDs are allowed in doc code samples, but the tag must still match', () => {
        const doc = (code: string): SourceInput => ({ file: 'SKILLS.md', content: `# Title\n\n\`\`\`ts\n${code}\n\`\`\`\n`, kind: 'doc' });
        expect(rules([doc(PLACEHOLDER)])).toEqual([]);
        expect(rules([doc(PLACEHOLDER.replace(`{ tag: ['@TC-ZZ-NNN'] }, `, ''))])).toEqual(['tc-tag']);
    });

    test('doc violations report the markdown line', () => {
        const content = '# T\n\ntext\n\n```typescript\n\ntest(\'no id\', async () => {});\n```\n';
        const [v] = checkSources([{ file: 'AGENTS.md', content, kind: 'doc' }]).violations;
        expect(v).toMatchObject({ file: 'AGENTS.md', line: 7 });
    });

    test('non-ts code blocks in docs are ignored', () => {
        const content = "```bash\ntest('no id', async () => {});\n```\n";
        expect(checkSources([{ file: 'AGENTS.md', content, kind: 'doc' }]).violations).toEqual([]);
    });
});

test.describe('check-tests — @playwright/test imports', () => {
    const body = GOOD.replace("import { test, expect } from '@inluxc/propmaster';", '');

    test('value imports are rejected in spec files', () => {
        expect(rules([spec(`import { test, expect } from '@playwright/test';\n${body}`)])).toEqual(['import']);
        expect(rules([spec(`import { expect } from "@playwright/test";\n${body}`)])).toEqual(['import']);
    });

    test('type-only imports are allowed', () => {
        expect(rules([spec(`import type { Page, Locator } from '@playwright/test';\n${body}`)])).toEqual([]);
        expect(rules([spec(`import type {\n    Page,\n} from '@playwright/test';\n${body}`)])).toEqual([]);
    });

    test('the import rule applies to other test suffixes but not to *.prop.ts', () => {
        const src = `import { test } from '@playwright/test';\n${body}`;
        expect(rules([spec(src, 'tests/specs/home.browser.ts')])).toEqual(['import']);
        expect(rules([spec(src, 'tests/properties/x.prop.ts')])).toEqual([]);
    });

    test('the violation points at the import line', () => {
        const [v] = checkSources([spec(`// header\n\nimport { test } from '@playwright/test';\n${body}`)]).violations;
        expect(v).toMatchObject({ rule: 'import', line: 3 });
    });
});

test.describe('check-tests — next-id', () => {
    test('starts at 001 and pads to three digits', () => {
        expect(nextIds('ZZ', [])).toEqual(['TC-ZZ-001']);
        expect(nextIds('ZZ', [{ id: 'TC-ZZ-099', category: 'ZZ', num: 99, file: 'f', line: 1 }], 2)).toEqual(['TC-ZZ-100', 'TC-ZZ-101']);
    });

    test('only considers the requested category', () => {
        const { ids } = checkSources([spec(GOOD)]);
        expect(nextIds('ZZ', ids)).toEqual(['TC-ZZ-002']);
        expect(nextIds('YY', ids)).toEqual(['TC-YY-001']);
    });
});

test.describe('check-tests — project config and files', () => {
    let root: string;

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-check-'));
    });

    test.afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const write = (rel: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    };

    test('defaults apply without package.json or a propmaster key', () => {
        expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
        write('package.json', '{"name":"x"}');
        expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
    });

    test('reads dirs, suffixes and docs from package.json', () => {
        write(
            'package.json',
            JSON.stringify({
                propmaster: { testDirs: ['tests/specs'], testFileSuffixes: ['.spec.ts', '.browser.ts'], exemptDirs: ['tests/specs/legacy'], docFiles: ['GUIDE.md'] },
            }),
        );
        write('tests/specs/ok.browser.ts', GOOD);
        write('tests/specs/bad.spec.ts', `test('no id', async () => {});`);
        write('tests/specs/legacy/old.spec.ts', `test('no id', async () => {});`);
        write('tests/other/ignored.spec.ts', `test('no id', async () => {});`);
        write('GUIDE.md', "```ts\ntest('doc no id', async () => { await test.step('s', async () => {}); });\n```\n");
        write('AGENTS.md', "```ts\ntest('not configured', async () => {});\n```\n");

        const config = loadConfig(root);
        expect(config.exemptDirs).toEqual(['tests/specs/legacy/']);
        const { violations, ids } = collect(root, config);
        expect(violations.map((v) => `${v.file}:${v.rule}`).sort()).toEqual([
            'GUIDE.md:tc-id',
            'tests/specs/bad.spec.ts:tc-id',
            'tests/specs/bad.spec.ts:test-step',
        ]);
        expect(ids.map((e) => e.id)).toEqual(['TC-ZZ-001']);
    });

    test('rejects a malformed propmaster config', () => {
        write('package.json', JSON.stringify({ propmaster: { testDirs: 'tests' } }));
        expect(() => loadConfig(root)).toThrow(/propmaster\.testDirs/);
    });

    test('a missing test directory is not an error', () => {
        expect(collect(root, { ...DEFAULT_CONFIG, testDirs: ['nope'] })).toEqual({ violations: [], ids: [] });
    });
});
