/**
 * QA standards: a team's own testing rules, in two halves.
 *
 * - Pages: Markdown files in `standards/`, written by the team. The MCP server
 *   hands them to agents (the `standards` tool and `standards://` resources),
 *   so they are read before tests are written.
 * - Rules: `propmaster.standards.json`, checked by `propmaster check` (and so
 *   `lint:tests`, `check_tests` and doctor) as `standard:<id>` violations.
 *   Each rule is an error or a warning and can point at the page that
 *   explains it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FoundTest, Violation } from './check-tests.js';

export const STANDARDS_FILE = 'propmaster.standards.json';
export const DEFAULT_PAGES_DIR = 'standards';

export const RULE_TYPES = ['required-tag', 'title-pattern', 'describe-pattern', 'banned-call', 'banned-pattern', 'max-steps', 'min-steps', 'requirements-doc'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export interface StandardRule {
    /** Short kebab-case name: violations are reported as `standard:<id>`. */
    id: string;
    type: RuleType;
    /** `error` (default) fails the check; `warn` is reported only. */
    level?: 'error' | 'warn';
    /** The page that explains the rule, relative to the pages folder (`tagging.md`, `tagging.md#owners`). */
    page?: string;
    /** Replaces the default message. */
    message?: string;
    /** Only test files under these paths (e.g. `tests/e2e/`). Default: every test file. */
    files?: string[];
    /** Not test files under these paths. */
    exclude?: string[];
    /** required-tag: a tag on the test or its describe must match. title-pattern / describe-pattern / banned-pattern: the text to match. A RegExp source. */
    pattern?: string;
    /** required-tag: an example shown in the message, e.g. `@owner-payments`. */
    example?: string;
    /** banned-call: calls not allowed, e.g. `page.waitForTimeout`, `test.only`. */
    calls?: string[];
    /** max-steps / min-steps. */
    max?: number;
    min?: number;
}

export interface Standards {
    /** The pages folder, relative to the project root. */
    pages: string;
    rules: StandardRule[];
}

export interface LoadedStandards {
    standards: Standards | null;
    /** Problems with the file itself: each fails the check. */
    problems: string[];
}

/** Loads and validates `propmaster.standards.json`. No file: `standards: null`, no problems. */
export function loadStandards(root: string): LoadedStandards {
    const file = join(root, STANDARDS_FILE);
    if (!existsSync(file)) return { standards: null, problems: [] };
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
        return { standards: null, problems: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    return validateStandards(raw, root);
}

/** Checks a parsed standards file. `root`, when given, is used to check that pages exist. */
export function validateStandards(raw: unknown, root?: string): LoadedStandards {
    const problems: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { standards: null, problems: ['must be an object with a "rules" array'] };
    const obj = raw as Record<string, unknown>;
    const pages = obj.pages === undefined ? DEFAULT_PAGES_DIR : obj.pages;
    if (typeof pages !== 'string') problems.push('"pages" must be a folder name');
    if (!Array.isArray(obj.rules)) return { standards: null, problems: [...problems, '"rules" must be an array'] };
    const rules: StandardRule[] = [];
    const seen = new Set<string>();
    obj.rules.forEach((r, i) => {
        const at = `rules[${i}]`;
        if (!r || typeof r !== 'object') return problems.push(`${at} must be an object`);
        const rule = r as StandardRule;
        const name = typeof rule.id === 'string' ? `"${rule.id}"` : at;
        if (typeof rule.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) return problems.push(`${at}: "id" must be kebab-case, e.g. "owner-tag"`);
        if (seen.has(rule.id)) return problems.push(`${name} is listed twice`);
        seen.add(rule.id);
        if (!RULE_TYPES.includes(rule.type)) return problems.push(`${name}: "type" must be one of ${RULE_TYPES.join(', ')}`);
        if (rule.level !== undefined && rule.level !== 'error' && rule.level !== 'warn') problems.push(`${name}: "level" must be "error" or "warn"`);
        for (const key of ['files', 'exclude'] as const) {
            if (rule[key] !== undefined && (!Array.isArray(rule[key]) || !rule[key]!.every((f) => typeof f === 'string'))) problems.push(`${name}: "${key}" must be an array of paths`);
        }
        const needsPattern = ['required-tag', 'title-pattern', 'describe-pattern', 'banned-pattern'].includes(rule.type);
        if (needsPattern) {
            if (typeof rule.pattern !== 'string') problems.push(`${name}: a ${rule.type} rule needs "pattern"`);
            else {
                try {
                    new RegExp(rule.pattern);
                } catch (error) {
                    problems.push(`${name}: "pattern" isn't a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        if (rule.type === 'banned-call' && (!Array.isArray(rule.calls) || !rule.calls.length || !rule.calls.every((c) => typeof c === 'string' && /^[\w$]+(?:\.[\w$]+)*$/.test(c)))) {
            problems.push(`${name}: a banned-call rule needs "calls", e.g. ["page.waitForTimeout"]`);
        }
        if (rule.type === 'max-steps' && !(Number.isInteger(rule.max) && rule.max! > 0)) problems.push(`${name}: a max-steps rule needs "max", a positive whole number`);
        if (rule.type === 'min-steps' && !(Number.isInteger(rule.min) && rule.min! > 0)) problems.push(`${name}: a min-steps rule needs "min", a positive whole number`);
        if (rule.page !== undefined) {
            if (typeof rule.page !== 'string') problems.push(`${name}: "page" must be a file in the pages folder`);
            else if (root && typeof pages === 'string' && !existsSync(join(root, pages, rule.page.split('#')[0]))) problems.push(`${name}: page ${pages}/${rule.page.split('#')[0]} not found`);
        }
        rules.push(rule);
    });
    return { standards: { pages: typeof pages === 'string' ? pages : DEFAULT_PAGES_DIR, rules }, problems };
}

// ─── Reading tests ──────────────────────────────────────────────────────────

/** Source with comments and string contents blanked out (same length, newlines kept), so code searches skip them. */
export function maskNonCode(src: string, skipNonCode: (src: string, i: number) => number): string {
    let out = '';
    for (let i = 0; i < src.length; ) {
        const end = skipNonCode(src, i);
        if (end === -1) {
            out += src[i++];
            continue;
        }
        const chunk = src.slice(i, end);
        // Keep the quotes of strings and templates so `x('a')` still looks like a call.
        out += chunk.length >= 2 && /^['"`]/.test(chunk) ? chunk[0] + chunk.slice(1, -1).replace(/[^\n]/g, ' ') + chunk[chunk.length - 1] : chunk.replace(/[^\n]/g, ' ');
        i = end;
    }
    return out;
}

export interface FoundDescribe {
    index: number;
    title: string;
    options: string | null;
    /** The span of its argument list: tests inside it are between these offsets. */
    open: number;
    close: number;
}

/** Tags in an options argument (`{ tag: ['@a', '@b'] }` or `{ tag: '@a' }`) and in a title. */
export function tagsOf(options: string | null, title: string): string[] {
    const tags = [...(options ?? '').matchAll(/['"`](@[^'"`\s]+)['"`]/g)].map((m) => m[1]);
    for (const m of title.matchAll(/(?:^|\s)(@[\w-]+)/g)) tags.push(m[1]);
    return tags;
}

/** The `/** ... *\/` comment right before `index`, if any. */
export function precedingDoc(src: string, index: number): string | null {
    let i = index - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    // Allow `export` or `const x =` style prefixes on the same statement? Tests start with `test(`, so no.
    if (src.slice(i - 1, i + 1) !== '*/') return null;
    const start = src.lastIndexOf('/**', i);
    return start === -1 ? null : src.slice(start, i + 1);
}

// ─── Checking ───────────────────────────────────────────────────────────────

export interface StandardsInput {
    file: string;
    src: string;
    tests: FoundTest[];
    describes: FoundDescribe[];
    lineOf: (index: number) => number;
    masked: string;
}

function applies(rule: StandardRule, file: string): boolean {
    if (rule.files?.length && !rule.files.some((f) => file.startsWith(f.replace(/^\.\//, '')))) return false;
    if (rule.exclude?.some((f) => file.startsWith(f.replace(/^\.\//, '')))) return false;
    return true;
}

const ID_PREFIX = /^\[[^\]]*\]\s*/;

/** Checks one test file against the rules. Returns errors and warnings. */
export function checkStandards(standards: Standards, input: StandardsInput): { errors: Violation[]; warnings: Violation[] } {
    const errors: Violation[] = [];
    const warnings: Violation[] = [];
    const { file, src, tests, describes, lineOf, masked } = input;
    const enclosing = (t: FoundTest) => describes.filter((d) => d.open < t.index && t.index < d.close);

    for (const rule of standards.rules) {
        if (!applies(rule, file)) continue;
        const where = rule.page ? ` See ${standards.pages}/${rule.page}.` : '';
        const report = (line: number, message: string, test?: string) =>
            (rule.level === 'warn' ? warnings : errors).push({ file, line, rule: `standard:${rule.id}`, message: `${rule.message ?? message}${where}`, ...(test ? { test } : {}) });

        switch (rule.type) {
            case 'required-tag': {
                const re = new RegExp(rule.pattern!);
                for (const t of tests) {
                    const tags = [...tagsOf(t.options, t.title), ...enclosing(t).flatMap((d) => tagsOf(d.options, d.title))];
                    if (!tags.some((tag) => re.test(tag))) report(lineOf(t.index), `Needs a tag matching /${rule.pattern}/${rule.example ? `, e.g. '${rule.example}'` : ''} (on the test or its describe).`, t.title);
                }
                break;
            }
            case 'title-pattern': {
                const re = new RegExp(rule.pattern!);
                for (const t of tests) {
                    if (t.dynamic) continue;
                    const title = t.title.replace(ID_PREFIX, '');
                    if (!re.test(title)) report(lineOf(t.index), `Title "${title}" doesn't match /${rule.pattern}/ (checked without the [TC-...] prefix).`, t.title);
                }
                break;
            }
            case 'describe-pattern': {
                const re = new RegExp(rule.pattern!);
                for (const d of describes) if (!re.test(d.title)) report(lineOf(d.index), `Describe "${d.title}" doesn't match /${rule.pattern}/.`);
                break;
            }
            case 'banned-call': {
                for (const call of rule.calls!) {
                    const re = new RegExp(`(?<![\\w$.])${call.replace(/[.$]/g, (c) => `\\${c}`)}\\s*\\(`, 'g');
                    for (const m of masked.matchAll(re)) report(lineOf(m.index!), `\`${call}()\` isn't allowed here.`);
                }
                break;
            }
            case 'banned-pattern': {
                const re = new RegExp(rule.pattern!, 'g');
                for (const m of src.matchAll(re)) report(lineOf(m.index!), `"${m[0].slice(0, 60)}" matches /${rule.pattern}/, which isn't allowed.`);
                break;
            }
            case 'max-steps':
            case 'min-steps': {
                for (const t of tests) {
                    const steps = (t.body.match(/\.step\s*\(/g) ?? []).length;
                    if (rule.type === 'max-steps' && steps > rule.max!) report(lineOf(t.index), `Has ${steps} steps; at most ${rule.max} (split the test, or move steps into a *Steps class).`, t.title);
                    if (rule.type === 'min-steps' && steps < rule.min! && !/\w+Steps\b/.test(t.body)) report(lineOf(t.index), `Has ${steps} step${steps === 1 ? '' : 's'}; at least ${rule.min}.`, t.title);
                }
                break;
            }
            case 'requirements-doc': {
                const fileDoc = /^\s*\/\*\*[\s\S]*?@requirements\b[\s\S]*?\*\//.test(src);
                for (const t of tests) {
                    if (fileDoc) break;
                    const docs = [precedingDoc(src, t.index), ...enclosing(t).map((d) => precedingDoc(src, d.index))];
                    if (!docs.some((d) => d && /@requirements\b/.test(d))) {
                        report(lineOf(t.index), 'Needs a `/** @requirements ... */` comment: on the test, its describe, or at the top of the file.', t.title);
                    }
                }
                break;
            }
        }
    }
    return { errors, warnings };
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export interface StandardsPage {
    /** File name in the pages folder, e.g. `tagging.md`. */
    file: string;
    /** Its first `# heading`, else the file name. */
    title: string;
    /** Its first paragraph. */
    summary: string;
}

/** The pages in the standards folder (`.md` files, sorted, README first). */
export function listPages(root: string, folder: string = loadStandards(root).standards?.pages ?? DEFAULT_PAGES_DIR): StandardsPage[] {
    const dir = join(root, folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort((a, b) => (a.toLowerCase() === 'readme.md' ? -1 : b.toLowerCase() === 'readme.md' ? 1 : a.localeCompare(b)))
        .map((file) => {
            const text = readFileSync(join(dir, file), 'utf-8');
            const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? file;
            const summary = text
                .split(/\n\s*\n/)
                .map((p) => p.trim())
                .find((p) => p && !p.startsWith('#') && !p.startsWith('```') && !p.startsWith('|')) ?? '';
            return { file, title, summary: summary.replace(/\s+/g, ' ').slice(0, 300) };
        });
}

/** A page's text, or undefined when there's no such page. Only files directly in the pages folder. */
export function readPage(root: string, file: string, folder: string = loadStandards(root).standards?.pages ?? DEFAULT_PAGES_DIR): string | undefined {
    const name = file.split('#')[0];
    if (!/^[\w.-]+\.md$/.test(name)) return undefined;
    const full = join(root, folder, name);
    return existsSync(full) ? readFileSync(full, 'utf-8') : undefined;
}

// ─── Sample set ─────────────────────────────────────────────────────────────

export const SAMPLE_STANDARDS = {
    pages: DEFAULT_PAGES_DIR,
    rules: [
        { id: 'owner-tag', type: 'required-tag', pattern: '^@owner-[a-z0-9-]+$', example: '@owner-payments', page: 'tagging.md#owners' },
        { id: 'priority-tag', type: 'required-tag', pattern: '^@p[0-3]$', example: '@p1', level: 'warn', page: 'tagging.md#priority' },
        { id: 'title-style', type: 'title-pattern', pattern: '^[a-z0-9/]', level: 'warn', page: 'writing-tests.md#titles' },
        { id: 'no-fixed-waits', type: 'banned-call', calls: ['page.waitForTimeout', 'page.pause', 'test.only', 'test.describe.only'], page: 'writing-tests.md#waiting' },
        { id: 'step-limit', type: 'max-steps', max: 12, level: 'warn', page: 'writing-tests.md#steps' },
        { id: 'traceability', type: 'requirements-doc', level: 'warn', page: 'traceability.md' },
    ],
} satisfies { pages: string; rules: StandardRule[] };

export const SAMPLE_PAGES: Record<string, string> = {
    'README.md': `# Testing standards

How this team writes tests. Agents read these pages (through the propmaster MCP server) before writing tests; \`propmaster check\` enforces the rules in \`${STANDARDS_FILE}\`, and each rule links back here.

| Page | What it covers |
|---|---|
| [Writing tests](./writing-tests.md) | Titles, steps, waiting |
| [Tagging](./tagging.md) | Owner and priority tags |
| [Traceability](./traceability.md) | Linking tests to requirements |

Change these pages and the rules to fit the team: they are examples to start from.
`,
    'writing-tests.md': `# Writing tests

Every test reads as a short story: what is being checked, in steps, with nothing left to chance.

## Titles

After the \`[TC-XXX-NNN]\` ID, a title is a lowercase sentence saying what should happen: \`[TC-API-012] an order with no items is refused\`. Not "test 1", not "should work".

## Steps

Break the body into \`test.step()\` blocks named \`Step N: <verb phrase>\`. More than about a dozen steps means the test checks too much: split it, or move shared steps into a \`*Steps\` class.

## Waiting

Never sleep. \`page.waitForTimeout()\` hides races and slows the suite; wait for what the test needs instead: \`expect(locator).toBeVisible()\`, \`waitForMessage\`, \`waitForRow\`, \`waitForObject\`. Don't commit \`page.pause()\` or \`test.only\`.
`,
    'tagging.md': `# Tagging

Tags let us run, route and report on tests by who owns them and how much they matter.

## Owners

Every test has an owner tag, \`@owner-<team>\`, on the test or its \`test.describe\`: \`{ tag: ['@TC-API-012', '@owner-payments'] }\`. When a test fails or flakes, the owner fixes it.

## Priority

\`@p0\` blocks a release, \`@p1\` blocks a merge, \`@p2\` and \`@p3\` are reported only. Missing a priority is a warning for now.
`,
    'traceability.md': `# Traceability

A test says which requirement it covers, so a changed requirement leads to its tests.

Put a \`/** @requirements REQ-123 */\` comment on the test, on its \`test.describe\`, or at the top of the file:

\`\`\`ts
/** @requirements PAY-42 Refunds go back to the original card */
test.describe('Refunds', () => {
    // ...
});
\`\`\`
`,
};

/** Writes the sample standards file and pages. Never overwrites; returns what was written and what already existed. */
export function initStandards(root: string): { written: string[]; skipped: string[] } {
    const written: string[] = [];
    const skipped: string[] = [];
    const files: Record<string, string> = {
        [STANDARDS_FILE]: `${JSON.stringify(SAMPLE_STANDARDS, null, 4)}\n`,
        ...Object.fromEntries(Object.entries(SAMPLE_PAGES).map(([f, c]) => [`${DEFAULT_PAGES_DIR}/${f}`, c])),
    };
    for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        if (existsSync(full)) {
            skipped.push(rel);
            continue;
        }
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content, 'utf-8');
        written.push(rel);
    }
    return { written, skipped };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `
  Usage:
    npx propmaster standards [list] [--json]
    npx propmaster standards init

  list   The rules in ${STANDARDS_FILE} and the pages in its pages folder.
  init   Write a sample ${STANDARDS_FILE} and standards/ pages to start from
         (owner and priority tags, title style, no fixed waits, a step limit,
         traceability). Never overwrites a file.

  \`propmaster check\` enforces the rules: an "error" rule fails it, a "warn"
  rule is reported. Agents read the pages through the MCP server.
`;

/** `propmaster standards ...` */
export function runStandards(argv: string[], root: string, log: (line?: string) => void = console.log): number {
    const sub = argv.find((a) => !a.startsWith('-')) ?? 'list';
    if (argv.includes('--help') || sub === 'help') {
        log(HELP);
        return 0;
    }
    if (sub === 'init') {
        const { written, skipped } = initStandards(root);
        for (const f of written) log(`  ✓ Created ${f}`);
        for (const f of skipped) log(`  · Skipped ${f} (already exists)`);
        log('');
        log(`  Edit the pages and rules to fit the team. \`npx propmaster check\` now enforces them.`);
        return 0;
    }
    if (sub !== 'list') {
        log(HELP);
        return 2;
    }
    const { standards, problems } = loadStandards(root);
    const pages = listPages(root, standards?.pages);
    if (argv.includes('--json')) {
        log(JSON.stringify({ file: STANDARDS_FILE, problems, rules: standards?.rules ?? [], pages }, null, 2));
        return problems.length ? 1 : 0;
    }
    if (!standards && !problems.length) {
        log(`  No ${STANDARDS_FILE}. \`npx propmaster standards init\` writes a sample to start from.`);
        return 0;
    }
    for (const p of problems) log(`  ✖ ${STANDARDS_FILE}: ${p}`);
    if (standards) {
        log(`  Rules (${STANDARDS_FILE}):`);
        for (const r of standards.rules) log(`    ${(r.level ?? 'error').padEnd(5)}  ${r.id.padEnd(18)} ${r.type}${r.page ? `  → ${standards.pages}/${r.page}` : ''}`);
        log('');
        log(`  Pages (${standards.pages}/):`);
        for (const p of pages) log(`    ${p.file.padEnd(22)} ${p.title}`);
        if (!pages.length) log('    none');
    }
    return problems.length ? 1 : 0;
}
