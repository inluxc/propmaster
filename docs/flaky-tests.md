# Flaky Tests: History and Quarantine

Playwright marks a test as flaky when it fails and then passes on a retry. That label is gone once the run ends. The Propmaster reporter keeps it:

- **History:** after every run, the reporter records each test's outcome, retries and duration, with the commit and branch. The record goes into a JSON file that CI carries from run to run.
- **Ranking:** `npx propmaster flaky` ranks the tests by how often they were flaky or failed over the last runs. That shows which tests are getting worse.
- **Quarantine:** `quarantine.json` lists the TestCaseIDs of known-flaky tests, each with an owner and an issue. They keep running and show in every report, but when they are the only failures, the run passes. A known-flaky test stops blocking merges without being hidden or deleted.

Everything is keyed on the [TestCaseID](./guide/writing-tests), so a test keeps its history when it's renamed or moved. There's no service to sign up for: the history is a file in your CI cache.

::: tip When to use something else
Services such as Currents or Trunk do this across a whole organisation, with dashboards. Allure keeps result history in its reports. This reporter is for teams that want the history and quarantine next to the tests, in the repository, without another service.
:::

---

## Setup

### 1. Add the reporter

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
    retries: process.env.CI ? 1 : 0,   // without retries nothing is ever "flaky", only failed
    reporter: [['list'], ['html'], ['@inluxc/propmaster/reporter']],
});
```

It prints nothing of its own unless quarantine applies, so keep your usual reporters next to it.

| Option | Default | |
|---|---|---|
| `history` | `.propmaster/test-history.json` (or `PW_TEST_HISTORY`) | Where the history goes, relative to the config file. `false` for none |
| `maxRuns` | `100` | Runs to keep |
| `quarantine` | `quarantine.json` (or `PW_QUARANTINE_FILE`) | `false` to ignore quarantine |
| `summary` | `true` | On GitHub Actions, write the run's flaky and quarantined tests to the job summary |

```typescript
reporter: [['list'], ['@inluxc/propmaster/reporter', { history: 'reports/history.json', maxRuns: 200 }]],
```

Add `.propmaster/` to `.gitignore`.

### 2. Carry the history between CI runs

The history only builds up if each CI run starts from the previous run's file. On GitHub Actions, restore it from the cache before the tests, and save it after them with `if: always()`, so failing runs count too:

```yaml
steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - uses: actions/cache/restore@v4
    with:
      path: .propmaster/test-history.json
      key: test-history-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}
      restore-keys: test-history-${{ github.job }}-
  - run: npx playwright test
  - uses: actions/cache/save@v4
    if: always()
    with:
      path: .propmaster/test-history.json
      key: test-history-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}
  - if: always()
    run: npx propmaster flaky --limit 10 >> "$GITHUB_STEP_SUMMARY"
```

`actions/cache` with only a `key` saves only when the job succeeds, so use the separate restore and save steps. Each job keeps its own history. To see all of them in one ranking, upload each file as an artifact and pass the folder: `npx propmaster flaky --history histories/`.

Other CI systems work the same way: restore `.propmaster/test-history.json` before the tests and save it afterwards. On GitLab CI, use a `cache:` entry with `when: always`. In CircleCI, use `restore_cache` and `save_cache` steps with `when: always`, and on Jenkins, archive the file and copy it back in the next build. The run ID, commit and branch are read from each system's variables. In sharded runs, set `PW_SHARD` (e.g. `2`) so each shard's run is kept apart.

---

## Finding flaky tests

```bash
npx propmaster flaky
```

```
Flaky and failing tests, last 30 run(s). Rate: runs that were flaky or failed, of the runs where it ran.

 Rate Flaky Failed Runs   History (✓ passed, ~ flaky, ✗ failed)
  23%     6      1   30   ✓✓~✓✓✓~✓✓✗✓✓~✓✓✓✓~✓~   TC-API-007  PUT /pet returns 404
  10%     3      0   30   ✓✓✓✓✓✓✓✓~✓✓✓✓✓~✓✓✓~✓   TC-BRW-012 [quarantined]  checkout shows the total
fails     0      4    4   ✗✗✗✗                   TC-KFK-003  consumer retries a poisoned message
```

- **Rate:** the share of runs where the test was flaky or failed, out of the runs where it ran (skips don't count). A test that fails in some runs and passes in others is as unstable as one that passes on a retry.
- **History:** its last 20 outcomes, newest on the right.
- **`fails`:** a test that never passed in the window. It's broken rather than flaky, and is listed last.
- Tests that only ever passed are left out. A test that runs in several projects counts once per run, with its worst outcome.

| Option | Default | |
|---|---|---|
| `--history <file\|dir>` | `.propmaster/test-history.json` | Repeatable; a folder reads every `*.json` in it. The same run in two files counts once |
| `--runs <n>` | `30` | How many of the newest runs to look at |
| `--limit <n>` | `20` | Rows to show; `0` for all |
| `--min-rate <0-1>` | `0` | Leave out tests below this rate |
| `--json` | | `{ runs, tests: [{ id, flakeRate, flaky, failed, runs, recent, projects, lastUnstable, quarantined, alwaysFails }] }` |

---

## Quarantine

When a test is known to be flaky and its fix will take a while, quarantine it rather than deleting it, skipping it, or rerunning the build until it passes:

```json
// quarantine.json, next to playwright.config.ts
{
    "maxAgeDays": 30,
    "tests": [
        {
            "id": "TC-API-007",
            "owner": "payments-team",
            "issue": "https://github.com/acme/shop/issues/42",
            "since": "2026-11-20",
            "reason": "times out when the payment mock is slow"
        }
    ]
}
```

Every entry needs `id`, `owner`, `issue` and `since` (`YYYY-MM-DD`). `reason` is optional.

What happens in a run:

- **It still runs.** A quarantined test runs like any other, and every report shows its result. The test has a `quarantined` annotation with the owner, issue and date, so the HTML report and trace say why its failure didn't count.
- **The run passes when only quarantined tests failed.** The reporter prints which ones failed and why, and passes the run, so the exit code is 0. A failure that isn't quarantined fails the run as usual, as do errors outside tests (a global setup that crashed, for example) and a run that timed out.
- **A broken `quarantine.json` never hides a failure.** The reporter says the file is invalid, and the run keeps its status. `propmaster check` reports what's wrong.
- **It says when a test is fixed.** When a quarantined test passes, the reporter says so: once it passes reliably (check with `npx propmaster flaky`), take it off the list.

### Keeping the list short

`npx propmaster check` (and `npm run lint:tests` in this template) checks `quarantine.json` too:

- An invalid file fails the check. Each problem is listed: a malformed ID, a missing owner or issue, a bad date, or an entry listed twice.
- It warns about an entry older than `maxAgeDays` (default 30): fix the test, or remove it if it no longer earns its place.
- It warns about an ID that no test has any more.

Warnings don't fail the check. They show up in every run of it, including in CI. `--json` adds them as `warnings`.

The quarantine applies only through the reporter. Without the reporter in the config, a quarantined test fails the run like any other.

---

## What failed in the last run

After every run the reporter also writes `.propmaster/last-run.json`: the failed and flaky tests of that run with the `test.step()` that failed, the error, where it was thrown, the code around it, and the trace and screenshots. It holds only the last run.

```bash
npx propmaster failures
```

```
Last run 2026-11-23 10:12:40: failed. 41 passed, 1 failed, 1 flaky, 2 skipped.

✗ failed  [TC-API-007] PUT /pet returns 404  (api, tests/api/pet.spec.ts:31)
  in step: Step 2: Verify the response
  history: ✓✓✓✓✓✓✗ (oldest first)
  Error: expect(received).toBe(expected)

  Expected: 404
  Received: 200
  at tests/api/pet.spec.ts:38:35
  trace: npx playwright show-trace test-results/pet-PUT-pet-returns-404-api/trace.zip
```

`history` comes from the test history: one failure after a run of passes is likely new, while one that keeps coming back is in the flake ranking. `--no-flaky` shows only the failures, and `--json` is for scripts. Agents use the [MCP server](./mcp-server#test-tools-always-on)'s `last_failures` and `run_tests`.

| Reporter option | Default | |
|---|---|---|
| `lastRun` | `.propmaster/last-run.json` (or `PW_LAST_RUN_FILE`) | Relative to the config file; `false` for none |

---

## The history file

```json
{
    "version": 1,
    "runs": [
        {
            "id": "github-1234567-1-test-api",
            "startedAt": "2026-11-22T10:00:00.000Z",
            "commit": "3092aa7…",
            "branch": "main",
            "status": "failed",
            "tests": [
                { "id": "TC-API-007", "title": "[TC-API-007] PUT /pet returns 404", "file": "tests/api/pet.spec.ts",
                  "project": "api", "outcome": "flaky", "retries": 1, "duration": 812 }
            ]
        }
    ]
}
```

- **`outcome`:** `passed`, `flaky` (passed on a retry), `failed` or `skipped`.
- **`status`:** the run's status before quarantine.
- **`id`:** a test without a TestCaseID is identified by its file and title instead (`tests/api/pet.spec.ts › updates a pet`), so its history starts again if it's renamed.
- **Writes:** the file is written through a temporary file, so a run that's killed mid-write can't corrupt it.
