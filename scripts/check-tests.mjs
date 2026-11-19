#!/usr/bin/env node
/**
 * Test convention checker.
 *
 * Enforces the conventions in AGENTS.md so humans and AI agents get fast,
 * machine-readable feedback instead of relying on prose rules:
 *
 *   tc-id        every test title starts with `[TC-XXX-NNN]`
 *   tc-tag       every test has `{ tag: ['@TC-XXX-NNN'] }` matching its title ID
 *   tc-unique    every TestCaseID is unique across the whole suite
 *   test-step    every test body uses `test.step()` (directly or via a *Steps class)
 *   import       spec files import `test`/`expect` from the framework, never `@playwright/test`
 *
 * Usage:
 *   node scripts/check-tests.mjs                 # check specs + docs, human output
 *   node scripts/check-tests.mjs --json          # machine-readable output
 *   node scripts/check-tests.mjs --next-id API   # print the next free ID, e.g. TC-API-005
 *   node scripts/check-tests.mjs --list-ids      # print every ID in use with its location
 *
 * Exit code is 1 when any violation is found.
 *
 * Zero dependencies on purpose: TypeScript 7 ships no JS compiler API, and the
 * checker must run before `npm ci` finishes compiling anything.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Test files subject to the conventions. */
const TEST_DIR = 'tests';
const TEST_FILE = /\.(spec|prop)\.ts$/;

/**
 * Framework self-tests (unit + property tests of the framework internals) are
 * exempt from the TestCaseID / step rules. Their IDs, if any, still count for
 * uniqueness.
 */
const EXEMPT_DIRS = ['tests/unit/', 'tests/properties/'];

/** Agent-facing docs whose code samples must also follow the conventions. */
const DOC_FILES = ['AGENTS.md', 'SKILLS.md'];

const ID_RE = /^\[(TC-([A-Z][A-Z0-9]{1,5})-(\d{3,}))\]/;
const PLACEHOLDER_ID_RE = /^\[(TC-([A-Z][A-Z0-9]{1,5}|XXX)-(N{3,}))\]/;
const ANY_ID_RE = /TC-([A-Z][A-Z0-9]{1,5})-(\d{3,})/g;
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail']);

// ─── Source scanning ────────────────────────────────────────────────────────

/** Returns the index just past a string/template/comment starting at `i`, or -1. */
function skipNonCode(src, i) {
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
function matchClose(src, open) {
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
function splitArgs(src, open, close) {
    const args = [];
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
            args.push({ text: src.slice(start, i), start });
            start = i + 1;
        }
        i++;
    }
    const last = src.slice(start, close);
    if (last.trim()) args.push({ text: last, start });
    return args;
}

/**
 * Parses a title literal ('..', "..", or `..`). Returns `{ title, dynamic }`,
 * where `dynamic` is true for template literals with `${...}` interpolation
 * (parameterized tests generated in a loop), or null if not a literal.
 */
function titleLiteral(text) {
    const t = text.trim();
    const m = /^(['"`])([\s\S]*)\1$/.exec(t);
    if (!m) return null;
    return { title: m[2], dynamic: m[1] === '`' && m[2].includes('${') };
}

/**
 * Finds every test declaration: `test(...)` or `test.only|skip|fixme|fail(...)`
 * whose first argument is a string literal (the title).
 */
function findTests(src) {
    const tests = [];
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
                const lit = args.length >= 2 ? titleLiteral(args[0].text) : null;
                if (lit !== null) {
                    tests.push({
                        index: i,
                        title: lit.title,
                        dynamic: lit.dynamic,
                        options: args.length >= 3 ? args[1].text : null,
                        body: args[args.length - 1].text,
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

function lineOf(src, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
    return line;
}

// ─── Files ──────────────────────────────────────────────────────────────────

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

/** Returns `{ code, lineOffset }` for each ```ts / ```typescript block in a markdown file. */
function codeBlocks(md) {
    const blocks = [];
    const re = /^```(?:ts|typescript)\s*\n([\s\S]*?)^```/gm;
    let m;
    while ((m = re.exec(md))) {
        blocks.push({ code: m[1], lineOffset: lineOf(md, m.index) });
    }
    return blocks;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

function checkTest(t, { file, line, isDoc, violations, ids }) {
    const report = (rule, message) => violations.push({ file, line, rule, test: t.title, message });
    const hasStep = /\.step\s*\(|\w+Steps\b/.test(t.body);
    const stepMessage = "Body must be broken into `await test.step('Step N: ...', async () => { ... })` blocks (or use a *Steps class from src/steps).";

    // Parameterized test (title built from a template literal, e.g. inside a
    // for-loop): the ID must come from the test data so each generated test
    // gets its own. We can't resolve it statically, so check the shape only.
    if (t.dynamic) {
        if (!/^\[\$\{[^}]+\}\]/.test(t.title)) {
            report('tc-id', 'Parameterized test title must start with "[${...}]" — give each case its own ID in the test data, e.g. `{ id: \'TC-BRW-012\', ... }`.');
        } else {
            const idExpr = /^\[\$\{([^}]+)\}\]/.exec(t.title)[1].trim();
            const tagged = t.options && t.options.includes('tag') && t.options.includes(idExpr);
            if (!tagged) report('tc-tag', `Missing \`{ tag: [\`@\${${idExpr}}\`] }\` as the second argument to test().`);
        }
        if (!hasStep) report('test-step', stepMessage);
        return;
    }

    const real = ID_RE.exec(t.title);
    const placeholder = PLACEHOLDER_ID_RE.exec(t.title);
    let id = null;

    if (real) {
        id = real[1];
        if (!isDoc) ids.push({ id, category: real[2], num: Number(real[3]), file, line });
    } else if (placeholder && isDoc) {
        id = placeholder[1];
    } else if (placeholder) {
        report('tc-id', `Placeholder ID "${placeholder[1]}" left in title — run \`npm run next-id -- ${placeholder[2] === 'XXX' ? '<CATEGORY>' : placeholder[2]}\` and use the printed ID.`);
    } else {
        report('tc-id', 'Title must start with "[TC-XXX-NNN]" — run `npm run next-id -- <CATEGORY>` to get a free ID.');
    }

    if (id) {
        const tagged = t.options && new RegExp(`['"\`]@${id}['"\`]`).test(t.options);
        if (!tagged) {
            report('tc-tag', `Missing \`{ tag: ['@${id}'] }\` as the second argument to test().`);
        }
    }

    if (!hasStep) report('test-step', stepMessage);
}

function collect() {
    const violations = [];
    const ids = [];

    const files = walk(join(ROOT, TEST_DIR)).filter((f) => TEST_FILE.test(f));
    for (const full of files) {
        const file = rel(full);
        const src = readFileSync(full, 'utf8');
        const exempt = EXEMPT_DIRS.some((d) => file.startsWith(d));

        if (exempt) {
            // Self-tests still reserve any IDs they use.
            for (const m of src.matchAll(ANY_ID_RE)) {
                ids.push({ id: m[0], category: m[1], num: Number(m[2]), file, line: lineOf(src, m.index) });
            }
            continue;
        }

        // Spec files need the framework's fixture-registered `test`. Type-only
        // imports are fine, and property tests (*.prop.ts) use no fixtures.
        const importMatch = file.endsWith('.spec.ts')
            ? /^\s*import\s+(?!type\b)[^;]*?from\s+['"]@playwright\/test['"]/m.exec(src)
            : null;
        if (importMatch) {
            violations.push({
                file,
                line: lineOf(src, importMatch.index),
                rule: 'import',
                message: "Import `test`/`expect` from the framework (e.g. '../../src'), not '@playwright/test' — the framework's test object has the fixtures registered.",
            });
        }

        for (const t of findTests(src)) {
            checkTest(t, { file, line: lineOf(src, t.index), isDoc: false, violations, ids });
        }
    }

    for (const doc of DOC_FILES) {
        let md;
        try {
            md = readFileSync(join(ROOT, doc), 'utf8');
        } catch {
            continue;
        }
        for (const block of codeBlocks(md)) {
            for (const t of findTests(block.code)) {
                const line = block.lineOffset + lineOf(block.code, t.index);
                checkTest(t, { file: doc, line, isDoc: true, violations, ids });
            }
        }
    }

    // Uniqueness — an ID may appear in at most one test.
    const byId = new Map();
    for (const entry of ids) {
        if (!byId.has(entry.id)) byId.set(entry.id, []);
        byId.get(entry.id).push(entry);
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

// ─── CLI ────────────────────────────────────────────────────────────────────

function nextId(category, ids) {
    const max = ids.filter((e) => e.category === category).reduce((m, e) => Math.max(m, e.num), 0);
    return `TC-${category}-${String(max + 1).padStart(3, '0')}`;
}

function main(argv) {
    const { violations, ids } = collect();

    const nextIdx = argv.indexOf('--next-id');
    if (nextIdx !== -1) {
        const category = (argv[nextIdx + 1] ?? '').toUpperCase();
        if (!/^[A-Z][A-Z0-9]{1,5}$/.test(category)) {
            console.error('Usage: npm run next-id -- <CATEGORY>   (e.g. API, DB, KFK, RDS, MDB, NEO, GQL, BRW, MOB, OTP)');
            return 2;
        }
        const count = Math.max(1, Number(argv[nextIdx + 2]) || 1);
        const first = Number(nextId(category, ids).split('-')[2]);
        for (let n = 0; n < count; n++) {
            console.log(`TC-${category}-${String(first + n).padStart(3, '0')}`);
        }
        return 0;
    }

    if (argv.includes('--list-ids')) {
        const sorted = [...ids].sort((a, b) => a.category.localeCompare(b.category) || a.num - b.num);
        for (const e of sorted) console.log(`${e.id}\t${e.file}:${e.line}`);
        return 0;
    }

    if (argv.includes('--json')) {
        console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
        return violations.length ? 1 : 0;
    }

    if (violations.length === 0) {
        console.log(`✓ Test conventions OK (${ids.length} TestCaseIDs in use)`);
        return 0;
    }
    for (const v of violations) {
        const name = v.test ? ` "${v.test}"` : '';
        console.log(`${v.file}:${v.line}  [${v.rule}]${name}\n    ${v.message}`);
    }
    console.log(`\n✗ ${violations.length} test convention violation(s). See AGENTS.md → "Test Case ID Convention".`);
    return 1;
}

process.exitCode = main(process.argv.slice(2));
