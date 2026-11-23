/**
 * `propmaster failures`: what failed in the last run and why, from the
 * last-run file the Propmaster reporter writes, with each test's recent
 * outcomes from the test history (a new failure, or one that keeps coming
 * back).
 *
 *   npx propmaster failures            failed and flaky tests of the last run
 *   npx propmaster failures --json     for scripts and agents
 */

import { resolve } from 'node:path';
import { DEFAULT_LAST_RUN_FILE, formatLastRun, readLastRun, type LastRun, type LastRunTest } from '../reporter/last-run.js';
import { readHistories } from '../reporter/history.js';
import { findProjectRoot } from './check-tests.js';
import { flakyRows, historyFile } from './flaky.js';

export const FAILURES_HELP = `
  npx propmaster failures [--no-flaky] [--json] [--root <dir>]

  The failed and flaky tests of the last run: the step that failed, the
  error, where it was thrown and the trace to open. Read from
  ${DEFAULT_LAST_RUN_FILE}, which the Propmaster reporter writes after every
  run. Each test also gets its recent outcomes from the test history.

  --no-flaky  Only the tests that failed
  --json      { run, failures, flaky, errors } as JSON
`;

export interface FailureWithHistory extends LastRunTest {
    /** Outcomes in the test history, oldest first (✓ passed, ~ flaky, ✗ failed). */
    recent?: string;
}

export interface Failures {
    /** Where it came from: the last-run file, or (without one) the newest run in the test history, which has no error details. */
    source: 'last-run' | 'history' | 'none';
    run?: Pick<LastRun, 'startedAt' | 'finishedAt' | 'status' | 'counts'>;
    failures: FailureWithHistory[];
    flaky: FailureWithHistory[];
    errors: string[];
    message?: string;
}

export function lastRunFile(root: string): string {
    const option = process.env.PW_LAST_RUN_FILE;
    return resolve(root, option && option !== 'false' ? option : DEFAULT_LAST_RUN_FILE);
}

/** The last run's failures, each with its recent history. */
export function lastFailures(root: string, file: string = lastRunFile(root)): Failures {
    const recent = new Map<string, string>();
    try {
        for (const row of flakyRows(root).rows) recent.set(row.id, row.recent);
    } catch {
        // a broken history only loses the recent outcomes
    }
    const withHistory = (t: LastRunTest): FailureWithHistory => (recent.has(t.id) ? { ...t, recent: recent.get(t.id) } : t);

    const run = readLastRun(file);
    if (run) {
        return {
            source: 'last-run',
            run: { startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, counts: run.counts },
            failures: run.tests.filter((t) => t.outcome === 'failed').map(withHistory),
            flaky: run.tests.filter((t) => t.outcome === 'flaky').map(withHistory),
            errors: run.errors,
        };
    }

    // Projects whose reporter predates the last-run file: the history has outcomes, not errors.
    let newest;
    try {
        newest = readHistories([historyFile(root)]).at(-1);
    } catch {
        newest = undefined;
    }
    if (!newest) {
        return {
            source: 'none', failures: [], flaky: [], errors: [],
            message: `No last run: add the Propmaster reporter to playwright.config.ts (reporter: [['list'], ['@inluxc/propmaster/reporter']]) and run the tests.`,
        };
    }
    const pick = (outcome: 'failed' | 'flaky') => newest!.tests.filter((t) => t.outcome === outcome).map((t) => withHistory({
        id: t.id, title: t.title, location: t.file, project: t.project, outcome: t.outcome, retries: t.retries, duration: t.duration, errors: [],
        ...(t.quarantined ? { quarantined: true as const } : {}),
    }));
    const counts = { total: newest.tests.length, passed: 0, flaky: 0, failed: 0, skipped: 0 };
    for (const t of newest.tests) counts[t.outcome]++;
    return {
        source: 'history',
        run: { startedAt: newest.startedAt, finishedAt: newest.startedAt, status: newest.status, counts },
        failures: pick('failed'),
        flaky: pick('flaky'),
        errors: [],
        message: `No ${DEFAULT_LAST_RUN_FILE}, so no error details: these are from the test history. Run the tests again with a current Propmaster reporter for the errors.`,
    };
}

export function runFailures(argv: string[], log: (line?: string) => void = console.log, cwd: string = process.cwd()): number {
    if (argv.includes('--help') || argv.includes('-h')) {
        log(FAILURES_HELP);
        return 0;
    }
    const rootIndex = argv.indexOf('--root');
    const root = rootIndex >= 0 && argv[rootIndex + 1] ? resolve(cwd, argv[rootIndex + 1]) : findProjectRoot(cwd);
    const flaky = !argv.includes('--no-flaky');
    const result = lastFailures(root);
    if (!flaky) result.flaky = [];

    if (argv.includes('--json')) {
        log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (result.source === 'none') {
        log(result.message);
        return 0;
    }
    const run = {
        version: 1 as const,
        startedAt: result.run!.startedAt,
        finishedAt: result.run!.finishedAt,
        status: result.run!.status,
        counts: result.run!.counts,
        errors: result.errors,
        tests: [...result.failures, ...result.flaky],
    };
    log(formatLastRun(run, { flaky }));
    if (result.message) log(`\n${result.message}`);
    return 0;
}
