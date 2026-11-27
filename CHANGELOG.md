# Changelog

What changed in Propmaster, newest first. Each entry names the npm release it's in, links to its pull request, and marks **Breaking** changes that need something done in an existing project. Everything below the `1.0.1` entries is in the first release, `1.0.0` (2026-11-27).

## 1.0.1 (2026-11-27): custom cleanups that use `request`

### Fixed

- **`testData.cleanup()` callbacks can use Playwright's `request`.** In a test that also used a client fixture set up before `request`, such as `databaseClient`, the stack ran after `request` was closed. Undoing an API call then failed with "Target page, context or browser has been closed". `testData` now runs the stack in its own teardown, and `request` stays open until then. [#84](https://github.com/inluxc/propmaster/pull/84) · [Custom cleanups](https://propmaster.dev/test-data#custom-cleanups)

## 2026-11-24: ClickHouse

### Added

- **`clickHouseClient`** for ClickHouse, over its HTTP interface with `@clickhouse/client`. [ClickHouse](https://propmaster.dev/clickhouse-fixture)
  - Typed `{name:Type}` parameters; rows as plain objects, with `count()`, `UInt64` and the wider integers as numbers (a `bigint` beyond 2^53, never rounded).
  - `insert()` deletes its rows after the test, `waitForRows()` polls for what an asynchronous pipeline writes, and `createDatabase()` gives a test a database of its own.
  - `clickhouse_query`, a read-only MCP tool that ClickHouse itself holds to reads (`readonly=2`).
  - ClickHouse in `compose.test.yaml`, CI (Node.js and Bun), Testcontainers (`PW_CLICKHOUSE_CONTAINER=true`), `propmaster fixture add clickhouse`, `doctor` and the coverage report. Category `CH`, project `integration-clickhouse`, `ClickHouseSteps`.

## 2026-11-24: what the tests cover, per layer

### Added

- **`propmaster coverage`** and the **`coverage_report`** MCP tool: what the tests cover per layer of the pyramid (unit, integration, e2e), read from the test sources, the test history, the OpenAPI spec and the code-coverage reports already in the project. Nothing runs. [Coverage](https://propmaster.dev/coverage)
  - Each layer has its tests, the ones marked `skip`/`fixme`, its last run and pass rate, the fixtures it uses, and what its tests touch: API operations, HTTP paths, GraphQL operations, gRPC methods, tables, collections, topics, queues, indexes, routes and deep links.
  - With a spec, it lists the operations no test calls, the tested ones that assert no error status the spec documents, and the other documented codes nobody asserts.
  - Gaps also cover configured backends no test uses, tests that never ran or failed last, quarantined tests, and code coverage under 60% or older than 30 days.
  - The application can be in any language. Its own tests count, in Python, Go, Java, Kotlin, Scala, Groovy, C#, Ruby, PHP, Rust, Swift and Elixir. Each gets a layer from its folder, the language's convention (`*IT`, Rust's `tests/`, Go build tags), the harness it uses (Testcontainers, `WebApplicationFactory`, `@SpringBootTest`, Selenium, XCUITest, ...), a backend in its folder or name (`Postgres/`) or its markers (`@pytest.mark.integration`, `@Tag`, `[Trait]`). Their HTTP calls are matched to the spec's operations by method and path template, and their asserted statuses are read as numbers or names (`isNotFound()`, `HttpStatusCode.NotFound`).
  - It reads code-coverage reports from any language's tools: LCOV, Istanbul `coverage-summary.json`, Cobertura, JaCoCo, Clover, OpenCover, Go cover profiles, coverage.py JSON and SimpleCov. They can be anywhere in the project, or wherever `--report` points, and it shows the least-covered files.
  - For agents, the report says what to compare next: tables in the database, Kafka topics, and the application's routes.

## 2026-11-24: agents run the tests, and every editor gets the MCP server

### Added

- **Bun support**, as the package manager and as the runtime (`bunx --bun playwright test`, Bun 1.4.3 or later with Playwright 1.65 or later). CI runs every suite on Bun 1.4.5. [#78](https://github.com/inluxc/propmaster/pull/78) · [Using Bun](https://propmaster.dev/guide/bun)
  - In a Bun project (`bun.lock`, or `bunx propmaster init`), every command Propmaster prints or writes uses Bun: `bun add -d` for drivers, `bun run` for scripts, `bunx` for tools and for the MCP server in editor configs.
  - The reporter and `propmaster doctor` warn when the tests run on a Bun or Playwright too old for each other. `doctor` also finds a native driver installed without its binding (`--fix` runs `bun pm trust`, or `npm rebuild`).
  - Every backend passes on Bun except Kafka with Confluent's client, whose native binding exists only for Node.js: on Bun, use kafkajs (the default), or run the Kafka tests on Node.js. The fixture and `doctor` say so.
  - Errors from a failed request read the same on Node.js and Bun (`fetch failed: ECONNREFUSED (...)`), and on Node.js they now include the cause instead of just "fetch failed".
- **`propmaster mcp setup`** connects the MCP server to your editors by writing the config file each one reads. [#76](https://github.com/inluxc/propmaster/pull/76) · [Setup](https://propmaster.dev/mcp-server#setup)
  - Editors: Claude Code (`.mcp.json`), VS Code (`.vscode/mcp.json`), Cursor (`.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`) and Zed (`.zed/settings.json`).
  - A menu opens with the editors the project already uses selected. `--client claude,vscode` names them instead.
  - The entry goes next to the servers already in the file, and the rest of the file stays as it was, comments included. Running it again changes nothing, and `--remove` gives the file back.
  - `--check` starts each configured server the way the editor would, talks to it over MCP and lists its tools.
- **MCP tools to run tests and read why they failed.** [#75](https://github.com/inluxc/propmaster/pull/75) · [Test tools](https://propmaster.dev/mcp-server#test-tools-always-on)
  - `run_tests` runs tests by TestCaseID, file, project or title. For each failure it returns the step that failed, the error, the code where it was thrown, and the trace. It isn't offered for a production environment, and its runs stay out of the test history unless asked.
  - `last_failures` returns the last run's failures, whoever ran it, with each test's recent results.
  - `flaky_tests` returns the flake ranking.
  - `generate_api_tests` previews API tests from the OpenAPI spec, and writes them with `apply: true`.
- **`propmaster failures`** prints the last run's failures in the terminal. The reporter now writes them to `.propmaster/last-run.json` after every run. [#75](https://github.com/inluxc/propmaster/pull/75) · [What failed in the last run](https://propmaster.dev/flaky-tests#what-failed-in-the-last-run)

### Changed

- **`propmaster init`** sets up the MCP server for Claude Code and for the editors the project already uses. An existing `.mcp.json` now gets the entry added instead of being skipped. [#76](https://github.com/inluxc/propmaster/pull/76)
- **`propmaster doctor`** checks the MCP server in its own process over stdio, as an editor starts it. It finds the server in all five editors' configs, and `--fix` sets them up. [#76](https://github.com/inluxc/propmaster/pull/76)

## 2026-11-23: setup and project tooling

### Added

- **Interactive CLI.** `npx propmaster` with no command opens a menu of commands, and every option with a fixed set of values is a menu. With no terminal, a command never waits: it exits with code 2 and names the flag to pass. Commands start with the logo and version, and `--version` prints the version. [#70](https://github.com/inluxc/propmaster/pull/70) · [The CLI](https://propmaster.dev/guide/cli)
- **`propmaster fixture add | remove | list`** sets a fixture up in one step, or takes it out again. [#71](https://github.com/inluxc/propmaster/pull/71) · [Adding and removing fixtures](https://propmaster.dev/guide/cli#adding-and-removing-fixtures)
  - It installs the driver, and adds the config to every environment, the `PW_*` variables to `.env.example`, a `compose.test.yaml` service and a starter test.
  - `remove` keeps anything you changed, and anything another fixture still uses.
  - MCP tools: `fixtures_list`, `fixture_add` and `fixture_remove`.
- **`propmaster env add | list`** adds an environment copied from another. [#72](https://github.com/inluxc/propmaster/pull/72) · [Adding an environment](https://propmaster.dev/guide/configuration#adding-an-environment)
  - Values become `CHANGE_ME` and credentials are left out. You get a `.env.<name>` to fill in, kept out of git.
  - `--prod` marks an environment `"production": true`. The MCP server refuses such an environment unless started with `--allow-prod`, and never gives it write tools.
  - MCP tools: `environments_list` and `environment_add`.
- **`propmaster doctor`** finds setup problems and says how to fix each one. [#73](https://github.com/inluxc/propmaster/pull/73) · [Doctor](https://propmaster.dev/guide/cli#doctor)
  - It checks the config, drivers, backends, browsers, the CI image, `.env` files kept out of git, the MCP server and the test conventions.
  - `--fix` applies the safe fixes. The MCP tool is `doctor`.
- **QA standards** for your team's own testing rules. [#74](https://github.com/inluxc/propmaster/pull/74) · [QA standards](https://propmaster.dev/qa-standards)
  - Pages in `standards/` tell agents how the team writes tests.
  - Rules in `propmaster.standards.json` are enforced by `propmaster check`, at `error` or `warn` level.
  - `propmaster standards init` writes a sample set. The MCP server serves the pages through its `standards` tool.

## 2026-11-22: more backends, and flaky tests

### Added

- **`grpcClient`** for gRPC services, from `.proto` files or server reflection: unary calls and all three kinds of stream. [#54](https://github.com/inluxc/propmaster/pull/54) · [gRPC](https://propmaster.dev/grpc-fixture)
- **`realtimeClient`** for WebSocket and Server-Sent Events. [#57](https://github.com/inluxc/propmaster/pull/57) · [WebSocket & SSE](https://propmaster.dev/realtime-fixture)
- **`searchClient`** for Elasticsearch and OpenSearch, with a per-test index prefix. [#53](https://github.com/inluxc/propmaster/pull/53) · [Search](https://propmaster.dev/search-fixture)
- **`dynamoDbClient`** for DynamoDB, with plain objects and writes undone after each test. [#58](https://github.com/inluxc/propmaster/pull/58) · [DynamoDB](https://propmaster.dev/dynamodb-fixture)
- **`cassandraClient`** for Cassandra and ScyllaDB. [#59](https://github.com/inluxc/propmaster/pull/59) · [Cassandra](https://propmaster.dev/cassandra-fixture)
- **Flaky test history and quarantine.** [#60](https://github.com/inluxc/propmaster/pull/60) · [Flaky tests](https://propmaster.dev/flaky-tests)
  - The Propmaster reporter keeps each test's outcome across runs, and `propmaster flaky` ranks tests by flake rate.
  - Tests listed in `quarantine.json` keep running but don't fail the build.
- **Confluent's Kafka client** as an opt-in driver for `kafkaClient` (`PW_KAFKA_DRIVER=confluent`). kafkajs stays the default. [#61](https://github.com/inluxc/propmaster/pull/61)

### Fixed

- Neo4j's container health check no longer starts a JVM for every check. [#55](https://github.com/inluxc/propmaster/pull/55)
- RabbitMQ's container health check can no longer crash the broker. [#56](https://github.com/inluxc/propmaster/pull/56)

## 2026-11-21: the MCP server, and API test generation

### Added

- **`propmaster mcp`**, an MCP server that lets coding agents see the project's backends: database, MongoDB, Redis, Kafka, Neo4j, the OpenAPI spec and TestCaseIDs. [#49](https://github.com/inluxc/propmaster/pull/49) · [MCP server](https://propmaster.dev/mcp-server)
  - It is read-only unless started with `--allow-writes`, refuses production environments, and never returns credentials.
- **`propmaster generate openapi`** writes API tests from the OpenAPI spec, one file per tag, with real TestCaseIDs. It never overwrites a file. [#50](https://github.com/inluxc/propmaster/pull/50) · [Generating API tests](https://propmaster.dev/guide/generate-api-tests)
- **`amqpClient`** for RabbitMQ and AMQP 0-9-1. [#51](https://github.com/inluxc/propmaster/pull/51) · [RabbitMQ](https://propmaster.dev/amqp-fixture)
- **`s3Client` and `sqsClient`** for AWS S3, SQS and SNS. Moto is the emulator in compose, CI and containers. [#52](https://github.com/inluxc/propmaster/pull/52) · [AWS](https://propmaster.dev/aws-fixture)

### Fixed

- Starting a container no longer counts against the first test's timeout. [#48](https://github.com/inluxc/propmaster/pull/48)

## 2026-11-20: Propmaster, optional drivers and test helpers

### Added

- **Testcontainers.** A backend starts in a container for the test run with `PW_<BACKEND>_CONTAINER=true`. [#38](https://github.com/inluxc/propmaster/pull/38) · [Testcontainers](https://propmaster.dev/testcontainers)
- **`inboxClient`** reads the email your app sends, through Mailpit. [#41](https://github.com/inluxc/propmaster/pull/41) · [Inbox](https://propmaster.dev/inbox-fixture)
- **Auth helpers**: OAuth/OIDC tokens per role, and saved browser logins so tests start logged in. [#42](https://github.com/inluxc/propmaster/pull/42) · [Auth](https://propmaster.dev/auth)
- **`mockServer`** stubs the third-party APIs your backend calls, with WireMock. [#45](https://github.com/inluxc/propmaster/pull/45) · [Mock server](https://propmaster.dev/mock-server-fixture)
- **Test data factories** with automatic cleanup across backends (`testData`). [#46](https://github.com/inluxc/propmaster/pull/46) · [Test data](https://propmaster.dev/test-data)
- **Contract checks** that validate OpenAPI requests and responses against the spec. [#47](https://github.com/inluxc/propmaster/pull/47) · [OpenAPI](https://propmaster.dev/openapi-fixture)
- **Documentation site** on GitHub Pages, with CI examples for GitLab, Jenkins, Azure Pipelines, CircleCI and Bitbucket. [#10](https://github.com/inluxc/propmaster/pull/10), [#11](https://github.com/inluxc/propmaster/pull/11) · [CI/CD](https://propmaster.dev/ci)
- **`propmaster organize`** sorts existing tests into the folder for their type. [#12](https://github.com/inluxc/propmaster/pull/12) · [Project layout](https://propmaster.dev/guide/project-layout)

### Changed

- **Breaking: renamed to Propmaster.** The package is now `@inluxc/propmaster` (it was `@inluxc/stagehand`), the command is `propmaster`, and the site is [propmaster.dev](https://propmaster.dev). Change the package name in `package.json` and your imports. [#39](https://github.com/inluxc/propmaster/pull/39)
- **Breaking: backend drivers are optional peer dependencies**, loaded on first use. Propmaster itself has no runtime dependencies. [#34](https://github.com/inluxc/propmaster/pull/34) · [Getting started](https://propmaster.dev/guide/getting-started)
  - Install the driver for each fixture you use, for example `npm install --save-dev pg` for PostgreSQL. `propmaster fixture add` does it for you.
  - A fixture whose driver is missing throws `MissingPackageError`, with the command to install it.
- **Breaking: `init` uses one folder per test type**: `tests/api`, `tests/integration`, `tests/e2e` and `tests/mobile`. New projects no longer get `tests/specs/` or the `.browser.ts` and `.mobile.ts` suffixes. Existing projects aren't affected unless they run `propmaster organize --apply`. [#12](https://github.com/inluxc/propmaster/pull/12)
- The Integration Tests workflow is faster, and its jobs have timeouts, so a hung job fails fast. [#8](https://github.com/inluxc/propmaster/pull/8), [#43](https://github.com/inluxc/propmaster/pull/43), [#44](https://github.com/inluxc/propmaster/pull/44)

### Fixed

- The OpenAPI fixture loads a local spec file from disk instead of over HTTP. [#35](https://github.com/inluxc/propmaster/pull/35)

## 2026-11-19: Appium, Neo4j and test conventions

### Added

- **`appiumDriver`**, an Appium session through WebdriverIO, for local Appium, grids, cloud farms and GADS device farms. [#6](https://github.com/inluxc/propmaster/pull/6) · [Appium & GADS](https://propmaster.dev/appium-fixture)
- **`neo4jClient`** for Neo4j. [#3](https://github.com/inluxc/propmaster/pull/3) · [Neo4j](https://propmaster.dev/neo4j-fixture)
- **OpenBao** as a secrets provider. [#7](https://github.com/inluxc/propmaster/pull/7) · [Secrets](https://propmaster.dev/secrets)
- **`propmaster check` and `propmaster next-id`** enforce the test conventions: a unique `[TC-XXX-NNN]` ID in each title and tag, `test.step()` in every test, and the framework's own imports. [#4](https://github.com/inluxc/propmaster/pull/4), [#5](https://github.com/inluxc/propmaster/pull/5) · [Writing tests](https://propmaster.dev/guide/writing-tests)

### Changed

- **Breaking: Mobilewright is removed.** [#6](https://github.com/inluxc/propmaster/pull/6)
  - `mobilewrightDevice`, `mobilewrightScreen`, `MobilewrightSteps`, the `mobilewright` config key and the `PW_MOBILE_*` variables are gone.
  - Use `appiumDriver` with the `appium` config (`PW_APPIUM_*`) instead.
  - The `MOB` TestCaseID category is retired, so its IDs are never reused. Mobile tests use `APM`.
- Every package is upgraded, with the security advisories fixed. [#1](https://github.com/inluxc/propmaster/pull/1)

### Fixed

- The built ESM output loads in plain Node.js. [#2](https://github.com/inluxc/propmaster/pull/2)
