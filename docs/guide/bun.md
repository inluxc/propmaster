# Using Bun

Bun works with Propmaster as your **package manager**: `bun install`, `bun add`, `bunx` and `bun run`. The tests themselves keep running on **Node.js**, which is the runtime Playwright Test supports.

You don't have to choose: `bunx playwright test` and `bun run test` run Playwright on Node.js. Its bin starts with `#!/usr/bin/env node`, and Bun follows that. Only `--bun` (`bunx --bun ...`, `bun --bun run ...`) switches to Bun's runtime.

## Why not Bun's runtime

Running the tests on Bun's runtime doesn't make them faster. We measured Propmaster's own unit tests with Bun 1.3.12:

| | Node.js | Bun runtime (`--bun`) |
|---|---|---|
| Unit tests | 18 s, all passed | 48 s, 20 failed |
| `propmaster check` | 91 ms | 82 ms |

- **Slower.** Playwright starts its workers as separate processes, and they're slower on Bun. A real run mostly waits on browsers and backends anyway, which the runtime can't speed up.
- **Some drivers don't work.** Loading `better-sqlite3`, a native Node.js module, crashes Bun 1.3.12 (`SIGILL`), taking the test worker with it.
- **Errors read differently.** Network errors have other messages on Bun, so assertions on them fail.
- **Not supported by Playwright.** Its test runner is built and tested on Node.js.

The Propmaster reporter prints a warning when a run is on Bun's runtime, and `propmaster doctor` points out `--bun` in your `package.json` scripts and CI files.

## Setting up a project

```bash
bun add -d @inluxc/propmaster @playwright/test
bunx propmaster init
bunx playwright install
```

Propmaster sees that it's a Bun project from `bun.lock` (or, before there is one, because you ran `bunx`). Every command it prints or writes then uses Bun:

| What | npm project | Bun project |
|---|---|---|
| Install a driver (`fixture add`, `MissingPackageError`, `doctor --fix`) | `npm install --save-dev pg` | `bun add -d pg` |
| Scripts in `AGENTS.md`, `SKILLS.md` and `package.json` written by `init` | `npm run next-id -- API` | `bun run next-id API` |
| Tools | `npx playwright install` | `bunx playwright install` |
| The MCP server in editor configs (`mcp setup`) | `npx propmaster mcp` | `bunx propmaster mcp` |

## Running tests

```bash
bunx playwright test                     # on Node.js
bunx playwright test --project=api
bun run verify                           # typecheck + lint:tests
bunx propmaster failures                 # what failed in the last run
```

Node.js still has to be installed: Bun runs the tests on it.

## Drivers with install scripts

Bun runs the install scripts only of the packages it trusts. Confluent's Kafka client (`@confluentinc/kafka-javascript`, `PW_KAFKA_DRIVER=confluent`) downloads its native binding in an install script. Without it, the client fails with `Could not locate the bindings file`. `propmaster doctor` finds it, and its fix (also applied by `--fix`) is:

```bash
bun pm trust @confluentinc/kafka-javascript
```

That runs the script now and adds the package to `trustedDependencies` in `package.json`, so later installs run it too. The other drivers need no install script: `better-sqlite3` ships prebuilt binaries.

## CI

Install with Bun, then run the tests with `bunx`. GitHub Actions:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
      - run: bunx playwright test
```

In the Playwright image (`mcr.microsoft.com/playwright`) Node.js is already there: install Bun (`npm install -g bun`) and use the same commands. See [CI/CD](../ci) for the service containers each backend needs.
