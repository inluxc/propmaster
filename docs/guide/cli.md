# The CLI

`npx propmaster` scaffolds projects, checks test conventions, hands out TestCaseIDs, ranks flaky tests, generates API tests and starts the MCP server. `npx propmaster --help` lists every command and option.

```
  ┌─┐┬─┐┌─┐┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐┬─┐
  ├─┘├┬┘│ │├─┘│││├─┤└─┐ │ ├┤ ├┬┘
  ┴  ┴└─└─┘┴  ┴ ┴┴ ┴└─┘ ┴ └─┘┴└─
  v1.0.0

? What do you want to do? ↑/↓ move · enter pick · type to filter
❯ init  scaffold the test layout here
  organize  see where existing tests belong
  generate openapi  API tests from the OpenAPI spec
  ...
```

## Adding and removing fixtures

`propmaster fixture add` sets a fixture up in the project, so it works before you write the first test:

```bash
npx propmaster fixture add                       # pick from a menu
npx propmaster fixture add redis database:mysql  # or name them: asks nothing
npx propmaster fixture add s3 --dry-run          # show the plan, change nothing
```

```
  Add redis
    + package   ioredis
    + config    environments.json: redis in local, dev, stg (CHANGE_ME outside local)
    + variables .env.example: PW_REDIS_HOST, PW_REDIS_PORT, PW_REDIS_PASSWORD
    + service   compose.test.yaml: redis
    + test      tests/integration/redis.spec.ts [TC-RDS-001]
```

| What | Where |
|---|---|
| The driver | installed as a dev dependency with the project's package manager (npm, pnpm, yarn or bun, from the lock file) |
| Its config | a block in every environment of `environments.json`: values for the local services in `local`, `CHANGE_ME` in the others for you to fill in. Only those keys change: the rest of the file keeps its formatting |
| Its variables | a marked section in `.env.example`, skipped for variables already there |
| A service | in `compose.test.yaml`, the same image and port Propmaster's own tests use, so `docker compose -f compose.test.yaml up -d --wait` starts the backend |
| A starter test | in `tests/<type>/`, with the next free TestCaseID; it passes against that service, ready to replace with your own |

It adds only what's missing, so running it again changes nothing. `+` lines are changes, `·` lines are already there, and `!` lines need a look. For example, an existing `database` block of another `type` is kept, and the plan says to change it.

Some fixtures come in variants, picked from a menu or after a colon: `database:postgresql|mysql|mssql|sqlite`, `kafka:kafkajs|confluent` and `search:elasticsearch|opensearch`. The first is the default.

| Option | |
|---|---|
| `--no-service` | No `compose.test.yaml` service (the backend runs elsewhere) |
| `--no-test` | No starter test |
| `--no-install` | Change the files only; prints the package command to run |
| `--dry-run` | Show the plan and change nothing |
| `--root <dir>` | The project (default: the nearest `package.json`) |

`propmaster fixture remove redis` undoes it. While tests still use the fixture it refuses and names them; the starter test goes too if you haven't changed it. It takes out only what add would have written. A config block holding your own values (a real `dev` host, say) stays, and so does a compose service you changed, and the plan lists them. Shared pieces stay while another fixture needs them: removing `s3` keeps the AWS endpoint, variables and Moto service that `sqs` still uses.

`propmaster fixture list` shows every fixture and which ones the project has (`--json` for scripts). Agents can do all of this through the [MCP server](../mcp-server#project-tools-always-on).

## Doctor

`propmaster doctor` checks the setup and says how to fix each problem, before a test run trips over it:

```bash
npx propmaster doctor              # the active environment (PW_ENVIRONMENT, else local)
npx propmaster doctor -e stg       # another one
npx propmaster doctor --fix        # apply the safe fixes, then check again
```

```
  ✔ node      Node.js 24.12.0
  ✔ config    environment "local" loads
  ✖ drivers   tests use redisClient, but ioredis isn't installed.
              → npm install --save-dev ioredis  (--fix)
  ✖ backends  database at localhost:5432 doesn't answer.
              → docker compose -f compose.test.yaml up -d --wait postgres
  ! playwright playwright.config.ts doesn't use the Propmaster reporter, so there's no test history ...
  ✖ secrets   .env.local isn't in .gitignore: secrets in it could be committed.
              → add .env.local to .gitignore  (--fix)

  3 problems, 1 warning. `propmaster doctor --fix` fixes 2 of them.
```

| Check | What it looks at |
|---|---|
| `node` | Node.js is 22.12 or newer |
| `config` | `environments.json` exists, has the environment, and has a block for every fixture the tests use (`--fix` adds it, as `fixture add` would). Values still `CHANGE_ME` are a warning |
| `drivers` | The driver for each fixture the tests use is installed, in `node_modules` and not just in `package.json`, for the variant the config asks for (`mysql2` for `"type": "mysql"`). `--fix` installs it |
| `backends` | Each configured backend accepts a connection. One the tests use is a problem; one no test uses yet is a warning. When `compose.test.yaml` has its service, the fix is the command that starts it. `--offline` skips this |
| `playwright` | A `playwright.config.*`, the Propmaster reporter in it, a `tsconfig.json`, and, when tests use a browser, the browsers it names |
| `ci` | The Playwright image in your CI files (`mcr.microsoft.com/playwright:vX.Y.Z`) is the installed `@playwright/test` version. `--fix` updates the tag |
| `secrets` | `.env` files are in `.gitignore` (`--fix` adds them) and not committed |
| `mcp` | An editor is set up to start the MCP server (`--fix` sets up the editors the project uses), and the server starts for the environment, in its own process over stdio, as `mcp setup --check` starts it |
| `tests` | The test conventions (`propmaster check`) and `quarantine.json` |

`✖` is a problem and makes the exit code 1; `!` is a warning and doesn't. `--fix` applies only the fixes marked `(--fix)`: installing packages, adding config placeholders, `.gitignore` entries and the CI image tag. It prints the rest. `--problems` hides what passed, and `--json` is for scripts. Agents run it through the [MCP server](../mcp-server#project-tools-always-on)'s `doctor` tool.

## MCP server setup

`propmaster mcp setup` connects the MCP server to your editors: Claude Code, VS Code, Cursor, Windsurf and Zed. It picks them from a menu, with the ones the project uses already selected, adds the entry next to the servers already in each file, and changes nothing the second time. `--check` starts the server as the editor would and lists its tools; `--remove` takes it out again. See [Setup](../mcp-server#setup).

## Failures

`propmaster failures` shows what failed in the last run and why: the step, the error, where it was thrown and the trace to open, with each test's recent history. The Propmaster reporter writes it after every run. See [What failed in the last run](../flaky-tests#what-failed-in-the-last-run).

## QA standards

`propmaster standards init` writes a sample `propmaster.standards.json` and `standards/` pages; `propmaster check` then enforces the team's rules alongside the built-in conventions. See [QA standards](../qa-standards).

## Adding environments

`propmaster env add stg --from dev` adds an environment copied from another, with `CHANGE_ME` for you to fill in, no credentials, and a `.env.stg` listing its variables. `--prod` marks a production environment. `propmaster env list` shows them all. See [Adding an environment](./configuration#adding-an-environment).

## Interactive use

Run `npx propmaster` with no command in a terminal and it offers the commands in a menu. Commands ask for what you leave out, with a menu wherever the answer is one of a fixed list:

```bash
npx propmaster next-id          # pick the category from a menu, each with its next free ID
npx propmaster next-id API      # no menu: prints TC-API-005
```

| Prompt | Keys |
|---|---|
| Pick one | <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to pick, type to filter, <kbd>Backspace</kbd> to widen the filter again |
| Pick several | the same, and <kbd>Space</kbd> to select or clear an item |
| Yes or no | <kbd>y</kbd>, <kbd>n</kbd>, or <kbd>Enter</kbd> for the answer shown in capitals |
| Text | type, <kbd>Backspace</kbd>, <kbd>Ctrl</kbd>+<kbd>U</kbd> to clear; <kbd>Enter</kbd> takes the default in brackets |

<kbd>Esc</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd> cancels (exit code 130).

Menus are drawn on stderr, so a command's own output can still be piped: `npx propmaster next-id | pbcopy` asks for the category, then copies only the ID.

## In scripts and CI

Every answer can be given as an argument or flag, and then nothing is asked. With no terminal to ask in (stdin or stderr isn't a terminal, or `CI` is set), a command never waits: it stops with exit code 2 and says which flag to pass.

## Banner and version

Commands you run yourself (`init`, `mcp setup`, `doctor`, `fixture`, `env`, `standards`, `organize`, `auth-setup`, `generate`, `flaky`, `--help`) start with the logo and version. It's left out when the output isn't a terminal, in CI, with `--json` or `--quiet`, and when `PROPMASTER_NO_BANNER` is set. `propmaster mcp` (the server) never prints it: its output is the MCP protocol.

```bash
npx propmaster --version        # or -v: prints just the version, e.g. 1.0.0
```

Colours follow [NO_COLOR](https://no-color.org): `NO_COLOR=1` turns them off, `FORCE_COLOR=1` on when the output isn't a terminal.
