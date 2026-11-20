# Getting Started

Stagehand extends [Playwright Test](https://playwright.dev/) with fixtures for the systems behind your UI: APIs, databases, message brokers, caches, mobile devices and OTP. You keep your Playwright config and tests. Stagehand adds more fixtures to request.

## Requirements

- Node.js 22.12 or newer
- `@playwright/test` (a peer dependency, so you choose the version)

## Install

```bash
npm install --save-dev @playwright/test @inluxc/stagehand
```

The database, Kafka, Redis, MongoDB, Neo4j and Appium drivers come with the package. You don't install them separately.

### Or scaffold a new project

`stagehand init` creates a project with a Playwright config, an `environments.json`, example tests and folders for page objects, test data and helpers:

```bash
npx stagehand init my-tests
```

## Your first test

Import `test` and `expect` from Stagehand instead of `@playwright/test`. Then request fixtures by name:

```typescript
// tests/users.spec.ts
import { test, expect } from '@inluxc/stagehand';

test('a new user is stored as active', async ({ openApiClient, databaseClient }) => {
    const { client } = openApiClient;

    await test.step('Create the user through the API', async () => {
        const res = await (client as any).createUser(null, { name: 'Alice', email: 'alice@example.com' });
        expect(res.status).toBe(201);
    });

    await test.step('Check the row in the database', async () => {
        const rows = await databaseClient.query<{ active: boolean }>(
            'SELECT active FROM users WHERE email = $1', ['alice@example.com'],
        );
        expect(rows[0].active).toBe(true);
    });
});
```

Point the fixtures at your services with environment variables:

```bash
PW_OPENAPI_SPEC_PATH=./openapi.yaml \
PW_OPENAPI_BASE_URL=http://localhost:3000 \
PW_DB_TYPE=postgresql PW_DB_HOST=localhost PW_DB_NAME=app \
PW_DB_USERNAME=app PW_DB_PASSWORD=app \
npx playwright test
```

For more than a couple of variables, keep them in [`environments.json` or `.env` files](./configuration) instead.

## Playwright fixtures still work

Stagehand's `test` is built on `@playwright/test`, so `page`, `request`, `context` and `browser` are all available, alongside Stagehand fixtures in the same test:

```typescript
import { test, expect } from '@inluxc/stagehand';

test('a user created through the API appears in the admin UI', async ({ openApiClient, page }) => {
    const { client } = openApiClient;
    await (client as any).createUser(null, { name: 'Alice', email: 'alice@test.com' });

    await page.goto('/admin/users');
    await expect(page.getByText('alice@test.com')).toBeVisible();
});
```

## Available fixtures

| Fixture | What it gives you | Guide |
|---|---|---|
| `openApiClient` | Typed HTTP client generated from an OpenAPI spec | [OpenAPI](../openapi-fixture) |
| `graphqlClient` | GraphQL queries, mutations and raw responses | [GraphQL](../graphql-fixture) |
| `databaseClient` | PostgreSQL, MySQL, MSSQL or SQLite queries | [Database](../database-fixture) |
| `mongoDbClient` | MongoDB CRUD and aggregation | [MongoDB](../mongodb-fixture) |
| `neo4jClient` | Neo4j Cypher reads, writes and transactions | [Neo4j](../neo4j-fixture) |
| `kafkaClient` | Kafka produce and consume | [Kafka](../kafka-fixture) |
| `redisClient` | Redis keys and pub/sub | [Redis](../redis-fixture) |
| `otpClient` | TOTP/HOTP codes for 2FA flows | [OTP](../otp-fixture) |
| `appiumDriver` | Appium session (WebdriverIO) on local Appium, a grid, a cloud farm or GADS | [Appium](../appium-fixture) |
| `gadsHub` | GADS hub status and device listing | [Appium → GADS](../appium-fixture#gads-preset) |

Need something else? [Write your own fixture](../custom-fixtures) on top of Stagehand's `test`.

## Next steps

- [Configuration](./configuration): environments, `.env` files and per-project settings
- [Writing Tests](./writing-tests): test IDs, steps and the convention checker
- [Running in CI](../ci): GitHub Actions jobs with real services
