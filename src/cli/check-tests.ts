/**
 * Test convention checker — `propmaster check` / `propmaster next-id`.
 *
 * Enforces the conventions taught in AGENTS.md so humans and AI agents get
 * fast, machine-readable feedback instead of relying on prose rules:
 *
 *   tc-id        every test title starts with `[TC-XXX-NNN]`
 *   tc-tag       every test has `{ tag: ['@TC-XXX-NNN'] }` matching its title ID
 *   tc-unique    every TestCaseID is unique across the whole suite
 *   test-step    every test body uses `test.step()` (directly or via a *Steps class)
 *   import       test files import `test`/`expect` from the framework, never `@playwright/test`
 *
 * Zero dependencies on purpose: TypeScript 7 ships no JS compiler API, so the
 * scanner is a small hand-written tokenizer that understands strings,
 * template literals, comments and bracket nesting — enough to find `test(...)`
 * calls and split their arguments.
 *
 * This module has no side effects; the CLI entry point is `init.ts`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Checker settings. Read from the `propmaster` key of the project's
 * `package.json`; every field is optional and falls back to the defaults.
 *
 * ```json
 * "propmaster": {
 *   "testDirs": ["tests"],
 *   "testFileSuffixes": [".spec.ts", ".prop.ts"],
 *   "exemptDirs": ["tests/unit/", "tests/properties/"],
 *   "docFiles": ["AGENTS.md", "SKILLS.md"]
 * }
 * ```
 */
export interface CheckConfig {
    /** Directories (relative to the project root) scanned for test files. */
    testDirs: string[];
    /** File-name suffixes that mark a test file. */
    testFileSuffixes: string[];
    /**
     * Directory prefixes whose test files are exempt from the TestCaseID /
     * step / import / uniqueness rules (framework self-tests). IDs mentioned
     * in them are still reserved, so `next-id` never hands them out.
     */
    exemptDirs: string[];
    /** Markdown files whose ```ts code samples must also follow the conventions. */
    docFiles: string[];
}

export const DEFAULT_CONFIG: CheckConfig = {
    testDirs: ['tests'],
    testFileSuffixes: ['.spec.ts', '.prop.ts'],
    exemptDirs: ['tests/unit/', 'tests/properties/'],
    docFiles: ['AGENTS.md', 'SKILLS.md'],
};

function stringArray(value: unknown, key: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new Error(`package.json "propmaster.${key}" must be an array of strings.`);
    }
    return value;
}

/** Merges the `propmaster` key of `<root>/package.json` over the defaults. */
export function loadConfig(root: string): CheckConfig {
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) return { ...DEFAULT_CONFIG };
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { propmaster?: Record<string, unknown> };
    const raw = pkg.propmaster ?? {};
    const keys = Object.keys(DEFAULT_CONFIG) as (keyof CheckConfig)[];
    const config = { ...DEFAULT_CONFIG };
    for (const key of keys) {
        const value = stringArray(raw[key], key);
        if (value) config[key] = value;
    }
    // Normalise exempt dirs to a trailing slash so `tests/unit` can't match `tests/unit-extra`.
    config.exemptDirs = config.exemptDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
    return config;
}

/** Walks up from `start` to the nearest directory containing a package.json. */
export function findProjectRoot(start: string = process.cwd()): string {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return resolve(start);
        dir = parent;
    }
}

// ─── Source scanning ────────────────────────────────────────────────────────

const CATEGORY = '[A-Z][A-Z0-9]{1,5}';
const ID_RE = new RegExp(`^\\[(TC-(${CATEGORY})-(\\d{3,}))\\]`);
const PLACEHOLDER_ID_RE = new RegExp(`^\\[(TC-(${CATEGORY}|XXX)-(N{3,}))\\]`);
const ANY_ID_RE = new RegExp(`TC-(${CATEGORY})-(\\d{3,})`, 'g');
const CATEGORY_RE = new RegExp(`^${CATEGORY}$`);
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail']);

/** Returns the index just past a string/template/comment starting at `i`, or -1. */
export function skipNonCode(src: string, i: number): number {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
        const end = src.indexOf('\n', i);
        return end === -1 ? src.length : end;
    }
    if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        return end === -1 ? src.length : end + 2;
    }
    if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) {
            if (src[j] === '\\') j++;
            else if (src[j] === '\n') break;
            j++;
        }
        return j + 1;
    }
    if (c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== '`') {
            if (src[j] === '\\') j += 2;
            else if (src[j] === '$' && src[j + 1] === '{') j = matchClose(src, j + 1) + 1;
            else j++;
        }
        return j + 1;
    }
    return -1;
}

/** Given `src[open]` is `(`, `[` or `{`, returns the index of its matching closer. */
export function matchClose(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; ) {
        const skipped = skipNonCode(src, i);
        if (skipped !== -1) {
            i = skipped;
            continue;
        }
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return src.length - 1;
}

/** Splits the text between parens into top-level comma-separated arguments. */
export function splitArgs(src: string, open: number, close: number): string[] {
    const args: string[] = [];
    let start = open + 1;
    for (let i = open + 1; i < close; ) {
        const skipped = skipNonCode(src, i);
        if (skipped !== -1) {
            i = skipped;
            continue;
        }
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') {
            i = matchClose(src, i) + 1;
            continue;
        }
        if (c === ',') {
            args.push(src.slice(start, i));
            start = i + 1;
        }
        i++;
    }
    const last = src.slice(start, close);
    if (last.trim()) args.push(last);
    return args;
}

/**
 * Parses a title literal ('..', "..", or `..`). `dynamic` is true for template
 * literals with `${...}` interpolation (parameterized tests generated in a
 * loop). Returns null when the argument is not a literal.
 */
function titleLiteral(text: string): { title: string; dynamic: boolean } | null {
    const m = /^(['"`])([\s\S]*)\1$/.exec(text.trim());
    if (!m) return null;
    return { title: m[2], dynamic: m[1] === '`' && m[2].includes('${') };
}

export interface FoundTest {
    /** Offset of the `test` token in the source. */
    index: number;
    title: string;
    /** True when the title is a template literal with interpolation. */
    dynamic: boolean;
    /** Source text of the options argument (`{ tag: [...] }`), if present. */
    options: string | null;
    /** Source text of the test body (last argument). */
    body: string;
}

/**
 * Finds every test declaration: `test(...)` or `test.only|skip|fixme|fail(...)`
 * whose first argument is a string literal (the title) and that has a body.
 */
export function findTests(src: string): FoundTest[] {
    const tests: FoundTest[] = [];
    for (let i = 0; i < src.length; ) {
        const skipped = skipNonCode(src, i);
        if (skipped !== -1) {
            i = skipped;
            continue;
        }
        if (src.startsWith('test', i) && !/[\w$.]/.test(src[i - 1] ?? '')) {
            const m = /^test(?:\.(\w+))?\s*\(/.exec(src.slice(i, i + 40));
            if (m && (!m[1] || TEST_MODIFIERS.has(m[1]))) {
                const open = i + m[0].length - 1;
                const close = matchClose(src, open);
                const args = splitArgs(src, open, close);
                const lit = args.length >= 2 ? titleLiteral(args[0]) : null;
                if (lit !== null) {
                    tests.push({
                        index: i,
                        title: lit.title,
                        dynamic: lit.dynamic,
                        options: args.length >= 3 ? args[1] : null,
                        body: args[args.length - 1],
                    });
                }
                i = open + 1;
                continue;
            }
        }
        i++;
    }
    return tests;
}

export function lineOf(src: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
    return line;
}

/** Returns `{ code, lineOffset }` for each ```ts / ```typescript block in a markdown file. */
export function codeBlocks(md: string): { code: string; lineOffset: number }[] {
    const blocks: { code: string; lineOffset: number }[] = [];
    // `[^\S\n]*` (not `\s*`) so leading blank lines stay in the block and line numbers stay right.
    const re = /^```(?:ts|typescript)[^\S\n]*\n([\s\S]*?)^```/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
        blocks.push({ code: m[1], lineOffset: lineOf(md, m.index) });
    }
    return blocks;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

export type Rule = 'tc-id' | 'tc-tag' | 'tc-unique' | 'test-step' | 'import';

export interface Violation {
    file: string;
    line: number;
    rule: Rule;
    message: string;
    /** Title of the offending test, when the violation is about one test. */
    test?: string;
}

export interface IdEntry {
    id: string;
    category: string;
    num: number;
    file: string;
    line: number;
    /** True when the ID was only seen in an exempt file (reserved, not a test). */
    reserved?: boolean;
}

export interface CheckResult {
    violations: Violation[];
    ids: IdEntry[];
}

/** One source to check: a test file, or a markdown doc whose code samples are checked. */
export interface SourceInput {
    file: string;
    content: string;
    kind: 'test' | 'exempt' | 'doc';
}

const STEP_MESSAGE =
    "Body must be broken into `await test.step('Step N: ...', async () => { ... })` blocks (or use a *Steps class).";

function checkTest(
    t: FoundTest,
    ctx: { file: string; line: number; isDoc: boolean; violations: Violation[]; ids: IdEntry[] },
): void {
    const { file, line, isDoc, violations, ids } = ctx;
    const report = (rule: Rule, message: string) => violations.push({ file, line, rule, test: t.title, message });
    const hasStep = /\.step\s*\(|\w+Steps\b/.test(t.body);

    // Parameterized test (title built from a template literal, e.g. inside a
    // for-loop): the ID must come from the test data so each generated test
    // gets its own. It can't be resolved statically, so check the shape only.
    if (t.dynamic) {
        const idExprMatch = /^\[\$\{([^}]+)\}\]/.exec(t.title);
        if (!idExprMatch) {
            report(
                'tc-id',
                'Parameterized test title must start with "[${...}]" — give each case its own ID in the test data, e.g. `{ id: \'TC-BRW-012\', ... }`.',
            );
        } else {
            const idExpr = idExprMatch[1].trim();
            const tagged = t.options !== null && t.options.includes('tag') && t.options.includes(idExpr);
            if (!tagged) report('tc-tag', `Missing \`{ tag: [\`@\${${idExpr}}\`] }\` as the second argument to test().`);
        }
        if (!hasStep) report('test-step', STEP_MESSAGE);
        return;
    }

    const real = ID_RE.exec(t.title);
    const placeholder = PLACEHOLDER_ID_RE.exec(t.title);
    let id: string | null = null;

    if (real) {
        id = real[1];
        if (!isDoc) ids.push({ id, category: real[2], num: Number(real[3]), file, line });
    } else if (placeholder && isDoc) {
        id = placeholder[1];
    } else if (placeholder) {
        const category = placeholder[2] === 'XXX' ? '<CATEGORY>' : placeholder[2];
        report('tc-id', `Placeholder ID "${placeholder[1]}" left in title — run \`npm run next-id -- ${category}\` and use the printed ID.`);
    } else {
        report('tc-id', 'Title must start with "[TC-XXX-NNN]" — run `npm run next-id -- <CATEGORY>` to get a free ID.');
    }

    if (id) {
        const tagged = t.options !== null && new RegExp(`['"\`]@${id}['"\`]`).test(t.options);
        if (!tagged) report('tc-tag', `Missing \`{ tag: ['@${id}'] }\` as the second argument to test().`);
    }

    if (!hasStep) report('test-step', STEP_MESSAGE);
}

/** Value (non-type-only) import of `@playwright/test`. */
const PLAYWRIGHT_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]@playwright\/test['"]/m;

/**
 * Checks a set of in-memory sources. Pure: no filesystem access, so it is the
 * unit-testable core of {@link collect}.
 */
export function checkSources(sources: SourceInput[]): CheckResult {
    const violations: Violation[] = [];
    const ids: IdEntry[] = [];

    for (const { file, content: src, kind } of sources) {
        if (kind === 'exempt') {
            // Self-tests reserve any IDs they mention, so next-id skips them.
            for (const m of src.matchAll(ANY_ID_RE)) {
                ids.push({ id: m[0], category: m[1], num: Number(m[2]), file, line: lineOf(src, m.index ?? 0), reserved: true });
            }
            continue;
        }

        if (kind === 'doc') {
            for (const block of codeBlocks(src)) {
                for (const t of findTests(block.code)) {
                    const line = block.lineOffset + lineOf(block.code, t.index);
                    checkTest(t, { file, line, isDoc: true, violations, ids });
                }
            }
            continue;
        }

        // Test files need the framework's fixture-registered `test`. Type-only
        // imports are fine, and property tests (*.prop.ts) use no fixtures.
        const importMatch = file.endsWith('.prop.ts') ? null : PLAYWRIGHT_VALUE_IMPORT.exec(src);
        if (importMatch) {
            violations.push({
                file,
                line: lineOf(src, importMatch.index + importMatch[0].search(/\S/)),
                rule: 'import',
                message:
                    "Import `test`/`expect` from the framework ('@inluxc/propmaster'), not '@playwright/test' — the framework's test object has the fixtures registered. `import type { ... } from '@playwright/test'` is fine.",
            });
        }

        const tests = findTests(src);
        for (const t of tests) {
            checkTest(t, { file, line: lineOf(src, t.index), isDoc: false, violations, ids });
        }

        // Parameterized tests keep their IDs in data rows, which can't be tied
        // to a test statically. Reserve every ID mentioned in such files so
        // next-id never hands one of them out again.
        if (tests.some((t) => t.dynamic)) {
            for (const m of src.matchAll(ANY_ID_RE)) {
                ids.push({ id: m[0], category: m[1], num: Number(m[2]), file, line: lineOf(src, m.index ?? 0), reserved: true });
            }
        }
    }

    // Uniqueness — an ID may be used by at most one test. Mentions in exempt
    // files only reserve numbers for next-id (they are often sample strings in
    // self-tests, not tests), so they never count as a collision.
    const byId = new Map<string, IdEntry[]>();
    for (const entry of ids) {
        if (entry.reserved) continue;
        const list = byId.get(entry.id) ?? [];
        list.push(entry);
        byId.set(entry.id, list);
    }
    for (const [id, entries] of byId) {
        if (entries.length < 2) continue;
        const where = entries.map((e) => `${e.file}:${e.line}`).join(', ');
        for (const e of entries.slice(1)) {
            violations.push({ file: e.file, line: e.line, rule: 'tc-unique', message: `${id} is already used (${where}).` });
        }
    }

    return { violations, ids };
}

// ─── Files ──────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

/** Reads the project's test files and docs and checks them. */
export function collect(root: string, config: CheckConfig = loadConfig(root)): CheckResult {
    const rel = (p: string) => relative(root, p).split(sep).join('/');
    const sources: SourceInput[] = [];
    const seen = new Set<string>();

    for (const dir of config.testDirs) {
        for (const full of walk(join(root, dir))) {
            const file = rel(full);
            if (seen.has(file) || !config.testFileSuffixes.some((s) => file.endsWith(s))) continue;
            seen.add(file);
            const exempt = config.exemptDirs.some((d) => file.startsWith(d));
            sources.push({ file, content: readFileSync(full, 'utf8'), kind: exempt ? 'exempt' : 'test' });
        }
    }

    for (const doc of config.docFiles) {
        const full = join(root, doc);
        if (existsSync(full)) sources.push({ file: doc, content: readFileSync(full, 'utf8'), kind: 'doc' });
    }

    return checkSources(sources);
}

/** Returns the next `count` free IDs in `category`. */
export function nextIds(category: string, ids: IdEntry[], count = 1): string[] {
    const max = ids.filter((e) => e.category === category).reduce((m, e) => Math.max(m, e.num), 0);
    return Array.from({ length: count }, (_, n) => `TC-${category}-${String(max + 1 + n).padStart(3, '0')}`);
}

// ─── CLI commands ───────────────────────────────────────────────────────────

/** `propmaster check [--json] [--list-ids] [--root <dir>]`. Returns the exit code. */
export function runCheck(argv: string[]): number {
    const root = rootFrom(argv);
    const { violations, ids } = collect(root);

    if (argv.includes('--list-ids')) {
        const sorted = [...ids].sort((a, b) => a.category.localeCompare(b.category) || a.num - b.num);
        for (const e of sorted) console.log(`${e.id}\t${e.file}:${e.line}${e.reserved ? '\t(reserved)' : ''}`);
        return 0;
    }

    if (argv.includes('--json')) {
        console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
        return violations.length ? 1 : 0;
    }

    if (violations.length === 0) {
        const inUse = new Set(ids.filter((e) => !e.reserved).map((e) => e.id)).size;
        console.log(`✓ Test conventions OK (${inUse} TestCaseIDs in use)`);
        return 0;
    }
    for (const v of violations) {
        const name = v.test ? ` "${v.test}"` : '';
        console.log(`${v.file}:${v.line}  [${v.rule}]${name}\n    ${v.message}`);
    }
    console.log(`\n✗ ${violations.length} test convention violation(s). See AGENTS.md → "Test Case ID Convention".`);
    return 1;
}

/** `propmaster next-id <CATEGORY> [count] [--root <dir>]`. Returns the exit code. */
export function runNextId(argv: string[]): number {
    const positional = withoutRoot(argv).filter((a) => !a.startsWith('--'));
    const category = (positional[0] ?? '').toUpperCase();
    if (!CATEGORY_RE.test(category)) {
        console.error('Usage: propmaster next-id <CATEGORY> [count]   (e.g. API, DB, KFK, RDS, MDB, NEO, GQL, BRW, APM, GDS, OTP)');
        return 2;
    }
    const count = Math.max(1, Math.floor(Number(positional[1])) || 1);
    const { ids } = collect(rootFrom(argv));
    for (const id of nextIds(category, ids, count)) console.log(id);
    return 0;
}

function rootFrom(argv: string[]): string {
    const i = argv.indexOf('--root');
    return i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : findProjectRoot();
}

function withoutRoot(argv: string[]): string[] {
    const i = argv.indexOf('--root');
    return i === -1 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)];
}
