# MCP Server for Coding Agents

Playwright's MCP server gives an agent the browser. `propmaster mcp` gives it the backends: it can look in the database, on a Kafka topic, in Redis, MongoDB and Neo4j, read the OpenAPI spec, get TestCaseIDs and set fixtures up in the project, all while it writes or debugs your tests.

It uses the same configuration as the tests: `environments.json`, `.env.<environment>`, `PW_*` variables and the secrets provider. Nothing new to configure.

```bash
npx propmaster mcp                    # backends read-only, environment from PW_ENVIRONMENT (default: local)
npx propmaster mcp -e dev             # another environment
npx propmaster mcp --allow-writes     # also offer backend write tools (never in production)
```

The server talks MCP over stdio. You don't run it yourself; your MCP client starts it.

---

## Setup

### Claude Code

Add `.mcp.json` at the project root, so everyone on the team gets the server:

```json
{
    "mcpServers": {
        "propmaster": {
            "command": "npx",
            "args": ["propmaster", "mcp"]
        }
    }
}
```

Or add it from the command line: `claude mcp add propmaster -- npx propmaster mcp`. Claude Code asks you to approve a project's servers the first time it starts one. Run `/mcp` to check that `propmaster` is connected.

### VS Code (GitHub Copilot agent mode)

Add `.vscode/mcp.json`:

```json
{
    "servers": {
        "propmaster": {
            "type": "stdio",
            "command": "npx",
            "args": ["propmaster", "mcp"]
        }
    }
}
```

Open the file and select **Start** above the server, or run **MCP: List Servers** from the command palette.

### Other clients

Cursor, Windsurf, Zed and other MCP clients take the same command: `npx propmaster mcp`, with any options as extra arguments. To pick an environment, add `"-e", "dev"` to `args`, or set `"env": { "PW_ENVIRONMENT": "dev" }`.

---

## Tools

### Read tools (always on)

| Tool | What it does |
|---|---|
| `environment_info` | The active environment, the configured backends (hosts only, no credentials) and whether writes are on |
| `db_query` | One read-only SQL statement (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `DESCRIBE`, `PRAGMA`) with parameters; PostgreSQL, MySQL, MSSQL, SQLite |
| `mongo_find` | Documents in a collection, with filter, sort, projection and limit |
| `mongo_aggregate` | An aggregation pipeline; `$out` and `$merge` are refused |
| `redis_get` | A key of any type (string, hash, list, set, sorted set, stream) and its TTL |
| `redis_keys` | Keys matching a pattern, with `SCAN` (never `KEYS`) |
| `kafka_topics` | Topics with partition and message counts |
| `kafka_peek` | The latest messages on a topic, read with a throwaway consumer group that's deleted afterwards |
| `neo4j_read` | Cypher in a read transaction: Neo4j itself rejects writes |
| `openapi_operations` | The spec's operations: `operationId` (the method on `openApiClient.client`), method, path, parameters, request body, status codes |
| `otp_generate` | The current TOTP code for the configured secret, or one you pass |
| `next_test_id` | The next free TestCaseID(s) in a category, same as `npm run next-id` |
| `check_tests` | The test-convention violations, same as `npm run lint:tests` |

Redis keys go through the configured `keyPrefix`, as in the tests. Results are capped (100 rows by default, `maxRows` up to 1000) and long values are cut at 10,000 characters.

### Project tools (always on)

These change the project's setup, not backend data. They run the same code as [`propmaster fixture`](./guide/cli#adding-and-removing-fixtures) and [`propmaster env`](./guide/configuration#adding-an-environment), and each one changing something returns its plan without changing anything unless it's called with `apply: true`.

| Tool | What it does |
|---|---|
| `fixtures_list` | The fixtures Propmaster can set up (ids like `redis`, `database`, `s3`), the fixture names tests request, and which ones the project has |
| `fixture_add` | Installs the drivers and adds the config to every environment, the `PW_*` variables, compose services and starter tests. Takes `fixtures` (e.g. `["database:mysql", "redis"]`), `service`, `test`, `install` and `apply` |
| `fixture_remove` | Undoes `fixture_add` for one fixture. Refuses while tests still use it and lists them |
| `environments_list` | The environments: which are production, their blocks, whether `.env.<name>` exists, and the values still `CHANGE_ME` |
| `standards` | The team's [testing standards](./qa-standards): the pages in `standards/` and the rules `check_tests` enforces; with `page`, that page's text. The pages are also MCP resources (`standards://<file>`) |
| `doctor` | The setup checks of [`propmaster doctor`](./guide/cli#doctor): config, drivers, backends, browsers, CI image, `.env` files, test conventions. Returns only the problems unless `problems: false`. `fix: true` applies the safe fixes and checks again |
| `environment_add` | A new environment copied from another, the same as [`propmaster env add`](./guide/configuration#adding-an-environment). Takes `name`, `from` (`null` for an empty one), `production`, `copyValues` and `apply`. Credentials are never copied |

They're marked as not read-only, so clients that ask before such tools run ask before these. With `install: false` the package manager isn't run, and the result has the command to run instead.

### Test tools (always on)

The test loop: run tests, read why they failed, and see which ones are flaky.

| Tool | What it does |
|---|---|
| `run_tests` | Runs `playwright test` in the project for the server's environment. Select tests by `ids` (TestCaseIDs), `files`, `projects` or `grep`; with none, every test runs. Returns the counts and, for each failure, the `test.step()` that failed, the error message, where it was thrown with the code around it, and the trace. Flaky tests (passed on a retry) are listed too, and `command` is the same run for a terminal. Also takes `timeout` (seconds for the whole run, default 300, up to 1800), `retries`, `workers` and `history` |
| `last_failures` | The failed and flaky tests of the last run, whoever ran it (`run_tests`, a terminal, an IDE), with the same details, plus each test's recent outcomes from the test history (`✓✓✓✗`: new; `✓✗✓✗`: keeps coming back). `flaky: false` leaves the flaky ones out |
| `flaky_tests` | The [flake ranking](./flaky-tests#finding-flaky-tests), the same as `npm run flaky`. Takes `runs`, `limit` and `minRate` |
| `generate_api_tests` | The tests [`propmaster generate openapi`](./guide/cli) would write from the spec: the files, their tests (TestCaseID, `operationId`, status) and their content. A preview unless called with `apply: true`, which writes them and never over an existing file. Takes `tags`, `operations`, `spec`, `out`, `category`, `prism` and `content` |

A `run_tests` result, shortened:

```json
{
  "ok": false,
  "status": "failed",
  "counts": { "total": 3, "passed": 1, "failed": 1, "flaky": 1, "skipped": 0 },
  "failures": [{
    "id": "TC-API-007",
    "location": "tests/api/orders.spec.ts:8",
    "failedStep": "Step 2: Check the total",
    "errors": [{
      "message": "Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2",
      "location": "tests/api/orders.spec.ts:11:23",
      "snippet": "  10 |     await test.step('Step 2: Check the total', async () => {\n> 11 |         expect(order.total).toBe(3);"
    }],
    "attachments": [{ "name": "trace", "path": "test-results/orders-…/trace.zip" }]
  }],
  "flaky": [{ "id": "TC-API-009", "failedStep": "Step 1: Wait for the event" }],
  "command": "npx playwright test --grep=(TC-API-007(?!\\d))"
}
```

How `run_tests` runs:

- **With the Propmaster reporter.** It runs the project's own Playwright with the `dot` reporter and the Propmaster reporter, which writes the failures to `.propmaster/last-run.json`; the tool reads them back. The config's other reporters (such as HTML) don't run for these runs. Errors outside the tests, like a config that doesn't load or no tests matching, come back in `errors` and `output`.
- **With a time limit.** Playwright stops at `timeout` and reports what it has (`status: "timedout"`). A run that still doesn't stop is killed, with its workers, 30 seconds later.
- **Not in the test history.** Runs while a test is being written would count as flakes, so they're left out unless `history: true`.
- **Never in production.** For a production environment the tool isn't offered. Tests create and remove their data through the fixtures, so the tool doesn't need `--allow-writes`, but it does talk to the environment's backends, so it's marked as not read-only.

### Write tools (`--allow-writes`)

`db_execute`, `mongo_insert`, `mongo_update`, `mongo_delete` (needs a non-empty filter), `redis_set`, `redis_del`, `kafka_produce`, `neo4j_write`.

Without `--allow-writes` these tools aren't offered at all, so the agent can't call them. Data written through them is **not** cleaned up: unlike the fixtures, there's no test whose end triggers the undo.

---

## Safety

- **Backends read-only by default.** Only the project tools change anything, and only files in the project. `run_tests` runs the tests, which create and remove their own data through the fixtures. `db_query` refuses anything but one read statement: a second statement, a write keyword outside strings and comments (`DELETE`, `UPDATE`, `INSERT`, `DROP`, ...), `SELECT ... INTO`, `FOR UPDATE`, `EXPLAIN ANALYZE` and `PRAGMA x = y`. This check protects against mistakes, but it isn't a sandbox. For data you care about, connect as a database user that can only read.
- **Production is refused.** For an environment named `prod`, `production`, `prd` or `live`, or marked `"production": true` in `environments.json` (`propmaster env add --prod` does that), the server won't start without `--allow-prod`, and even then it stays read-only: `--allow-writes` is ignored.
- **Credentials don't reach the agent.** Every password, secret, token and API key in the loaded configuration, including a password inside a connection URI, is replaced with `[REDACTED]` wherever it shows up: tool results, error messages and the log. On top of that, the redaction the fixture annotations use removes `Bearer` tokens, JWTs and AWS keys. `environment_info` shows hosts and ports, never credentials.
- **Every call is logged** to stderr as `propmaster-mcp: <tool> <arguments> → ok (12 ms)`. Most clients show this log, for example Claude Code's `/mcp` or VS Code's **MCP: Show Output**.

When `secrets.provider` is set, the server resolves the secrets on start. If they can't be fetched, it logs why and uses the values from the files and `PW_*` variables.

---

## When agents should use it

- **Before writing an API test:** `openapi_operations` for the exact `operationId` and parameters, then `next_test_id` for the ID.
- **Before asserting on stored data:** `db_query` or `mongo_find` to see the real column names, types and sample rows. Don't guess them.
- **When a test fails on a backend assertion:** look at what's actually there. `db_query` shows the row, `kafka_peek` the topic, `redis_get` the key and `neo4j_read` the graph. Compare it with what the test expected.
- **Before writing tests, when the project has [standards](./qa-standards):** `standards`, then the pages that apply. The server's instructions say so when there are any.
- **When tests fail before reaching the code under test** (a connection refused, a missing package, a config error): `doctor`, then `doctor` with `fix: true` for what it can fix.
- **When a test needs a backend the project doesn't have yet:** `fixtures_list`, then `fixture_add` to see the plan, then again with `apply: true`.
- **After changing tests:** `check_tests`, and fix what it reports; then `run_tests` with the IDs of the tests you changed.
- **When a test fails:** the `failedStep` and `errors` of `run_tests` or `last_failures` first. The `recent` outcomes tell a new failure (your change) from one that keeps coming back (`flaky_tests`, and the [flaky tests guide](./flaky-tests)).
- **Before writing API tests by hand:** `generate_api_tests` for what the spec already gives.

The tests still create their own data through the fixtures (`databaseClient.insert`, `testData`, ...). The MCP server is for looking around, not for setting up test data.

---

## Options

| Option | Default | |
|---|---|---|
| `--environment`, `-e <name>` | `PW_ENVIRONMENT`, else `local` | Environment from `environments.json` |
| `--allow-writes` | off | Offer the write tools. Ignored in production |
| `--allow-prod` | off | Allow a production environment, read-only |
| `--root <dir>` | nearest `package.json` | Project root: where `environments.json` and the tests are |

Backends that start in a container during test runs (`PW_DB_CONTAINER` and so on) aren't started by the MCP server, which connects to running services only. Start them with `docker compose -f compose.test.yaml up -d` and point the environment at them.
