/**
 * The Propmaster reporter: test history and quarantine.
 *
 *   // playwright.config.ts
 *   reporter: [['list'], ['@inluxc/propmaster/reporter']],
 *
 * After every run it adds a record (each test's outcome, retries and
 * duration, with the commit and branch) to `.propmaster/test-history.json`.
 * Carry that file between CI runs (a cache or an artifact) and
 * `npx propmaster flaky` ranks the tests by flake rate.
 *
 * When every failure of a run is a test listed in `quarantine.json`, it turns
 * the run's status into passed, so a known-flaky test doesn't block merges.
 * Quarantined tests still run and show in every report.
 */

import { appendFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError } from '@playwright/test/reporter';
import { appendRun, DEFAULT_HISTORY_FILE, DEFAULT_MAX_RUNS, runContext, type HistoryTest, type TestOutcome } from './history.js';
import { describeEntry, loadQuarantine, quarantinePath, testIdOf, type LoadedQuarantine } from './quarantine.js';

export interface PropmasterReporterOptions {
    /** History file, relative to the config file (default `.propmaster/test-history.json`, or PW_TEST_HISTORY); `false` for none. */
    history?: string | false;
    /** Runs to keep in the history (default 100). */
    maxRuns?: number;
    /** Quarantine file, relative to the config file (default `quarantine.json`, or PW_QUARANTINE_FILE); `false` to ignore quarantine. */
    quarantine?: string | false;
    /** Write a summary of flaky and quarantined tests to the GitHub Actions job summary when it's available (default true). */
    summary?: boolean;
}

/** A test's outcome in history terms. */
export function outcomeOf(test: Pick<TestCase, 'outcome'>): TestOutcome {
    switch (test.outcome()) {
        case 'expected':
            return 'passed';
        case 'flaky':
            return 'flaky';
        case 'skipped':
            return 'skipped';
        default:
            return 'failed';
    }
}

/** `file › describe › title` for a test without a TestCaseID. */
function titleKey(test: TestCase, rootDir: string): string {
    const file = test.location.file.startsWith(rootDir) ? test.location.file.slice(rootDir.length + 1) : test.location.file;
    return [file.split('\\').join('/'), ...test.titlePath().slice(3)].join(' › ');
}

export default class PropmasterReporter implements Reporter {
    private readonly options: PropmasterReporterOptions;
    private config!: FullConfig;
    private suite!: Suite;
    private startedAt = new Date();
    private errors = 0;
    private quarantine: LoadedQuarantine | undefined;
    private quarantineError: string | undefined;

    constructor(options: PropmasterReporterOptions = {}) {
        this.options = options;
    }

    printsToStdio(): boolean {
        return false;
    }

    private get baseDir(): string {
        return this.config.configFile ? dirname(this.config.configFile) : this.config.rootDir;
    }

    onBegin(config: FullConfig, suite: Suite): void {
        this.config = config;
        this.suite = suite;
        this.startedAt = new Date();
        if (this.options.quarantine !== false) {
            try {
                this.quarantine = loadQuarantine(quarantinePath(this.baseDir, this.options.quarantine || undefined));
            } catch (error) {
                // Reported at the end, and the run keeps its status: a broken file never hides failures.
                this.quarantineError = (error as Error).message;
            }
        }
    }

    onError(_error: TestError): void {
        this.errors++;
    }

    async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
        const tests = this.suite.allTests();
        const rootDir = this.config.rootDir;
        const records: HistoryTest[] = tests.map((test) => {
            const id = testIdOf(test.title, test.tags) ?? titleKey(test, rootDir);
            const outcome = outcomeOf(test);
            const record: HistoryTest = {
                id,
                title: test.title,
                file: (test.location.file.startsWith(rootDir) ? test.location.file.slice(rootDir.length + 1) : test.location.file).split('\\').join('/'),
                project: test.parent.project()?.name ?? '',
                outcome,
                retries: Math.max(0, test.results.length - 1),
                duration: test.results.reduce((sum, r) => sum + r.duration, 0),
            };
            if (this.quarantine?.entries.has(id)) record.quarantined = true;
            return record;
        });

        this.writeHistory(result, records);

        const lines: string[] = [];
        if (this.quarantineError) lines.push(`Propmaster: quarantine ignored, the file is invalid: ${this.quarantineError}`);

        const failed = records.filter((r) => r.outcome === 'failed');
        const quarantinedFailures = failed.filter((r) => r.quarantined);
        const quarantinedPasses = records.filter((r) => r.quarantined && (r.outcome === 'passed' || r.outcome === 'flaky'));
        const flaky = records.filter((r) => r.outcome === 'flaky');
        let override: FullResult['status'] | undefined;

        if (quarantinedFailures.length) {
            const names = [...new Set(quarantinedFailures.map((r) => r.id))];
            lines.push(`Propmaster: ${names.length} quarantined test(s) failed: ${names.map((id) => `${id} (${describeEntry(this.quarantine!.entries.get(id)!)})`).join('; ')}`);
            const others = failed.length - quarantinedFailures.length;
            if (result.status === 'failed' && others === 0 && this.errors === 0) {
                override = 'passed';
                lines.push('Propmaster: every failure is quarantined, so the run passes.');
            } else if (others > 0) {
                lines.push(`Propmaster: ${others} other test(s) failed, so the run still fails.`);
            }
        }
        if (quarantinedPasses.length) {
            const names = [...new Set(quarantinedPasses.map((r) => r.id))];
            lines.push(`Propmaster: quarantined but passed this run: ${names.join(', ')}. Once it passes reliably, remove it from ${this.quarantine!.file}.`);
        }
        for (const line of lines) console.log(line);

        this.writeSummary(flaky, quarantinedFailures, lines);
        return override ? { status: override } : undefined;
    }

    private writeHistory(result: FullResult, tests: HistoryTest[]): void {
        const option = this.options.history ?? process.env.PW_TEST_HISTORY;
        if (option === false || option === 'false' || tests.length === 0) return;
        const file = isAbsolute(option || '') ? (option as string) : resolve(this.baseDir, option || DEFAULT_HISTORY_FILE);
        const { id, commit, branch } = runContext();
        try {
            appendRun(file, { id, startedAt: this.startedAt.toISOString(), commit, branch, status: result.status, tests }, this.options.maxRuns ?? DEFAULT_MAX_RUNS);
        } catch (error) {
            console.log(`Propmaster: couldn't update the test history ${file}: ${(error as Error).message}`);
        }
    }

    private writeSummary(flaky: HistoryTest[], quarantined: HistoryTest[], lines: string[]): void {
        const target = process.env.GITHUB_STEP_SUMMARY;
        if (this.options.summary === false || !target || (flaky.length === 0 && quarantined.length === 0 && lines.length === 0)) return;
        const row = (t: HistoryTest) => `| ${t.id} | ${t.project} | ${t.outcome}${t.quarantined ? ' (quarantined)' : ''} | ${t.retries} |`;
        const md = [
            '### Propmaster: flaky and quarantined tests',
            '',
            ...lines.map((l) => `- ${l.replace(/^Propmaster: /, '')}`),
            ...(flaky.length || quarantined.length ? ['', '| Test | Project | Outcome | Retries |', '|---|---|---|---|', ...[...flaky, ...quarantined].map(row)] : []),
            '',
        ].join('\n');
        try {
            appendFileSync(target, `${md}\n`);
        } catch {
            // the summary is a convenience
        }
    }
}
