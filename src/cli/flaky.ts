/**
 * `propmaster flaky`: ranks tests by flake rate from the test history the
 * Propmaster reporter writes.
 *
 *   npx propmaster flaky                          last 30 runs of .propmaster/test-history.json
 *   npx propmaster flaky --runs 100 --limit 50
 *   npx propmaster flaky --history ci-history/    every *.json in a folder (e.g. downloaded artifacts)
 *   npx propmaster flaky --json                   for scripts and agents
 */

import { resolve } from 'node:path';
import { DEFAULT_HISTORY_FILE, flakyReport, formatReport, readHistories, type FlakyRow } from '../reporter/history.js';
import { loadQuarantine, quarantinePath } from '../reporter/quarantine.js';
import { findProjectRoot } from './check-tests.js';

export const FLAKY_HELP = `
  npx propmaster flaky [--history <file|dir>]... [--runs <n>] [--limit <n>] [--min-rate <0-1>] [--json] [--root <dir>]

  Ranks tests by flake rate over the last runs in the test history (written
  by the Propmaster reporter): how often a test was flaky (passed on a retry)
  or failed, of the runs where it ran. Tests that never passed in the window
  are listed last, as failing rather than flaky.

  --history   History file or folder of them (default ${DEFAULT_HISTORY_FILE}); repeatable
  --runs      How many of the newest runs to look at (default 30)
  --limit     Rows to show (default 20)
  --min-rate  Leave out tests below this rate, e.g. 0.1
  --json      Every row as JSON: { runs, tests: [{ id, flakeRate, flaky, failed, runs, recent, quarantined, ... }] }
`;

function option(argv: string[], name: string): string[] {
    const values: string[] = [];
    argv.forEach((a, i) => {
        if (a === name && argv[i + 1] !== undefined) values.push(argv[i + 1]);
        else if (a.startsWith(`${name}=`)) values.push(a.slice(name.length + 1));
    });
    return values;
}

const number = (value: string | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more, not "${value}"`);
    return n;
};

/** The history file the reporter writes for the project at `root`. */
export function historyFile(root: string): string {
    return resolve(root, process.env.PW_TEST_HISTORY && process.env.PW_TEST_HISTORY !== 'false' ? process.env.PW_TEST_HISTORY : DEFAULT_HISTORY_FILE);
}

/** The flake ranking over the newest `window` runs: what `propmaster flaky` and the MCP tool flaky_tests show. */
export function flakyRows(root: string, options: { histories?: string[]; window?: number; minRate?: number } = {}): { runs: number; rows: FlakyRow[] } {
    const runs = readHistories(options.histories?.length ? options.histories : [historyFile(root)]);
    let quarantined = new Set<string>();
    try {
        quarantined = new Set(loadQuarantine(quarantinePath(root)).entries.keys());
    } catch {
        // `propmaster check` reports a broken quarantine file
    }
    const windowRuns = runs.slice(-(options.window ?? 30));
    const minRate = options.minRate ?? 0;
    return { runs: windowRuns.length, rows: flakyReport(windowRuns, { quarantined }).filter((r) => r.alwaysFails || r.flakeRate >= minRate) };
}

/** Runs the command; returns the exit code. */
export function runFlaky(argv: string[], log: (line?: string) => void = console.log, cwd: string = process.cwd()): number {
    if (argv.includes('--help') || argv.includes('-h')) {
        log(FLAKY_HELP);
        return 0;
    }
    try {
        const rootOption = option(argv, '--root')[0];
        const root = rootOption ? resolve(cwd, rootOption) : findProjectRoot(cwd);
        const histories = option(argv, '--history').map((p) => resolve(cwd, p));
        const window = Math.max(1, Math.floor(number(option(argv, '--runs')[0], 30, '--runs')));
        const limit = Math.floor(number(option(argv, '--limit')[0], 20, '--limit'));
        const minRate = number(option(argv, '--min-rate')[0], 0, '--min-rate');

        const { runs: runCount, rows } = flakyRows(root, { histories, window, minRate });

        if (argv.includes('--json')) {
            log(JSON.stringify({ runs: runCount, tests: rows }, null, 2));
            return 0;
        }
        log(formatReport(limit > 0 ? rows.slice(0, limit) : rows, runCount));
        if (limit > 0 && rows.length > limit) log(`\n… and ${rows.length - limit} more (--limit 0 for all)`);
        const candidates = rows.filter((r) => !r.alwaysFails && !r.quarantined && r.flakeRate >= 0.1);
        if (candidates.length) {
            log(`\nTo stop a flaky test from failing the build while it's fixed, add it to quarantine.json with an owner and an issue.`);
        }
        return 0;
    } catch (error) {
        console.error(`propmaster flaky: ${(error as Error).message}`);
        return 2;
    }
}
