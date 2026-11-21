# Generating API Tests

`propmaster generate openapi` writes a starting set of API tests from your OpenAPI spec (2.0, 3.0 or 3.1). It writes one file per tag in `tests/api/`, with a test for each operation and documented status code. The tests follow the [conventions](./writing-tests.md): each gets a TestCaseID from `next-id` and is broken into `test.step()` blocks, so `propmaster check` accepts the files as they are.

```bash
npx propmaster generate openapi --dry-run          # list what it would write
npx propmaster generate openapi                     # write tests/api/<tag>.spec.ts
npx propmaster generate openapi --tag pet           # only operations tagged "pet"
npx propmaster generate openapi --operation getPetById,deletePet
```

The spec comes from `openapi.specPath` in `environments.json` (or `PW_OPENAPI_SPEC_PATH`), or from `--spec <path|url>`.

---

## What it writes

```typescript
test.describe('pet', () => {
    test('[TC-API-014] getPetById: GET /pet/{petId} returns 200', {
        tag: ['@TC-API-014'],
        annotation: { type: 'openapi', description: 'getPetById 200' },
    }, async ({ openApiClient }) => {
        const client = openApiClient.client as any;
        let response: any;

        await test.step('Step 1: Send GET /pet/{petId}', async () => {
            response = await client.getPetById({
                petId: 1
            }, undefined, { validateStatus: () => true });
        });

        await test.step('Step 2: Verify the response status is 200', async () => {
            expect(response.status).toBe(200);
        });

        await test.step('Step 3: Verify the response body matches the OpenAPI spec', async () => {
            const { violations } = await openApiClient.checkResponse(response, 'getPetById');
            expect(violations).toEqual([]);
        });
    });
```

- **Requests** are built from the spec: required path, query and header parameters, and a JSON body. Values come from the schema's `example`, `default` or first `enum` value when it has one; otherwise from its type and format (`user@example.test` for `email`, an ISO date for `date-time`, the `minimum` for numbers). `readOnly` fields are left out of request bodies.
- **Every call passes `validateStatus: () => true`**, so an unexpected status fails on the status assertion and shows what came back, instead of throwing.
- **Step 3 checks the body against the spec** ([contract checks](../openapi-fixture.md#contract-checks)) when the response has a JSON schema and `ajv` is installed. Use `--no-contract` to leave it out.
- **The `annotation`** records which operation and status the test covers. The generator reads it on the next run.

## Which status codes run

| Documented status | Generated test |
|---|---|
| `2xx`, `2XX` | A valid request |
| `400` / `422`, on an operation with a JSON body that has required fields | The body is sent empty, with the request contract check off (`contract: { request: false }`) |
| `404`, on an operation with path parameters | The path parameters get values that shouldn't exist (`999999999`, `does-not-exist`) |
| Anything else (`401`, `403`, `409`, `5xx`, ...) | `test.fixme` with a TODO: only your API's data or credentials can cause it |
| `default` | No test |

A `404` stays `test.fixme` when the spec leaves no value that's sure to be missing, for example an ID limited to 1–10. Operations with form-data or multipart bodies are also `test.fixme`, because those requests need to be written by hand. Operations without an `operationId` are skipped and listed, because `openApiClient.client` has no method for them.

Operations that need credentials get a comment naming the security scheme. `openApiClient` sends the auth token itself once the [auth helpers](../auth.md) are configured.

## Running it again

The generator never changes an existing file. On each run it:

1. reads the `openapi` annotations in your tests and skips each operation/status pair that already has a test;
2. writes the new ones to a new file (`pet-2.spec.ts`, ...), with IDs after the ones already in use.

When the spec gains an operation or a status code, run it again to get tests for just those. Deleting a generated test and running it again brings the test back with a new ID. To stop that, keep the annotation on a test you rewrite.

## After generating

1. Replace the example values with data your API has: IDs that exist, valid references. For tests that create data, register a cleanup (`testData.cleanup(...)`).
2. Add assertions on the response body. The generated tests check only the status and the schema.
3. Resolve the TODOs and change `test.fixme` to `test`.
4. Run `npx propmaster check`, then `npx playwright test tests/api`.

## Against a Prism mock

[Prism](https://github.com/stoplightio/prism) serves a mock API from the spec, which is handy before the real API exists:

```bash
npx prism mock specs/api.yaml --port 4010
npx propmaster generate openapi --prism
PW_OPENAPI_BASE_URL=http://localhost:4010 npx playwright test tests/api
```

With `--prism`, every documented status code gets a runnable test: each request sends `Prefer: code=<status>`, and Prism answers with that response. Operations that need credentials get placeholder credentials, which Prism only checks for presence. This repository's CI generates tests from the Petstore spec this way and runs them against Prism.

## Options

| Option | Default | |
|---|---|---|
| `--spec <path\|url>` | `openapi.specPath` | JSON or YAML, local or remote |
| `--tag <tag>` | all | Only operations with this tag; repeatable or comma-separated |
| `--operation <id>` | all | Only these operationIds; repeatable or comma-separated |
| `--out <dir>` | `tests/api` | Where the files go |
| `--category <CODE>` | `API` | TestCaseID category |
| `--prism` | off | Every status runs, through `Prefer: code=<status>` |
| `--no-contract` / `--contract` | on when `ajv` is installed | The step that checks the body against the spec |
| `--import <module>` | `@inluxc/propmaster` | Where the tests import `test` and `expect` from |
| `--environment`, `-e` | `PW_ENVIRONMENT`, else `local` | Environment for the spec path |
| `--dry-run` | off | Print what would be written |
| `--root <dir>` | nearest `package.json` | Project root |
