# OpenAPI Client Fixture

The `openApiClient` fixture provides a typed HTTP client generated from your OpenAPI specification. It uses [openapi-client-axios](https://github.com/openapistack/openapi-client-axios) under the hood, giving you auto-generated methods for every operation defined in your spec.

---

## What It Does

- Loads an OpenAPI spec from a local file or remote URL
- Initializes an Axios-based client with typed operation methods
- Supports base URL override for targeting different environments
- Handles initialization timeouts for remote specs
- Provides both the Axios client instance and the underlying API object
- Optionally checks every request and response against the spec ([contract checks](#contract-checks))

To get a starting test for each operation, run [`propmaster generate openapi`](./guide/generate-api-tests.md).

---

## Setup

### Install

The driver is an optional peer dependency. Install it in your project:

```bash
npm install --save-dev openapi-client-axios
```

Install `js-yaml` too, for YAML spec files (JSON files and remote URLs don't need it):

```bash
npm install --save-dev js-yaml
```

Install `ajv` and `ajv-formats` for [contract checks](#contract-checks):

```bash
npm install --save-dev ajv ajv-formats
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_OPENAPI_SPEC_PATH` | Yes | Path to a local OpenAPI spec file or a remote URL |
| `PW_OPENAPI_BASE_URL` | No | Override base URL for API calls (takes precedence over spec server URLs) |
| `PW_OPENAPI_VALIDATE_RESPONSES` | No | `true` or `warn`: check every response against the spec |
| `PW_OPENAPI_VALIDATE_REQUESTS` | No | `true` or `warn`: check request bodies before they're sent |

### Spec Location: Local File or URL

`specPath` accepts either form:

- **Local file** — `./specs/api.yaml`, `specs/api.json`, or an absolute path. Relative paths resolve against the project root (the directory Playwright runs from, `process.cwd()`). The file is read from disk and parsed as JSON or YAML (`.yaml`/`.yml` as YAML, which needs `js-yaml` installed; anything else as JSON); no HTTP request is made for it.
- **URL** — anything starting with `http://` or `https://` is fetched when the client initializes, bounded by `initTimeout`.

```bash
PW_OPENAPI_SPEC_PATH=./specs/petstore.yaml                       # local file
PW_OPENAPI_SPEC_PATH=https://petstore.swagger.io/v2/swagger.json  # remote URL
```

### Configuration via `environments.json`

```json
{
  "environments": {
    "dev": {
      "openapi": {
        "specPath": "./specs/petstore.yaml",
        "baseUrl": "https://api.dev.example.com",
        "specTimeout": 10000,
        "initTimeout": 30000
      }
    }
  }
}
```

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'api',
      testMatch: '**/api/**/*.spec.ts',
      use: {
        openapi: {
          specPath: './specs/petstore.yaml',
          baseUrl: 'https://api.dev.example.com',
        },
      },
    },
  ],
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `specPath` | `string` | — | Local file path or remote URL to the OpenAPI specification |
| `baseUrl` | `string` | — | Override base URL (takes precedence over spec server URLs) |
| `specTimeout` | `number` | `10000` | Timeout in ms for remote spec retrieval |
| `initTimeout` | `number` | `30000` | Timeout in ms for client initialization |
| `validateResponses` | `boolean \| 'warn'` | `false` | Check each response's status, content type and body against the spec |
| `validateRequests` | `boolean \| 'warn'` | `false` | Check each request body against the spec before it's sent |

---

## Usage

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Pet Store API', () => {
  test('list all pets', async ({ openApiClient }) => {
    const { client } = openApiClient;
    const response = await (client as any).listPets();

    expect(response.status).toBe(200);
    expect(response.data).toBeInstanceOf(Array);
  });

  test('create and fetch a pet', async ({ openApiClient }) => {
    const { client } = openApiClient;

    const created = await (client as any).createPet(null, {
      name: 'Buddy',
      species: 'dog',
    });
    expect(created.status).toBe(201);

    const fetched = await (client as any).getPet({ petId: created.data.id });
    expect(fetched.data.name).toBe('Buddy');
  });
});
```

### Accessing the API Object

The `openApiClient` fixture provides two properties:

- **`client`** — An Axios instance extended with operation methods from the spec
- **`api`** — The underlying `OpenAPIClientAxios` instance (useful for advanced configuration)

```typescript
test('access api metadata', async ({ openApiClient }) => {
  const { client, api } = openApiClient;

  // Use the client for requests
  const res = await (client as any).getHealth();
  expect(res.status).toBe(200);
});
```

---

## Contract Checks

Responses are normally never compared with the spec, so a renamed, mistyped or missing field breaks consumers without failing a test. Turn on response validation and every call is checked:

```typescript
// playwright.config.ts
{ name: 'api', use: { openapi: { specPath: './openapi.yaml', validateResponses: true } } }
// or: PW_OPENAPI_VALIDATE_RESPONSES=true
```

Each response must:

- **Have a documented status.** The status code is looked up in the operation's `responses`, then its range (`4XX`), then `default`.
- **Have a documented content type** for that status (OpenAPI 3).
- **Have a body that matches the schema.** JSON bodies only; XML and other text bodies are skipped.

Non-2xx responses are checked as well: an error body is part of the contract. A mismatch fails the call with a `ContractError` that names every problem with its JSON path:

```
ContractError: The response from getPetById (GET /pet/{petId}) with status 200 (application/json) doesn't match the OpenAPI spec:
  - $.name: is required
  - $.id: must be integer (expected integer, got "abc")
  - $.tags[1].name: must be string (expected string, got 3)
  - $.status: must be one of the allowed values (expected ["available","pending","sold"], got "lost")
```

The full result is attached to the test as a JSON attachment (`contract response getPetById`) and added as a `contract-violation` annotation, so it shows in the HTML report.

| Setting | On a mismatch |
|---|---|
| `true` | The call throws `ContractError` |
| `'warn'` | A `contract-warning` annotation and an attachment; the test goes on. Use it to start on an API whose spec has drifted |
| `false` (default) | Nothing is checked |

`validateRequests` does the same for request bodies, before they're sent, which catches a test that sends an invalid body by mistake.

### Opting out for one call

A negative test sends an invalid body on purpose. Pass `contract` in the Axios config (the third argument):

```typescript
const ANY_STATUS = { validateStatus: () => true, contract: { request: false } } as const;

const res = await (client as any).createPet(null, { name: 42 }, ANY_STATUS); // still sent
expect(res.status).toBe(400);                                                  // the 400 body is still checked
await (client as any).getLegacyReport(null, null, { contract: false });       // no checks at all
```

### Checking one response explicitly

`checkResponse` and `OpenApiSteps.verifyMatchesSchema` work whether or not validation is on:

```typescript
import { OpenApiSteps } from '@inluxc/propmaster/steps';

const res = await (openApiClient.client as any).getInventory();

const result = await openApiClient.checkResponse(res);   // { operation, status, violations: [...], skipped? }
expect(result.violations).toEqual([]);

await new OpenApiSteps(openApiClient).verifyMatchesSchema(res); // a test step that throws ContractError
await new OpenApiSteps(openApiClient).verifyMatchesSchema(res, 'getInventory'); // pick the operation
```

### What is matched and supported

- **Operation:** found by HTTP method and path. Literal paths win over templates (`/pet/findByStatus` before `/pet/{petId}`), and query strings and a server base path (`/v2`) are ignored. A request that matches no operation is skipped, not failed. Calls such as a health check outside the spec keep working.
- **Spec versions:** Swagger 2.0, OpenAPI 3.0 and OpenAPI 3.1 (JSON Schema 2020-12).
- **Schemas:** `$ref`s (including recursive schemas, `components/responses` and `components/requestBodies`), `nullable` and `x-nullable`, boolean `exclusiveMinimum`/`exclusiveMaximum`, and the formats `date-time`, `email`, `uuid`, `int32` and the rest. Each schema is compiled once per test.
- **Not checked:** headers, query and path parameters, and non-JSON bodies.

---

## Lifecycle

1. **Setup** — Loads the OpenAPI spec, initializes the client with operation methods
2. **Use** — Provides `{ client, api, checkResponse }` to the test
3. **Teardown** — Clears internal references

---

## Error Handling

The fixture throws `FixtureInitError` when:

- `specPath` is not configured
- A local spec file does not exist, cannot be read, or is not valid JSON/YAML
- A remote spec cannot be fetched (network error, non-2xx response)
- Client initialization times out

```typescript
// Example error context:
// FixtureInitError: openApiClient/init — specPath: ./missing.yaml,
//   reason: OpenAPI spec file not found: /path/to/project/missing.yaml
```

With contract checks on, a call that breaks the spec throws `ContractError` (`kind`, `operation`, `status`, `contentType`, `violations`); for a non-2xx response its `cause` is the Axios error. Without `ajv` installed, the fixture throws `MissingPackageError` with the install command before the test starts.
