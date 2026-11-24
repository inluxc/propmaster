# Using Bun

Propmaster works with Bun both as the **package manager** and as the **runtime** the tests run on.

| You run | Tests run on |
|---|---|
| `bunx --bun playwright test` | Bun |
| `bunx playwright test` | Node.js (the Playwright bin starts with `#!/usr/bin/env node`, and Bun follows it unless you pass `--bun`) |

Running on Bun needs **Bun 1.4.3** or later and **@playwright/test 1.65** or later. Playwright's test runner [runs on Bun from 1.65](https://playwright.dev/docs/release-notes#version-165), and 1.4.3 is the Bun version Playwright's own CI uses. On older versions the Propmaster reporter prints a warning, and `propmaster doctor` says what to upgrade.

## Setting up a project

```bash
bun add -d @inluxc/propmaster @playwright/test
bunx propmaster init
bunx playwright install
bunx --bun playwright test
```

Propmaster sees that it's a Bun project from `bun.lock`, or, in a new folder, from the fact that `init` was started with `bunx`. The commands it prints or writes then use Bun:

| What | npm project | Bun project |
|---|---|---|
| Install a driver (`fixture add`, `MissingPackageError`, `doctor --fix`) | `npm install --save-dev pg` | `bun add -d pg` |
| Scripts in the `AGENTS.md`, `SKILLS.md` and `package.json` that `init` writes | `npm run next-id -- API` | `bun run next-id API` |
| Tools | `npx playwright install` | `bunx playwright install` |
| The MCP server in editor configs (`mcp setup`) | `npx propmaster mcp` | `bunx propmaster mcp` |

## What we test on Bun

CI runs every suite on Bun 1.4.5, installed with `bun install` and run with `bunx --bun playwright test`: the unit, property and OTP tests, and the integration tests for each backend against a real service.

| Backend | On Bun |
|---|---|
| PostgreSQL, MySQL, MSSQL, SQLite | ✅ |
| Redis, MongoDB, Neo4j, Cassandra / ScyllaDB | ✅ |
| Kafka (kafkajs, the default driver) | ✅ |
| RabbitMQ, AWS (S3, SQS, SNS), DynamoDB | ✅ |
| Elasticsearch, OpenSearch | ✅ |
| gRPC, WebSocket and SSE | ✅ |
| Mock server (WireMock), inbox (Mailpit), OTP | ✅ |
| Kafka with Confluent's client (`PW_KAFKA_DRIVER=confluent`) | See [below](#confluent-s-kafka-client) |

On Propmaster's own unit tests, Bun 1.4.5 takes about as long as Node.js (17 s against 18 s). Error messages from the fixtures are the same on both runtimes: a refused connection is `fetch failed: ECONNREFUSED (...)` on either.

## What works differently on Bun

These come from Playwright's test runner on Bun, not from Propmaster ([Playwright's list](https://playwright.dev/docs/release-notes#version-165)):

- **No watch mode.** UI mode doesn't rerun tests when files change, and `--only-changed` doesn't follow imports.
- **`--tsconfig` and the JSX options in `tsconfig.json` have no effect.** Bun compiles the TypeScript itself. Custom ESM loaders aren't supported.
- **Shorter stack traces.** They have no async frames, and API names lose their class (`click` instead of `locator.click`). The locations and step titles in error messages can differ, and so can the `location` that `propmaster failures` and the MCP `last_failures` tool report. The step names you give `test.step()` stay the same.
- **Test console output** isn't in the trace or in UI mode.

## Confluent's Kafka client

Confluent's client (`@confluentinc/kafka-javascript`) has a native binding that its install script downloads for the Node.js version it runs under. Bun loads native modules built for its own ABI (`NODE_MODULE_VERSION`), and Confluent publishes no binary for Bun's. So with the downloaded binary, the client loads on Node.js but not on Bun:

```text
The module 'kafka' was compiled against a different Node.js ABI version using NODE_MODULE_VERSION 137.
This version of Bun requires NODE_MODULE_VERSION 147.
```

To use Kafka on Bun, use the default driver, kafkajs, which needs no native code. To keep Confluent's client, run the Kafka tests on Node.js (`bunx playwright test`, without `--bun`). `propmaster doctor` warns when the tests run on Bun with the Confluent driver.

Bun also runs the install scripts only of packages it trusts. If Confluent's binding is missing, `doctor` finds it, and its fix (also applied by `--fix`) is `bun pm trust @confluentinc/kafka-javascript`.

## CI

GitHub Actions:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4   # install scripts and `bunx playwright install` use Node.js
        with:
          node-version: 24
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.5
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
      - run: bunx --bun playwright test
```

In the Playwright image (`mcr.microsoft.com/playwright`), install Bun (`npm install -g bun`) and use the same commands. See [CI/CD](../ci) for the service containers each backend needs, and [Docker Compose](../ci-docker-compose) to run them from `compose.test.yaml` on the runner, the way Propmaster's own Bun jobs do.
