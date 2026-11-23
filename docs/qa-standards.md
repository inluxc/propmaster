# QA Standards

Every team has its own testing rules: who owns a test, how it's named, what it must never do, how it's traced to a requirement. They usually live in a wiki that neither the agents writing tests nor the checker reads. Propmaster keeps them in the repository, in two halves:

- **Pages:** Markdown files in `standards/`, written by the team. The [MCP server](./mcp-server) hands them to agents, which read them before writing tests.
- **Rules:** `propmaster.standards.json`. `propmaster check` (and so `npm run lint:tests`, the `check_tests` tool and `propmaster doctor`) enforces them as `standard:<id>` violations, each linking to the page that explains it.

```bash
npx propmaster standards init     # a sample set to start from: rules and four pages
npx propmaster standards          # the rules and pages
npx propmaster check              # enforces them, with the built-in conventions
```

```
⚠ tests/api/orders.spec.ts:12  [standard:priority-tag] "[TC-API-004] refund"
    Needs a tag matching /^@p[0-3]$/, e.g. '@p1' (on the test or its describe). See standards/tagging.md#priority.
tests/api/orders.spec.ts:30  [standard:no-fixed-waits]
    `page.waitForTimeout()` isn't allowed here. See standards/writing-tests.md#waiting.
```

---

## The rules file

```json
{
    "pages": "standards",
    "rules": [
        { "id": "owner-tag", "type": "required-tag", "pattern": "^@owner-[a-z0-9-]+$", "example": "@owner-payments", "page": "tagging.md#owners" },
        { "id": "priority-tag", "type": "required-tag", "pattern": "^@p[0-3]$", "level": "warn", "page": "tagging.md#priority" },
        { "id": "no-fixed-waits", "type": "banned-call", "calls": ["page.waitForTimeout", "page.pause", "test.only"] },
        { "id": "e2e-steps", "type": "max-steps", "max": 12, "files": ["tests/e2e/"] }
    ]
}
```

Every rule has these settings:

| Setting | |
|---|---|
| `id` | Kebab-case name; violations are reported as `standard:<id>` |
| `type` | One of the rule types below |
| `level` | `error` (default) fails the check; `warn` is reported and doesn't |
| `page` | The page that explains it, in the pages folder: `tagging.md`, or `tagging.md#owners` for a section. It must exist |
| `message` | Replaces the default message |
| `files` / `exclude` | Only (or not) test files under these paths, e.g. `["tests/e2e/"]` |

`pages` is the folder of pages (default `standards`). A file that isn't valid fails the check with each problem listed: an unknown type, a bad regular expression, a missing page, a rule listed twice. Its rules don't apply until it's fixed.

## Rule types

| Type | Settings | Checks |
|---|---|---|
| `required-tag` | `pattern`, `example` | Each test has a tag matching `pattern`: in its `tag` option, on any `test.describe` around it, or in its title (`@smoke`) |
| `title-pattern` | `pattern` | Each test's title matches, checked without the `[TC-XXX-NNN]` prefix. Parameterized titles are skipped |
| `describe-pattern` | `pattern` | Each `test.describe` title matches |
| `banned-call` | `calls` | None of these is called, e.g. `page.waitForTimeout`, `page.pause`, `test.only`, `test.describe.only`. Calls in comments and strings don't count |
| `banned-pattern` | `pattern` | The source never matches, strings included: hard-coded hosts, `console.log`, a deprecated helper |
| `max-steps` | `max` | No test has more `test.step()` calls than this |
| `min-steps` | `min` | Each test has at least this many steps; a test using a `*Steps` class passes |
| `requirements-doc` | | Each test has a `/** @requirements ... */` comment: on the test, on a `test.describe` around it, or at the top of the file |

Patterns are JavaScript regular expressions written as JSON strings, so a backslash is doubled: `"\\d+"`.

## The pages

The pages are plain Markdown, one topic each, with a `# Title` and a first paragraph that says what the page is about. `standards init` writes four to start from:

| Page | |
|---|---|
| `README.md` | What the standards are and where each topic is |
| `writing-tests.md` | Titles, steps, no fixed waits |
| `tagging.md` | Owner and priority tags |
| `traceability.md` | `@requirements` comments |

Change them, add your own (`security.md`, `test-data.md`, ...) and point rules at the sections. Anything that can't be checked by a rule still belongs here: agents read every page.

## Agents

When the project has standards, the MCP server's instructions tell the agent to read them before writing tests. It reads them in either of two ways:

- **The `standards` tool:** with no arguments, the pages (file, title, summary) and the rules; with `page`, that page's text.
- **MCP resources:** `standards://tagging.md` and the like, for clients that show resources.

`check_tests` reports both kinds of violation: the rules at `error` level fail it, and those at `warn` come back as `warnings`.
