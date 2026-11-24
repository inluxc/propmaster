/**
 * Code-coverage reports the project (or the application it tests, in any
 * language) already writes. Read as they are, never generated: each tool's
 * own test run writes them. The layer comes from the path
 * (`coverage/e2e/lcov.info` → e2e), else unit.
 *
 *   LCOV              lcov.info: Istanbul/nyc, c8, Jest, Vitest, coverage.py, gcov/lcov, grcov, cargo-llvm-cov, tarpaulin, Dart, Elixir (excoveralls)
 *   Istanbul summary  coverage-summary.json
 *   Cobertura         cobertura*.xml, coverage.xml: coverage.py, coverlet (.NET), gcovr, tarpaulin, gocover-cobertura, Kover, PHPUnit
 *   JaCoCo            jacoco*.xml: Java, Kotlin, Scala, Groovy (also Kover)
 *   Clover            clover.xml: PHPUnit, OpenClover, Istanbul
 *   OpenCover         *.opencover.xml, opencover*.xml: .NET (coverlet, OpenCover)
 *   Go cover profile  coverage.out, cover.out, *.coverprofile (`go test -coverprofile`)
 *   coverage.py JSON  coverage.json (`coverage json`)
 *   SimpleCov         .resultset.json (Ruby)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { Layer } from './inventory.js';

export type CoverageFormat = 'lcov' | 'istanbul-summary' | 'cobertura' | 'jacoco' | 'clover' | 'opencover' | 'go' | 'coverage-py' | 'simplecov';

/** What the main ratio counts: lines, or statements (Go, coverage.py, Clover, OpenCover sequence points). */
export type Measure = 'lines' | 'statements';

export interface Ratio {
    covered: number;
    total: number;
    /** Percent, one decimal; null when there is nothing to cover. */
    pct: number | null;
}

export interface FileCoverage {
    file: string;
    lines: Ratio;
}

export interface CodeCoverageReport {
    /** Relative to the project root. */
    path: string;
    format: CoverageFormat;
    layer: Layer;
    /** What `lines` counts. */
    measure: Measure;
    /** When the report was written (file mtime). */
    writtenAt: string;
    lines: Ratio;
    branches?: Ratio;
    functions?: Ratio;
    files: number;
    /** The least-covered files (by uncovered lines), worst first; generated and vendored code left out. */
    lowest: FileCoverage[];
}

const ratio = (covered: number, total: number): Ratio => ({ covered, total, pct: total ? Math.round((covered / total) * 1000) / 10 : null });

const sum = (files: Array<{ covered: number; total: number }>) => files.reduce((a, f) => ({ covered: a.covered + f.covered, total: a.total + f.total }), { covered: 0, total: 0 });

// ─── Parsers (pure) ─────────────────────────────────────────────────────────

interface Parsed {
    measure?: Measure;
    lines: Ratio;
    branches?: Ratio;
    functions?: Ratio;
    files: FileCoverage[];
}

export function parseLcov(text: string): Parsed {
    const files: Array<{ file: string; lf: number; lh: number; brf: number; brh: number; fnf: number; fnh: number }> = [];
    let current: (typeof files)[number] | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const [key, value = ''] = line.split(/:(.*)/s, 2);
        if (key === 'SF') current = { file: value, lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
        else if (!current) continue;
        else if (key === 'LF') current.lf = Number(value) || 0;
        else if (key === 'LH') current.lh = Number(value) || 0;
        else if (key === 'BRF') current.brf = Number(value) || 0;
        else if (key === 'BRH') current.brh = Number(value) || 0;
        else if (key === 'FNF') current.fnf = Number(value) || 0;
        else if (key === 'FNH') current.fnh = Number(value) || 0;
        else if (line === 'end_of_record') {
            files.push(current);
            current = undefined;
        }
    }
    const lines = sum(files.map((f) => ({ covered: f.lh, total: f.lf })));
    const branches = sum(files.map((f) => ({ covered: f.brh, total: f.brf })));
    const functions = sum(files.map((f) => ({ covered: f.fnh, total: f.fnf })));
    return {
        lines: ratio(lines.covered, lines.total),
        ...(branches.total ? { branches: ratio(branches.covered, branches.total) } : {}),
        ...(functions.total ? { functions: ratio(functions.covered, functions.total) } : {}),
        files: files.map((f) => ({ file: f.file, lines: ratio(f.lh, f.lf) })),
    };
}

type IstanbulMetric = { total?: number; covered?: number };
type IstanbulEntry = { lines?: IstanbulMetric; branches?: IstanbulMetric; functions?: IstanbulMetric };

export function parseIstanbulSummary(text: string): Parsed {
    const data = JSON.parse(text) as Record<string, IstanbulEntry>;
    const r = (m?: IstanbulMetric) => (m && typeof m.total === 'number' ? ratio(m.covered ?? 0, m.total) : undefined);
    const files = Object.entries(data)
        .filter(([k]) => k !== 'total')
        .map(([file, e]) => ({ file, lines: r(e.lines) ?? ratio(0, 0) }));
    const total = data.total ?? {};
    const lines = r(total.lines) ?? (() => {
        const s = sum(files.map((f) => f.lines));
        return ratio(s.covered, s.total);
    })();
    const branches = r(total.branches);
    const functions = r(total.functions);
    return { lines, ...(branches ? { branches } : {}), ...(functions ? { functions } : {}), files };
}

const attr = (tag: string, name: string): string | undefined => new RegExp(String.raw`\b${name}="([^"]*)"`).exec(tag)?.[1];

export function parseCobertura(text: string): Parsed {
    const root = /<coverage\b[^>]*>/.exec(text)?.[0] ?? '';
    const files: FileCoverage[] = [];
    for (const m of text.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
        const file = attr(m[1], 'filename') ?? attr(m[1], 'name') ?? '?';
        const hits = [...m[2].matchAll(/<line\b[^>]*\bhits="(\d+)"/g)].map((h) => Number(h[1]));
        const prev = files.find((f) => f.file === file);
        const covered = hits.filter((h) => h > 0).length;
        if (prev) prev.lines = ratio(prev.lines.covered + covered, prev.lines.total + hits.length);
        else files.push({ file, lines: ratio(covered, hits.length) });
    }
    const valid = Number(attr(root, 'lines-valid'));
    const covered = Number(attr(root, 'lines-covered'));
    const s = sum(files.map((f) => f.lines));
    const lines = Number.isFinite(valid) && valid > 0 ? ratio(covered || 0, valid) : ratio(s.covered, s.total);
    const bValid = Number(attr(root, 'branches-valid'));
    const branches = Number.isFinite(bValid) && bValid > 0 ? ratio(Number(attr(root, 'branches-covered')) || 0, bValid) : undefined;
    return { lines, ...(branches ? { branches } : {}), files };
}

export function parseJacoco(text: string): Parsed {
    const counter = (block: string, type: string): Ratio | undefined => {
        // The report's own counters are the last ones, after every package.
        const all = [...block.matchAll(new RegExp(String.raw`<counter\s+type="${type}"\s+missed="(\d+)"\s+covered="(\d+)"\s*/>`, 'g'))];
        const last = all[all.length - 1];
        return last ? ratio(Number(last[2]), Number(last[1]) + Number(last[2])) : undefined;
    };
    const files: FileCoverage[] = [];
    for (const pkg of text.matchAll(/<package\s+name="([^"]*)"\s*>([\s\S]*?)<\/package>/g)) {
        for (const src of pkg[2].matchAll(/<sourcefile\s+name="([^"]*)"\s*>([\s\S]*?)<\/sourcefile>/g)) {
            const lines = counter(src[2], 'LINE');
            if (lines) files.push({ file: pkg[1] ? `${pkg[1]}/${src[1]}` : src[1], lines });
        }
    }
    const tail = text.slice(text.lastIndexOf('</package>') + 1);
    const lines = counter(tail, 'LINE') ?? (() => {
        const s = sum(files.map((f) => f.lines));
        return ratio(s.covered, s.total);
    })();
    const branches = counter(tail, 'BRANCH');
    const functions = counter(tail, 'METHOD');
    return { lines, ...(branches ? { branches } : {}), ...(functions ? { functions } : {}), files };
}

/** `go test -coverprofile`: `file:start.col,end.col statements count` per block; statements covered over statements. */
export function parseGoProfile(text: string): Parsed {
    const blocks = new Map<string, { file: string; n: number; count: number }>();
    for (const line of text.split(/\r?\n/)) {
        const m = /^(.+):(\d+\.\d+,\d+\.\d+)\s+(\d+)\s+(\d+)$/.exec(line.trim());
        if (!m) continue;
        // With -coverpkg the same block comes once per test binary: it's covered if any covered it.
        const key = `${m[1]}:${m[2]}`;
        const prev = blocks.get(key);
        const count = Number(m[4]);
        if (prev) prev.count = Math.max(prev.count, count);
        else blocks.set(key, { file: m[1], n: Number(m[3]), count });
    }
    const byFile = new Map<string, { covered: number; total: number }>();
    for (const b of blocks.values()) {
        const f = byFile.get(b.file) ?? { covered: 0, total: 0 };
        f.total += b.n;
        if (b.count > 0) f.covered += b.n;
        byFile.set(b.file, f);
    }
    const s = sum([...byFile.values()]);
    return { measure: 'statements', lines: ratio(s.covered, s.total), files: [...byFile].map(([file, f]) => ({ file, lines: ratio(f.covered, f.total) })) };
}

type PyTotals = { covered_lines?: number; num_statements?: number; num_branches?: number; covered_branches?: number };

/** coverage.py's `coverage json`. */
export function parseCoveragePy(text: string): Parsed {
    const data = JSON.parse(text) as { totals?: PyTotals; files?: Record<string, { summary?: PyTotals }> };
    const t = data.totals ?? {};
    const files = Object.entries(data.files ?? {}).map(([file, f]) => ({ file, lines: ratio(f.summary?.covered_lines ?? 0, f.summary?.num_statements ?? 0) }));
    const s = sum(files.map((f) => f.lines));
    return {
        measure: 'statements',
        lines: typeof t.num_statements === 'number' ? ratio(t.covered_lines ?? 0, t.num_statements) : ratio(s.covered, s.total),
        ...(t.num_branches ? { branches: ratio(t.covered_branches ?? 0, t.num_branches) } : {}),
        files,
    };
}

/**
 * Clover XML (PHPUnit, OpenClover, Istanbul). Each file's own `<metrics>` has
 * the exact statement, method and condition counts (Istanbul writes one
 * `<line>` per source line, not per statement); PHPUnit's per-class metrics
 * inside the file are skipped. Without metrics, the `<line type="stmt">` rows are counted.
 */
export function parseClover(text: string): Parsed {
    const files: FileCoverage[] = [];
    const methods = { covered: 0, total: 0 };
    const conditions = { covered: 0, total: 0 };
    for (const m of text.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
        const file = attr(m[1], 'path') ?? attr(m[1], 'name') ?? '?';
        const body = m[2].replace(/<class\b[\s\S]*?<\/class>/g, '');
        const all = [...body.matchAll(/<metrics\b[^>]*>/g)].map((x) => x[0]);
        const metrics = all.find((x) => /\bloc="/.test(x)) ?? all[0];
        const n = (name: string) => Number(attr(metrics ?? '', name));
        if (metrics && Number.isFinite(n('statements'))) {
            files.push({ file, lines: ratio(n('coveredstatements') || 0, n('statements')) });
            if (Number.isFinite(n('methods'))) {
                methods.total += n('methods');
                methods.covered += n('coveredmethods') || 0;
            }
            if (Number.isFinite(n('conditionals'))) {
                conditions.total += n('conditionals');
                conditions.covered += n('coveredconditionals') || 0;
            }
            continue;
        }
        let covered = 0;
        let total = 0;
        for (const line of body.matchAll(/<line\b[^>]*>/g)) {
            const type = attr(line[0], 'type');
            const count = Number(attr(line[0], 'count') ?? 0);
            if (type === 'stmt') {
                total++;
                if (count > 0) covered++;
            } else if (type === 'method') {
                methods.total++;
                if (count > 0) methods.covered++;
            }
        }
        files.push({ file, lines: ratio(covered, total) });
    }
    const s = sum(files.map((f) => f.lines));
    return {
        measure: 'statements',
        lines: ratio(s.covered, s.total),
        ...(conditions.total ? { branches: ratio(conditions.covered, conditions.total) } : {}),
        ...(methods.total ? { functions: ratio(methods.covered, methods.total) } : {}),
        files,
    };
}

/** OpenCover XML (.NET): sequence points visited, per file. */
export function parseOpenCover(text: string): Parsed {
    const names = new Map<string, string>();
    for (const m of text.matchAll(/<File\b[^>]*\buid="(\d+)"[^>]*\bfullPath="([^"]*)"/g)) names.set(m[1], m[2]);
    const byFile = new Map<string, { covered: number; total: number }>();
    for (const m of text.matchAll(/<SequencePoint\b[^>]*>/g)) {
        const id = attr(m[0], 'fileid') ?? '?';
        const f = byFile.get(id) ?? { covered: 0, total: 0 };
        f.total++;
        if (Number(attr(m[0], 'vc') ?? 0) > 0) f.covered++;
        byFile.set(id, f);
    }
    const summary = /<CoverageSession\b[\s\S]*?<Summary\b[^>]*>/.exec(text)?.[0].match(/<Summary\b[^>]*>/)?.[0] ?? '';
    const files = [...byFile].map(([id, f]) => ({ file: names.get(id) ?? id, lines: ratio(f.covered, f.total) }));
    const s = sum(files.map((f) => f.lines));
    const points = Number(attr(summary, 'numSequencePoints'));
    const branches = Number(attr(summary, 'numBranchPoints'));
    return {
        measure: 'statements',
        lines: points > 0 ? ratio(Number(attr(summary, 'visitedSequencePoints')) || 0, points) : ratio(s.covered, s.total),
        ...(branches > 0 ? { branches: ratio(Number(attr(summary, 'visitedBranchPoints')) || 0, branches) } : {}),
        files,
    };
}

/** SimpleCov's `.resultset.json` (Ruby): a hit count or null per line, per file, per test suite (merged). */
export function parseSimpleCov(text: string): Parsed {
    const data = JSON.parse(text) as Record<string, { coverage?: Record<string, { lines?: Array<number | null> } | Array<number | null>> }>;
    const merged = new Map<string, Array<number | null>>();
    for (const suite of Object.values(data)) {
        for (const [file, entry] of Object.entries(suite.coverage ?? {})) {
            const lines = Array.isArray(entry) ? entry : entry.lines ?? [];
            const prev = merged.get(file);
            merged.set(file, prev ? lines.map((h, i) => (h === null && prev[i] === null ? null : Math.max(h ?? 0, prev[i] ?? 0))) : lines);
        }
    }
    const files = [...merged].map(([file, lines]) => {
        const relevant = lines.filter((h): h is number => h !== null);
        return { file, lines: ratio(relevant.filter((h) => h > 0).length, relevant.length) };
    });
    const s = sum(files.map((f) => f.lines));
    return { lines: ratio(s.covered, s.total), files };
}

// ─── Finding reports ────────────────────────────────────────────────────────

export function formatOf(path: string, head: string): CoverageFormat | null {
    const name = basename(path).toLowerCase();
    if (name.endsWith('.info') || name === 'lcov.dat') return 'lcov';
    if (name === 'coverage-summary.json') return 'istanbul-summary';
    if (name === '.resultset.json') return 'simplecov';
    if (name.endsWith('.json')) return /"totals"\s*:/.test(head) || /"meta"\s*:\s*\{[^}]*"version"/.test(head) ? 'coverage-py' : null;
    if (/^mode:\s*(set|count|atomic)\b/.test(head.trimStart())) return 'go';
    if (name.endsWith('.xml')) {
        if (/<CoverageSession\b/.test(head)) return 'opencover';
        if (/<report\b/.test(head)) return 'jacoco';
        if (/<coverage\b/.test(head)) return /<project\b|\bclover="/.test(head) && !/\bline-rate="/.test(head) ? 'clover' : 'cobertura';
    }
    return null;
}

/** The layer a report's path names, else unit (an application's own coverage run is usually its unit tests). */
export function layerOfReport(path: string): Layer {
    const p = path.toLowerCase().split(/[\\/]/);
    if (p.some((s) => /^(e2e|ui|browser|playwright|cypress|acceptance)$/.test(s) || /[-_.]e2e\b/.test(s))) return 'e2e';
    if (p.some((s) => /^(integration|it|integration-tests?)$/.test(s) || /[-_.](integration|it)[-_.]/.test(s))) return 'integration';
    return 'unit';
}

const SKIP = new Set(['node_modules', '.git', 'dist', '.propmaster', 'test-results', 'playwright-report', 'blob-report']);
const CANDIDATE =
    /^(lcov\.info|lcov\.dat|[\w.-]*\.lcov\.info|coverage-summary\.json|coverage\.json|\.resultset\.json|[\w.-]*cobertura[\w.-]*\.xml|coverage\.xml|jacoco[\w.-]*\.xml|clover\.xml|[\w.-]*opencover[\w.-]*\.xml|coverage\.out|cover\.out|c\.out|[\w.-]+\.coverprofile)$/i;
/** Several formats from one run (Istanbul writes lcov.info, clover.xml and coverage-summary.json side by side): the first of these per folder. */
const PREFERENCE = [/lcov/i, /coverage-summary\.json$/i, /cobertura|^coverage\.xml$/i, /jacoco/i, /opencover/i, /clover/i, /./];
const MAX_DEPTH = 6;

/** Report files under `root`, relative, at most MAX_DEPTH folders down. */
export function findCoverageReports(root: string, dir = root, depth = 0, out: string[] = []): string[] {
    if (depth > MAX_DEPTH) return out;
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        if (SKIP.has(name) || (name.startsWith('.') && name !== '.resultset.json')) continue;
        const full = join(dir, name);
        let isDir = false;
        try {
            isDir = statSync(full).isDirectory();
        } catch {
            continue;
        }
        if (isDir) findCoverageReports(root, full, depth + 1, out);
        else if (CANDIDATE.test(name)) out.push(relative(root, full).split(sep).join('/'));
    }
    return depth === 0 ? onePerFolder(out) : out;
}

function onePerFolder(paths: string[]): string[] {
    const byDir = new Map<string, string[]>();
    for (const p of paths) {
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
    }
    const rank = (p: string) => PREFERENCE.findIndex((re) => re.test(basename(p)));
    return [...byDir.values()].flatMap((group) => {
        const best = Math.min(...group.map(rank));
        // Same format twice in a folder (lcov.info for two packages): keep both.
        return group.filter((p) => rank(p) === best);
    }).sort();
}

/**
 * Generated and third-party code: it counts in the totals, as the tool
 * reported it, but isn't worth a test, so it stays out of the least-covered list.
 */
const GENERATED =
    /(?:^|\/)(?:node_modules|vendor|third_party|generated|gen-src|__generated__|Migrations)\/|\.(?:pb|pb\.gw|pb\.validate)\.go$|_pb2(?:_grpc)?\.py$|\.(?:g|designer|generated|AssemblyInfo)\.cs$|(?:_generated|\.gen|_gen|_string|_mock|mock_[\w]+)\.go$|\.generated\.\w+$|\.d\.ts$/i;

export function isGenerated(file: string): boolean {
    return GENERATED.test(file.split('\\').join('/'));
}

export const NOT_A_REPORT = 'not a coverage report Propmaster reads (LCOV, Istanbul summary, Cobertura, JaCoCo, Clover, OpenCover, Go cover profile, coverage.py JSON, SimpleCov)';

const PARSERS: Record<CoverageFormat, (text: string) => Parsed> = {
    lcov: parseLcov,
    'istanbul-summary': parseIstanbulSummary,
    cobertura: parseCobertura,
    jacoco: parseJacoco,
    clover: parseClover,
    opencover: parseOpenCover,
    go: parseGoProfile,
    'coverage-py': parseCoveragePy,
    simplecov: parseSimpleCov,
};

const MAX_REPORT_BYTES = 50 * 1024 * 1024;

/** Reads one report. Returns an error string for a file it can't read. */
export function readCoverageReport(root: string, path: string, options: { layer?: Layer; lowest?: number } = {}): CodeCoverageReport | { path: string; error: string } {
    const full = resolve(root, path);
    const inside = relative(root, full).split(sep).join('/');
    // A report outside the project (another checkout, a CI download) keeps its full path.
    const rel = inside.startsWith('../') ? full : inside;
    try {
        const stat = statSync(full);
        if (stat.size > MAX_REPORT_BYTES) return { path: rel, error: `larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB` };
        const text = readFileSync(full, 'utf8');
        const format = formatOf(full, text.slice(0, 2000));
        if (!format) return { path: rel, error: NOT_A_REPORT };
        const parsed = PARSERS[format](text);
        const lowest = parsed.files
            .filter((f) => f.lines.total > 0 && f.lines.covered < f.lines.total && !isGenerated(f.file))
            .sort((a, b) => b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) || (a.lines.pct ?? 0) - (b.lines.pct ?? 0))
            .slice(0, options.lowest ?? 10)
            .map((f) => ({ ...f, file: f.file.startsWith(root) ? relative(root, f.file).split(sep).join('/') : f.file }));
        return {
            path: rel,
            format,
            layer: options.layer ?? layerOfReport(rel),
            measure: parsed.measure ?? 'lines',
            writtenAt: stat.mtime.toISOString(),
            lines: parsed.lines,
            ...(parsed.branches ? { branches: parsed.branches } : {}),
            ...(parsed.functions ? { functions: parsed.functions } : {}),
            files: parsed.files.length,
            lowest,
        };
    } catch (error) {
        return { path: rel, error: error instanceof Error ? error.message : String(error) };
    }
}
