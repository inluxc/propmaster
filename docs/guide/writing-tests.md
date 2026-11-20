# Writing Tests

Stagehand ships a convention checker that keeps a growing suite traceable. A failure report should point to one test ID and the step that broke. These conventions are optional, but `stagehand init` sets projects up to use them.

## The shape of a test

```typescript
import { test, expect } from '@inluxc/stagehand';

test.describe('Users API', () => {
    test('[TC-API-001] create user returns 201', { tag: ['@TC-API-001'] }, async ({ openApiClient }) => {
        const { client } = openApiClient;
        let userId: string;

        await test.step('Step 1: Send POST /users with a valid body', async () => {
            const res = await (client as any).createUser(null, { name: 'Alice', email: 'alice@example.com' });
            expect(res.status).toBe(201);
            userId = res.data.id;
        });

        await test.step('Step 2: Fetch the user by ID', async () => {
            const res = await (client as any).getUser({ id: userId });
            expect(res.data.email).toBe('alice@example.com');
        });
    });
});
```

The four rules:

1. **A test ID at the start of the title**, in the form `[TC-XXX-NNN]`. `XXX` is a short category code (`API`, `DB`, `KFK`, `RDS`, `MDB`, `NEO`, `GQL`, `BRW`, `APM`, `OTP`, or your own).
2. **The same ID as a tag**, so you can run one test with `--grep @TC-API-001`.
3. **IDs are unique across the whole project** and never reused, even after a test is deleted.
4. **Every test body is split into `test.step()` calls.** Steps appear in the HTML report, the trace viewer and CI logs, so a failure names the step that broke.

Import `test` from `@inluxc/stagehand` (or your own fixtures file), never from `@playwright/test`. Only Stagehand's `test` has the fixtures registered.

## Getting the next ID

Don't search for the highest ID by hand. Ask the checker:

```bash
npx stagehand next-id API        # → TC-API-005
npx stagehand next-id DB 3       # → TC-DB-012, TC-DB-013, TC-DB-014
npx stagehand check --list-ids   # every ID in use, with file:line
```

For tests generated in a loop, put an ID in each data row:

```typescript
const cases = [
    { id: 'TC-BRW-010', width: 375 },
    { id: 'TC-BRW-011', width: 768 },
];

for (const c of cases) {
    test(`[${c.id}] layout at ${c.width}px`, { tag: [`@${c.id}`] }, async ({ page }) => {
        await test.step(`Step 1: Resize to ${c.width}px`, async () => {
            await page.setViewportSize({ width: c.width, height: 900 });
        });
    });
}
```

## Checking conventions

```bash
npx stagehand check           # exits 1 and names the rule and fix for each violation
npx stagehand check --json    # { ok, violations: [{ file, line, rule, test, message }] }
```

| Rule | What it catches |
|---|---|
| `tc-id` | Title doesn't start with `[TC-XXX-NNN]` |
| `tc-tag` | Missing or mismatched `{ tag: ['@TC-XXX-NNN'] }` |
| `tc-unique` | The same ID used twice |
| `test-step` | A test body with no `test.step()` |
| `import` | A test file importing `test` from `@playwright/test` |

Run it in CI next to `tsc` so a violation fails the build. To change which folders it scans, add a `stagehand` key to `package.json`:

```json
{
    "stagehand": {
        "testDirs": ["tests"],
        "testFileSuffixes": [".spec.ts", ".prop.ts"],
        "exemptDirs": ["tests/unit/", "tests/properties/"],
        "docFiles": ["AGENTS.md", "SKILLS.md"]
    }
}
```

## Assert expected failures explicitly

When a call should fail, assert the status. Don't wrap it in `try`/`catch`: that passes silently if the call succeeds. For OpenAPI calls, pass `validateStatus` so non-2xx responses resolve instead of throwing:

```typescript
await test.step('Step 1: Request a user that does not exist', async () => {
    const res = await (client as any).getUser({ id: 'missing' }, null, { validateStatus: () => true });
    expect(res.status).toBe(404);
});
```

## Isolate test data

Tests run in parallel, so give each run its own data and clean it up:

- **Redis:** set `PW_REDIS_KEY_PREFIX` (for example `test:ci-${GITHUB_RUN_ID}:`) so runs never share keys.
- **Neo4j and MongoDB:** tag created nodes or documents with a unique run ID and delete them in `afterEach`.
- **SQL:** use parameterized queries, never string interpolation, and delete what the test inserted.

## Working with AI agents

The repository's [AGENTS.md](https://github.com/inluxc/stagehand/blob/main/AGENTS.md) and [SKILLS.md](https://github.com/inluxc/stagehand/blob/main/SKILLS.md) teach coding agents these conventions with templates for each fixture. `stagehand init` copies both into new projects, and `stagehand check` also checks the code samples inside them.
