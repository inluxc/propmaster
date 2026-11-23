/**
 * The last run: what failed and why, written by the Propmaster reporter to
 * `.propmaster/last-run.json` after every run. Unlike the test history (one
 * outcome per test per run, kept for many runs), it holds one run with the
 * details an agent or a person needs to fix it: the step that failed, the
 * error message, the code where it failed, and the trace and screenshots.
 *
 * `propmaster failures` and the MCP tools `run_tests` and `last_failures`
 * read it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import type { TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter';
import type { TestOutcome } from './history.js';

export const DEFAULT_LAST_RUN_FILE = '.propmaster/last-run.json';

const MAX_MESSAGE = 3000;
const MAX_SNIPPET = 1500;
export const MAX_RUN_ERRORS = 10;

export interface LastRunError {
    message: string;
    /** `file:line:column` where it was thrown, relative to the project. */
    location?: string;
    /** The code around that line, as Playwright prints it. */
    snippet?: string;
}

export interface LastRunTest {
    /** TestCaseID, or `file › title` for a test without one. */
    id: string;
    title: string;
    /** `file:line` of the test, relative to the project. */
    location: string;
    project: string;
    outcome: TestOutcome;
    retries: number;
    duration: number;
    /** The innermost `test.step()` that failed, with the steps around it: `Step 2: Submit › Step 2.1: Fill`. */
    failedStep?: string;
    /** The failed attempt's errors (for a flaky test, the attempt that failed). */
    errors: LastRunError[];
    /** Trace, screenshots and video of that attempt, relative to the project. */
    attachments?: Array<{ name: string; path: string }>;
    quarantined?: true;
}

export interface LastRun {
    version: 1;
    startedAt: string;
    finishedAt: string;
    /** Playwright's status before quarantine: passed, failed, timedout, interrupted. */
    status: string;
    counts: { total: number; passed: number; flaky: number; failed: number; skipped: number };
    /** Errors outside any test: a config that doesn't load, no tests found, a global setup that throws. */
    errors: string[];
    /** The tests that failed or were flaky; passed and skipped ones are only counted. */
    tests: LastRunTest[];
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function plain(text: string): string {
    return text.replace(ANSI, '');
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function rel(file: string, rootDir: string): string {
    const r = isAbsolute(file) ? relative(rootDir, file) : file;
    return (r.startsWith('..') ? file : r).split('\\').join('/');
}

/** An error as the agent needs it: the message without colours, where it happened, and the code there. */
export function describeError(error: TestError, rootDir: string): LastRunError {
    const message = clip(plain(error.message ?? error.value ?? 'Unknown error').trim(), MAX_MESSAGE);
    const out: LastRunError = { message };
    if (error.location) out.location = `${rel(error.location.file, rootDir)}:${error.location.line}:${error.location.column}`;
    if (error.snippet) out.snippet = clip(plain(error.snippet), MAX_SNIPPET);
    return out;
}

/**
 * The innermost failed `test.step()`, with its parents: `Step 2 › Step 2.1`.
 * Steps of other kinds (expect, hooks, fixtures) are left out of the path.
 */
export function failedStepOf(steps: readonly TestStep[]): string | undefined {
    const search = (list: readonly TestStep[], path: string[]): string[] | undefined => {
        for (const step of list) {
            if (!step.error) continue;
            const here = step.category === 'test.step' ? [...path, step.title] : path;
            const deeper = search(step.steps, here);
            if (deeper) return deeper;
            if (here.length) return here;
        }
        return undefined;
    };
    return search(steps, [])?.join(' › ');
}

/** The attempt to report: the last failed one (for a flaky test, the one before it passed). */
function failedAttempt(test: TestCase): TestResult | undefined {
    return [...test.results].reverse().find((r) => r.status !== 'passed' && r.status !== 'skipped') ?? test.results.at(-1);
}

export function describeTest(
    test: TestCase,
    base: { id: string; project: string; outcome: TestOutcome; quarantined?: boolean },
    rootDir: string,
): LastRunTest {
    const result = failedAttempt(test);
    const attachments = (result?.attachments ?? [])
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, path: rel(a.path!, rootDir) }));
    const failedStep = result ? failedStepOf(result.steps) : undefined;
    return {
        id: base.id,
        title: test.title,
        location: `${rel(test.location.file, rootDir)}:${test.location.line}`,
        project: base.project,
        outcome: base.outcome,
        retries: Math.max(0, test.results.length - 1),
        duration: test.results.reduce((sum, r) => sum + r.duration, 0),
        ...(failedStep ? { failedStep } : {}),
        errors: (result?.errors ?? []).map((e) => describeError(e, rootDir)),
        ...(attachments.length ? { attachments } : {}),
        ...(base.quarantined ? { quarantined: true as const } : {}),
    };
}

export function runErrorText(error: TestError, rootDir: string): string {
    const e = describeError(error, rootDir);
    return e.location ? `${e.message}\n    at ${e.location}` : e.message;
}

/** Writes through a temporary file, so a killed run can't leave half a file. */
export function writeLastRun(file: string, run: LastRun): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(tmp, file);
}

/** The last run, or undefined when there's none (or the file isn't one). */
export function readLastRun(file: string): LastRun | undefined {
    if (!existsSync(file)) return undefined;
    try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as LastRun;
        return data && data.version === 1 && Array.isArray(data.tests) ? data : undefined;
    } catch {
        return undefined;
    }
}

/** The run as text, failures first: what `propmaster failures` prints. */
export function formatLastRun(run: Omit<LastRun, 'tests'> & { tests: Array<LastRunTest & { recent?: string }> }, options: { flaky?: boolean } = {}): string {
    const { counts } = run;
    const lines = [
        `Last run ${run.finishedAt.replace('T', ' ').slice(0, 19)}: ${run.status}. ${counts.passed} passed, ${counts.failed} failed, ${counts.flaky} flaky, ${counts.skipped} skipped.`,
    ];
    for (const error of run.errors) lines.push('', `Error outside the tests: ${error}`);
    const shown = run.tests.filter((t) => t.outcome === 'failed' || (options.flaky !== false && t.outcome === 'flaky'));
    for (const t of shown) {
        lines.push('', `${t.outcome === 'flaky' ? '~ flaky ' : '✗ failed'}  ${t.id === t.title ? t.id : `${t.title}`}  (${t.project || 'no project'}, ${t.location})${t.quarantined ? ' [quarantined]' : ''}`);
        if (t.failedStep) lines.push(`  in step: ${t.failedStep}`);
        if (t.recent && t.recent.length > 1) lines.push(`  history: ${t.recent} (oldest first)`);
        for (const e of t.errors) {
            lines.push(...e.message.split("\n").map((l) => `  ${l}`.trimEnd()));
            if (e.location) lines.push(`  at ${e.location}`);
        }
        const trace = t.attachments?.find((a) => a.name === 'trace');
        if (trace) lines.push(`  trace: npx playwright show-trace ${trace.path}`);
    }
    if (!shown.length && !run.errors.length) lines.push('', 'Nothing failed.');
    return lines.join('\n');
}
