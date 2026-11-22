/**
 * Unit tests for test history and quarantine: the quarantine file, the
 * history file, the flake ranking, `propmaster flaky` and `propmaster
 * check`, and the reporter itself in real Playwright runs (a nested
 * `playwright test` on a small temporary project).
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ageInDays, loadQuarantine, quarantineWarnings, testIdOf, validateQuarantine } from '../../src/reporter/quarantine';
import { appendRun, flakyReport, formatReport, readHistories, readHistory, runContext, type HistoryRun, type HistoryTest } from '../../src/reporter/history';
import { runFlaky } from '../../src/cli/flaky';
import { checkQuarantine } from '../../src/cli/check-tests';

const REPO = path.resolve(import.meta.dirname, '../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-flaky-'));

const t = (id: string, outcome: HistoryTest['outcome'], project = 'p'): HistoryTest => ({ id, title: `[${id}] x`, file: 'a.spec.ts', project, outcome, retries: outcome === 'flaky' ? 1 : 0, duration: 1 });
const run = (n: number, tests: HistoryTest[]): HistoryRun => ({ id: `r${n}`, startedAt: new Date(Date.UTC(2026, 0, n)).toISOString(), status: 'passed', tests });

test.describe('quarantine — file', () => {
    test('the TestCaseID comes from the tag, else from the title', () => {
        expect(testIdOf('[TC-API-001] x', ['@smoke', '@TC-API-007'])).toBe('TC-API-007');
        expect(testIdOf('[TC-API-001] x')).toBe('TC-API-001');
        expect(testIdOf('no id here', ['@smoke'])).toBeUndefined();
    });

    test('every problem in the file is listed', () => {
        expect(validateQuarantine({ tests: [{ id: 'TC-API-001', owner: 'payments', issue: 'SHOP-12', since: '2026-11-01' }] })).toEqual([]);
        expect(validateQuarantine([])).toEqual(['the file must be a JSON object with a "tests" array']);
        expect(validateQuarantine({ maxAgeDays: 0, tests: [
            { id: 'API-1', owner: 'a', issue: 'b', since: '2026-11-01' },
            { id: 'TC-API-002', owner: '', since: '1 Nov' },
            { id: 'TC-API-003', owner: 'a', issue: 'b', since: '2026-11-01' },
            { id: 'TC-API-003', owner: 'a', issue: 'b', since: '2026-11-01' },
        ] })).toEqual([
            '"maxAgeDays" must be a number above 0',
            'tests[0] (API-1): "id" must be a TestCaseID such as TC-API-007',
            'tests[1] (TC-API-002): "owner" is required (who fixes it, and where that\'s tracked)',
            'tests[1] (TC-API-002): "issue" is required (who fixes it, and where that\'s tracked)',
            'tests[1] (TC-API-002): "since" must be a date, YYYY-MM-DD',
            'tests[3] (TC-API-003): listed twice',
        ]);
    });

    test('a missing file is an empty quarantine; an invalid one throws with the file name', () => {
        const dir = tmp();
        expect(loadQuarantine(path.join(dir, 'quarantine.json')).entries.size).toBe(0);
        fs.writeFileSync(path.join(dir, 'quarantine.json'), '{ nope');
        expect(() => loadQuarantine(path.join(dir, 'quarantine.json'))).toThrow(/quarantine.json isn't valid JSON/);
        fs.rmSync(dir, { recursive: true });
    });

    test('warnings: entries past maxAgeDays, and IDs no test has', () => {
        const q = {
            file: 'quarantine.json',
            maxAgeDays: 30,
            entries: new Map([
                ['TC-API-001', { id: 'TC-API-001', owner: 'payments', issue: 'SHOP-12', since: '2026-10-01' }],
                ['TC-API-002', { id: 'TC-API-002', owner: 'payments', issue: 'SHOP-13', since: '2026-11-20' }],
            ]),
        };
        const now = new Date('2026-11-22T12:00:00Z');
        expect(ageInDays('2026-10-01', now)).toBe(52);
        expect(quarantineWarnings(q, new Set(['TC-API-001']), now)).toEqual([
            'TC-API-001 has been quarantined for 52 days (more than 30): fix it or remove the test. Owner: payments, SHOP-12',
            'TC-API-002 is quarantined, but no test has that ID: remove the entry',
        ]);
    });

    test('check: an invalid file is a violation, a stale entry a warning', () => {
        const dir = tmp();
        const ids = [{ id: 'TC-API-001', category: 'API', num: 1, file: 'a.spec.ts', line: 1 }];
        expect(checkQuarantine(dir, ids)).toEqual({ violations: [], warnings: [] });
        fs.writeFileSync(path.join(dir, 'quarantine.json'), JSON.stringify({ tests: [{ id: 'TC-API-001', owner: 'x', issue: 'y', since: '2026-01-01' }] }));
        const stale = checkQuarantine(dir, ids, new Date('2026-11-22'));
        expect(stale.violations).toEqual([]);
        expect(stale.warnings).toEqual([expect.stringMatching(/^quarantine.json: TC-API-001 has been quarantined for 325 days/)]);
        fs.writeFileSync(path.join(dir, 'quarantine.json'), JSON.stringify({ tests: [{ id: 'TC-API-001' }] }));
        const invalid = checkQuarantine(dir, ids);
        expect(invalid.violations).toEqual([expect.objectContaining({ file: 'quarantine.json', rule: 'quarantine', message: expect.stringContaining('"owner" is required') })]);
        fs.rmSync(dir, { recursive: true });
    });
});

test.describe('history — file and ranking', () => {
    test('runs are added oldest first, the same run replaces itself, and only the newest maxRuns are kept', () => {
        const dir = tmp();
        const file = path.join(dir, 'nested', 'history.json');
        for (let n = 1; n <= 5; n++) appendRun(file, run(n, [t('TC-AB-001', 'passed')]), 3);
        appendRun(file, { ...run(5, [t('TC-AB-001', 'failed')]) }, 3);
        const { runs } = readHistory(file);
        expect(runs.map((r) => r.id)).toEqual(['r3', 'r4', 'r5']);
        expect(runs[2].tests[0].outcome).toBe('failed');
        expect(fs.readdirSync(path.dirname(file))).toEqual(['history.json']);
        fs.rmSync(dir, { recursive: true });
    });

    test('several files (one per CI job) merge into one timeline, each run once', () => {
        const dir = tmp();
        appendRun(path.join(dir, 'a.json'), run(1, [t('TC-AB-001', 'passed')]));
        appendRun(path.join(dir, 'a.json'), run(3, [t('TC-AB-001', 'flaky')]));
        appendRun(path.join(dir, 'b.json'), run(2, [t('TC-AB-002', 'failed')]));
        appendRun(path.join(dir, 'b.json'), run(3, [t('TC-AB-001', 'flaky')]));
        expect(readHistories([dir]).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
        expect(() => readHistories([path.join(dir, 'missing.json')])).not.toThrow();
        fs.writeFileSync(path.join(dir, 'c.json'), '{"x":1}');
        expect(() => readHistories([dir])).toThrow(/isn't a test history/);
        fs.rmSync(dir, { recursive: true });
    });

    test('flaky tests rank by rate; always-failing ones come last; stable ones are left out', () => {
        const runs = [
            run(1, [t('TC-AB-001', 'passed'), t('TC-AB-002', 'flaky'), t('TC-AB-003', 'failed'), t('TC-AB-004', 'passed')]),
            run(2, [t('TC-AB-001', 'flaky'), t('TC-AB-002', 'flaky'), t('TC-AB-003', 'failed'), t('TC-AB-004', 'passed')]),
            run(3, [t('TC-AB-001', 'passed'), t('TC-AB-002', 'failed'), t('TC-AB-003', 'failed'), t('TC-AB-004', 'skipped')]),
            run(4, [t('TC-AB-001', 'passed'), t('TC-AB-002', 'passed'), t('TC-AB-003', 'failed')]),
        ];
        const rows = flakyReport(runs, { quarantined: new Set(['TC-AB-002']) });
        expect(rows.map((r) => [r.id, r.flakeRate, r.recent, r.alwaysFails, r.quarantined])).toEqual([
            ['TC-AB-002', 0.75, '~~✗✓', false, true],
            ['TC-AB-001', 0.25, '✓~✓✓', false, false],
            ['TC-AB-003', 0, '✗✗✗✗', true, false],
        ]);
        expect(rows[0].lastUnstable).toEqual({ startedAt: runs[2].startedAt, commit: undefined });
        expect(flakyReport(runs, { window: 2 }).map((r) => r.id)).toEqual(['TC-AB-002', 'TC-AB-003']);
    });

    test('a test in two projects counts once per run, with its worst outcome', () => {
        const rows = flakyReport([run(1, [t('TC-AB-001', 'passed', 'chromium'), t('TC-AB-001', 'flaky', 'firefox')]), run(2, [t('TC-AB-001', 'passed', 'chromium')])]);
        expect(rows).toEqual([expect.objectContaining({ id: 'TC-AB-001', runs: 2, flaky: 1, projects: ['chromium', 'firefox'], flakeRate: 0.5 })]);
    });

    test('the report says when there is nothing to show', () => {
        expect(formatReport([], 0)).toMatch(/No test history yet/);
        expect(formatReport([], 12)).toBe('No flaky or failing tests in the last 12 run(s).');
    });

    test('the run ID and commit come from the CI variables', () => {
        expect(runContext({ GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'unit', GITHUB_SHA: 'abc', GITHUB_REF_NAME: 'main' }))
            .toEqual({ id: 'github-9-2-unit', commit: 'abc', branch: 'main' });
        expect(runContext({ CI_JOB_ID: '77', CI_COMMIT_SHA: 'def', CI_COMMIT_REF_NAME: 'feat', PW_SHARD: '2' })).toEqual({ id: 'gitlab-77-shard2', commit: 'def', branch: 'feat' });
        expect(runContext({ GITHUB_SHA: 'x' }).id).toMatch(/^local-\d+-[0-9a-f]{6}$/);
    });
});

test.describe('propmaster flaky', () => {
    test('prints the ranking, honours --runs, --limit and --min-rate, and has --json', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        const file = path.join(dir, '.propmaster', 'test-history.json');
        appendRun(file, run(1, [t('TC-AB-001', 'flaky'), t('TC-AB-002', 'passed'), t('TC-AB-003', 'failed')]));
        appendRun(file, run(2, [t('TC-AB-001', 'passed'), t('TC-AB-002', 'flaky'), t('TC-AB-003', 'passed')]));
        appendRun(file, run(3, [t('TC-AB-001', 'passed'), t('TC-AB-002', 'passed'), t('TC-AB-003', 'passed')]));
        const out: string[] = [];
        expect(runFlaky([], (l = '') => out.push(l), dir)).toBe(0);
        const text = out.join('\n');
        expect(text).toContain('last 3 run(s)');
        expect(text).toMatch(/33%\s+1\s+0\s+3\s+~✓✓\s+TC-AB-001/);
        expect(text).toContain('quarantine.json');

        out.length = 0;
        runFlaky(['--runs', '2', '--json'], (l = '') => out.push(l), dir);
        const json = JSON.parse(out.join('\n')) as { runs: number; tests: { id: string }[] };
        expect(json.runs).toBe(2);
        expect(json.tests.map((r) => r.id)).toEqual(['TC-AB-002']);

        out.length = 0;
        runFlaky(['--limit', '1'], (l = '') => out.push(l), dir);
        expect(out.join('\n')).toContain('… and 2 more');

        out.length = 0;
        runFlaky(['--json', '--min-rate', '0.5'], (l = '') => out.push(l), dir);
        expect((JSON.parse(out.join('\n')) as { tests: unknown[] }).tests).toEqual([]);
        expect(runFlaky(['--runs', 'x'], () => undefined, dir)).toBe(2);
        fs.rmSync(dir, { recursive: true });
    });
});

/**
 * A small Playwright project in the repo (so @playwright/test resolves),
 * using the reporter from source. Returns the run's exit code and output.
 */
function playwrightRun(dir: string, specs: Record<string, string>, quarantine?: object) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(specs)) fs.writeFileSync(path.join(dir, name), content);
    if (quarantine) fs.writeFileSync(path.join(dir, 'quarantine.json'), JSON.stringify(quarantine));
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `
import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: '.',
    // Its own output folder: by default it would be the repo's test-results, which a run empties first
    outputDir: './test-output',
    retries: 1,
    reporter: [['line'], [${JSON.stringify(path.join(REPO, 'src/reporter/index.ts'))}]],
    projects: [{ name: 'unit' }],
});
`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TEST_') && !k.startsWith('PW_') && !k.startsWith('GITHUB_') && k !== 'CI'));
    const result = spawnSync(process.execPath, [path.join(REPO, 'node_modules/@playwright/test/cli.js'), 'test', '-c', path.join(dir, 'playwright.config.ts')], {
        cwd: dir, env: { ...env, FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 60_000,
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}`, history: readHistory(path.join(dir, '.propmaster', 'test-history.json')) };
}

const SPECS = {
    'a.spec.ts': `
import { test, expect } from '@playwright/test';
test('[TC-XY-001] stable', { tag: ['@TC-XY-001'] }, () => {});
test('[TC-XY-002] passes on the retry', { tag: ['@TC-XY-002'] }, ({}, testInfo) => { expect(testInfo.retry).toBe(1); });
test('[TC-XY-003] always fails', { tag: ['@TC-XY-003'] }, () => { expect(1).toBe(2); });
test.skip('[TC-XY-004] skipped', () => {});
test('no id', () => {});
`,
};

test.describe('reporter — real Playwright runs', () => {
    test.describe.configure({ mode: 'serial' });
    let dir: string;
    test.beforeAll(() => {
        dir = path.join(REPO, '.propmaster', `flaky-e2e-${process.pid}`);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('without quarantine a failure fails the run, and the run is in the history', () => {
        const { code, history } = playwrightRun(path.join(dir, 'plain'), SPECS);
        expect(code).toBe(1);
        expect(history.runs).toHaveLength(1);
        const outcomes = Object.fromEntries(history.runs[0].tests.map((x) => [x.id, [x.outcome, x.retries, x.project]]));
        expect(outcomes).toEqual({
            'TC-XY-001': ['passed', 0, 'unit'],
            'TC-XY-002': ['flaky', 1, 'unit'],
            'TC-XY-003': ['failed', 1, 'unit'],
            'TC-XY-004': ['skipped', 0, 'unit'],
            'a.spec.ts › no id': ['passed', 0, 'unit'],
        });
        expect(history.runs[0].status).toBe('failed');
    });

    test('when every failure is quarantined the run passes, and says so', () => {
        const quarantine = { tests: [{ id: 'TC-XY-003', owner: 'qa-team', issue: 'SHOP-9', since: '2026-11-20', reason: 'needs the new mock' }] };
        const { code, output, history } = playwrightRun(path.join(dir, 'quarantined'), SPECS, quarantine);
        expect(output).toContain('1 quarantined test(s) failed: TC-XY-003 (owner qa-team, SHOP-9, since 2026-11-20: needs the new mock)');
        expect(output).toContain('every failure is quarantined, so the run passes');
        expect(code).toBe(0);
        expect(history.runs[0].tests.find((x) => x.id === 'TC-XY-003')).toMatchObject({ outcome: 'failed', quarantined: true });
        expect(history.runs[0].status).toBe('failed');
    });

    test('another failure still fails the run; a broken quarantine file never hides failures', () => {
        const specs = { ...SPECS, 'b.spec.ts': "import { test, expect } from '@playwright/test';\ntest('[TC-XY-005] breaks', () => { expect(true).toBe(false); });\n" };
        const quarantine = { tests: [{ id: 'TC-XY-003', owner: 'qa-team', issue: 'SHOP-9', since: '2026-11-20' }] };
        const other = playwrightRun(path.join(dir, 'other'), specs, quarantine);
        expect(other.code).toBe(1);
        expect(other.output).toContain('1 other test(s) failed, so the run still fails');

        const broken = playwrightRun(path.join(dir, 'broken'), SPECS, { tests: [{ id: 'TC-XY-003' }] });
        expect(broken.code).toBe(1);
        expect(broken.output).toContain('quarantine ignored, the file is invalid');
    });

    test('a quarantined test that passes is pointed out; the quarantined annotation is on the test', () => {
        const specs = {
            'c.spec.ts': `
import { test, expect } from ${JSON.stringify(path.join(REPO, 'src/index.ts'))};
test('[TC-XY-006] fine now', { tag: ['@TC-XY-006'] }, ({}, testInfo) => {
    expect(testInfo.annotations).toContainEqual({ type: 'quarantined', description: 'owner qa-team, SHOP-10, since 2026-11-21' });
});
`,
        };
        const { code, output } = playwrightRun(path.join(dir, 'passing'), specs, { tests: [{ id: 'TC-XY-006', owner: 'qa-team', issue: 'SHOP-10', since: '2026-11-21' }] });
        expect(output).toContain('quarantined but passed this run: TC-XY-006');
        expect(code).toBe(0);
    });

    test('history builds up run after run', () => {
        const again = playwrightRun(path.join(dir, 'plain'), SPECS);
        expect(again.history.runs).toHaveLength(2);
        const rows = flakyReport(again.history.runs);
        expect(rows.map((r) => [r.id, r.flakeRate, r.alwaysFails])).toEqual([['TC-XY-002', 1, false], ['TC-XY-003', 0, true]]);
    });
});
