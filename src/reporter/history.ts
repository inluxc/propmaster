/**
 * Test history: one record per run, kept in a JSON file that CI carries from
 * run to run (a cache or an artifact), and the flake ranking built from it.
 *
 * A test is identified by its TestCaseID, else by file and title. Its
 * outcome in a run is `passed`, `flaky` (failed, then passed on a retry),
 * `failed` or `skipped`.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_HISTORY_FILE = '.propmaster/test-history.json';
export const DEFAULT_MAX_RUNS = 100;

export type TestOutcome = 'passed' | 'flaky' | 'failed' | 'skipped';

export interface HistoryTest {
    /** TestCaseID, or `file › title` for a test without one. */
    id: string;
    title: string;
    file: string;
    project: string;
    outcome: TestOutcome;
    /** Retries used (0 when it passed first time). */
    retries: number;
    /** Milliseconds, summed over every attempt. */
    duration: number;
    /** On the quarantine list during this run. */
    quarantined?: true;
}

export interface HistoryRun {
    /** Unique per run: the CI run (and job), else a random ID. */
    id: string;
    startedAt: string;
    commit?: string;
    branch?: string;
    /** The run's status before quarantine: passed, failed, timedout, interrupted. */
    status: string;
    tests: HistoryTest[];
}

export interface HistoryFile {
    version: 1;
    runs: HistoryRun[];
}

/** Reads a history file; a missing or empty one is an empty history. */
export function readHistory(file: string): HistoryFile {
    if (!existsSync(file)) return { version: 1, runs: [] };
    const text = readFileSync(file, 'utf8').trim();
    if (!text) return { version: 1, runs: [] };
    let data: Partial<HistoryFile>;
    try {
        data = JSON.parse(text) as Partial<HistoryFile>;
    } catch (error) {
        throw new Error(`${file} isn't valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(data.runs)) throw new Error(`${file} isn't a test history (no "runs" array)`);
    return { version: 1, runs: data.runs };
}

/** Adds a run and keeps the newest `maxRuns`. Writes through a temporary file, so a killed run can't leave half a file. */
export function appendRun(file: string, run: HistoryRun, maxRuns = DEFAULT_MAX_RUNS): HistoryFile {
    const history = readHistory(file);
    const runs = [...history.runs.filter((r) => r.id !== run.id), run]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-Math.max(1, maxRuns));
    const next: HistoryFile = { version: 1, runs };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`);
    renameSync(tmp, file);
    return next;
}

/** Every run in the given files and directories (their *.json files), each run once, oldest first. */
export function readHistories(paths: string[]): HistoryRun[] {
    const files = paths.flatMap((p) => {
        if (existsSync(p) && statSync(p).isDirectory()) {
            return readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f));
        }
        return [p];
    });
    const runs = new Map<string, HistoryRun>();
    for (const file of files) for (const run of readHistory(file).runs) runs.set(run.id, run);
    return [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const git = (args: string[]): string | undefined => {
    try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || undefined;
    } catch {
        return undefined;
    }
};

/** Commit, branch and a run ID from the CI system's variables, else from git. */
export function runContext(env: NodeJS.ProcessEnv = process.env): { id: string; commit?: string; branch?: string } {
    const commit = env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.BUILD_SOURCEVERSION ?? env.CIRCLE_SHA1 ?? env.BITBUCKET_COMMIT ?? env.GIT_COMMIT ?? git(['rev-parse', 'HEAD']);
    const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.CI_COMMIT_REF_NAME || env.CIRCLE_BRANCH || env.BITBUCKET_BRANCH
        || env.BUILD_SOURCEBRANCHNAME || env.BRANCH_NAME || env.GIT_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ci = env.GITHUB_RUN_ID ? `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? 1}-${env.GITHUB_JOB ?? ''}`
        : env.CI_JOB_ID ? `gitlab-${env.CI_JOB_ID}`
            : env.BUILD_BUILDID ? `azure-${env.BUILD_BUILDID}-${env.SYSTEM_JOBID ?? ''}`
                : env.CIRCLE_WORKFLOW_JOB_ID ? `circleci-${env.CIRCLE_WORKFLOW_JOB_ID}`
                    : env.BITBUCKET_BUILD_NUMBER ? `bitbucket-${env.BITBUCKET_BUILD_NUMBER}-${env.BITBUCKET_STEP_UUID ?? ''}`
                        : env.BUILD_TAG ?? undefined;
    const shard = env.PW_SHARD ? `-shard${env.PW_SHARD}` : '';
    return { id: `${ci ?? `local-${Date.now()}-${randomBytes(3).toString('hex')}`}${shard}`, commit, branch };
}

export interface FlakyRow {
    id: string;
    title: string;
    file: string;
    projects: string[];
    /** Runs in the window where it ran (not skipped). */
    runs: number;
    passed: number;
    flaky: number;
    failed: number;
    /** (flaky + failed) / runs, for a test that passed at least once. */
    flakeRate: number;
    /** Never passed in the window: broken rather than flaky. */
    alwaysFails: boolean;
    /** Outcomes, oldest first: ✓ passed, ~ flaky, ✗ failed. */
    recent: string;
    lastUnstable?: { startedAt: string; commit?: string };
    quarantined: boolean;
}

/**
 * Ranks the tests of the newest `window` runs by flake rate. A test that
 * passes on a retry counts as flaky; a test that fails in some runs and
 * passes in others counts too. Tests that only ever passed are left out.
 */
export function flakyReport(runs: HistoryRun[], options: { window?: number; quarantined?: ReadonlySet<string> } = {}): FlakyRow[] {
    const recentRuns = runs.slice(-(options.window ?? runs.length));
    const rows = new Map<string, FlakyRow & { marks: string[] }>();
    for (const run of recentRuns) {
        // One mark per test per run, the worst across its projects.
        const perRun = new Map<string, HistoryTest[]>();
        for (const t of run.tests) {
            if (t.outcome === 'skipped') continue;
            perRun.set(t.id, [...(perRun.get(t.id) ?? []), t]);
        }
        for (const [id, tests] of perRun) {
            const row = rows.get(id) ?? {
                id, title: tests[0].title, file: tests[0].file, projects: [], runs: 0, passed: 0, flaky: 0, failed: 0,
                flakeRate: 0, alwaysFails: false, recent: '', quarantined: false, marks: [],
            };
            for (const t of tests) if (!row.projects.includes(t.project)) row.projects.push(t.project);
            const outcome: TestOutcome = tests.some((t) => t.outcome === 'failed') ? 'failed' : tests.some((t) => t.outcome === 'flaky') ? 'flaky' : 'passed';
            row.runs++;
            row[outcome]++;
            row.marks.push(outcome === 'passed' ? '✓' : outcome === 'flaky' ? '~' : '✗');
            if (outcome !== 'passed') row.lastUnstable = { startedAt: run.startedAt, commit: run.commit };
            row.title = tests[0].title;
            rows.set(id, row);
        }
    }
    const quarantined = options.quarantined ?? new Set<string>();
    return [...rows.values()]
        .map(({ marks, ...row }) => ({
            ...row,
            alwaysFails: row.passed + row.flaky === 0,
            flakeRate: row.passed + row.flaky === 0 ? 0 : (row.flaky + row.failed) / row.runs,
            recent: marks.slice(-20).join(''),
            quarantined: quarantined.has(row.id),
            projects: row.projects.sort(),
        }))
        .filter((row) => row.flaky + row.failed > 0)
        .sort((a, b) => Number(a.alwaysFails) - Number(b.alwaysFails) || b.flakeRate - a.flakeRate || (b.flaky + b.failed) - (a.flaky + a.failed) || a.id.localeCompare(b.id));
}

/** The report as text: a table, newest outcomes on the right. */
export function formatReport(rows: FlakyRow[], runCount: number): string {
    if (runCount === 0) return 'No test history yet: add the Propmaster reporter to playwright.config.ts and run the tests.';
    if (rows.length === 0) return `No flaky or failing tests in the last ${runCount} run(s).`;
    const lines = rows.map((r) => {
        const rate = r.alwaysFails ? 'fails' : `${Math.round(r.flakeRate * 100)}%`;
        const tag = r.quarantined ? ' [quarantined]' : '';
        return [rate.padStart(5), `${r.flaky}`.padStart(5), `${r.failed}`.padStart(6), `${r.runs}`.padStart(4), `  ${r.recent.padEnd(20)}`, `  ${r.id}${tag}${r.id === r.title ? '' : `  ${r.title}`}`].join(' ');
    });
    return [
        `Flaky and failing tests, last ${runCount} run(s). Rate: runs that were flaky or failed, of the runs where it ran.`,
        '',
        ' Rate Flaky Failed Runs   History (✓ passed, ~ flaky, ✗ failed)',
        ...lines,
    ].join('\n');
}
