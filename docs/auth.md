# Auth: Tokens and Roles

Two kinds of login plumbing every suite needs, built in:

- **API tokens:** OAuth 2.0 / OIDC access tokens for your test identities, fetched once per worker, refreshed before they expire, and sent on `openApiClient`, `graphqlClient` and `grpcClient` calls automatically.
- **Browser roles:** each role logs in once in a setup project, its browser state is saved, and tests start already logged in with `test.use({ authRole: 'admin' })`. There are no login steps in the tests.

The same `authRole` picks both: an `admin` test gets the admin's token *and* the admin's browser session.

---

## Configure roles and the token endpoint

```json
// environments.json
{
    "environments": {
        "stg": {
            "auth": {
                "issuer": "https://login.stg.example.com/realms/app",
                "clientId": "e2e-tests",
                "scope": "openid api",
                "defaultRole": "viewer",
                "roles": {
                    "admin":  { "username": "admin@example.test" },
                    "viewer": { "username": "viewer@example.test" },
                    "service": {}
                }
            }
        }
    }
}
```

- **`issuer`:** the token endpoint is read from its `/.well-known/openid-configuration`. Use **`tokenUrl`** instead for servers with no discovery document.
- **Grant per role:** a role with a `username` uses the **password grant**; one without uses **client credentials**. Set `grantType` to force one.
- **Overriding top-level settings:** a role's `clientId`, `clientSecret` and `scope` override the top-level ones, for roles that use a different client.
- **Extra login data:** `extra` holds anything else the login steps need, such as an OTP secret or a tenant.

**Keep secrets out of the file.** Set them with variables, or map them from a [secrets provider](./secrets) with `keyMappings` (for example `"admin-password": "auth.roles.admin.password"`):

| Variable | Sets |
|---|---|
| `PW_AUTH_ISSUER`, `PW_AUTH_TOKEN_URL` | Where tokens come from |
| `PW_AUTH_CLIENT_ID`, `PW_AUTH_CLIENT_SECRET` | The client (sent with HTTP Basic; `PW_AUTH_CLIENT_AUTH=post` sends form fields) |
| `PW_AUTH_SCOPE`, `PW_AUTH_AUDIENCE`, `PW_AUTH_GRANT_TYPE` | Token request options |
| `PW_AUTH_USERNAME`, `PW_AUTH_PASSWORD` | Credentials of the default role, when you don't use `roles` |
| `PW_AUTH_ROLE` | The default role |
| `PW_AUTH_STATE_DIR` | Where browser login state is saved (default `.auth`) |

---

## API tokens

With a token endpoint configured, `openApiClient`, `graphqlClient` and `grpcClient` send `Authorization: Bearer <token>` for the test's role on every request (for gRPC, as `authorization` metadata). A token close to expiry (60 s by default, `refreshBeforeExpiry`) is refreshed with the refresh token when there is one, or a new grant otherwise.

```typescript
import { test, expect } from '@inluxc/propmaster';

test.describe('Orders API', () => {
    test.use({ authRole: 'admin' });

    test('[TC-API-NNN] admins can list all orders', { tag: ['@TC-API-NNN'] }, async ({ openApiClient }) => {
        await test.step('Step 1: List orders as admin', async () => {
            const res = await (openApiClient.client as any).listOrders(); // sends the admin's token
            expect(res.status).toBe(200);
        });
    });
});
```

The token is also available directly:

| Fixture | What it is |
|---|---|
| `authToken` | The access token for the test's role |
| `authHeaders` | `{ Authorization: 'Bearer <token>' }`, e.g. for `fetch` or `page.setExtraHTTPHeaders` |
| `authRequest` | A Playwright `APIRequestContext` that sends the token, with the OpenAPI base URL (or `baseURL`) |
| `authTokens` | The worker's token manager, e.g. `authTokens.invalidate('admin')` after revoking a token |

```typescript
test('[TC-API-NNN] viewers cannot delete orders', { tag: ['@TC-API-NNN'] }, async ({ authRequest }) => {
    await test.step('Step 1: Delete as the default role (viewer)', async () => {
        const res = await authRequest.delete('/orders/1');
        expect(res.status()).toBe(403);
    });
});
```

- **A header you set wins.** Passing your own `Authorization` (for example a bad token, to test a 401) is never overwritten.
- **`applyTo`** (`['openapi']`, `['graphql']`, `['grpc']`, a combination, or `[]`) limits which clients get the token automatically. By default all three do; gRPC gets it as `authorization` metadata.
- **`graphql.authToken`** and **`grpc.authToken`**, when set, win over the auth token for that client.
- **Each worker caches its own tokens.** Concurrent requests for one role share a single token request.

---

## Browser roles

### 1. Create the setup file

```bash
npx propmaster auth-setup admin viewer
```

This writes `tests/e2e/auth.setup.ts`. Replace the placeholder steps with your app's login:

```typescript
import { expect, setupAuth } from '@inluxc/propmaster';

setupAuth({
    roles: ['admin', 'viewer'],
    maxAgeMinutes: 30, // reuse a saved login for 30 minutes between runs
    login: async ({ page }, { username, password }) => {
        await page.goto('/login');
        await page.getByLabel('Email').fill(username!);
        await page.getByLabel('Password').fill(password!);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page).not.toHaveURL(/login/);
    },
});
```

`setupAuth` registers one setup test per role. Each runs `login` in a fresh browser context and saves the result to `.auth/<role>.json`, which `init` adds to `.gitignore`. Credentials come from `auth.roles.<role>`, merged over the top-level settings.

### 2. Run it before the browser tests

Projects created by `propmaster init` already have this in `tests/e2e/projects.ts`. For an existing config, add a setup project and make the browser projects depend on it:

```typescript
{ name: 'e2e-setup', testDir: './tests/e2e', testMatch: /.*\.setup\.ts/, use: { auth: config.auth } },
{ name: 'e2e-chromium', testDir: './tests/e2e', dependencies: ['e2e-setup'], use: { ...devices['Desktop Chrome'], auth: config.auth } },
```

### 3. Pick a role in tests

```typescript
test.describe('Admin settings', () => {
    test.use({ authRole: 'admin' });

    test('[TC-BRW-NNN] admin sees the billing page', { tag: ['@TC-BRW-NNN'] }, async ({ page }) => {
        await test.step('Step 1: Open billing', async () => {
            await page.goto('/settings/billing'); // already logged in as admin
            await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
        });
    });
});
```

A test without `authRole` keeps the project's own `storageState`, and starts signed out if there is none.

### Logins with 2FA or email codes

When the login needs other fixtures, such as `otpClient` or `inboxClient`, write the setup test yourself and use the helpers:

```typescript
// tests/e2e/auth.setup.ts
import { test, authCredentials, saveAuthState } from '@inluxc/propmaster';

test('log in as admin', async ({ page, context, otpClient }) => {
    const { username, password, extra } = authCredentials('admin');
    await page.goto('/login');
    await page.getByLabel('Email').fill(username!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Code').fill(await otpClient.generateTotp(extra.otpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await saveAuthState(context, 'admin');
});
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error reading storage state from .auth/<role>.json` | The role was never logged in. Run the setup project (it runs automatically through `dependencies`), and check that `setupAuth` lists the role |
| `unknown role; configured roles: ...` | `authRole` names a role that isn't under `auth.roles` |
| `token request failed with 401 (invalid_client: ...)` | Wrong client ID or secret, or the server expects `clientAuth: 'post'` |
| `the password grant needs a username and password` | The role has no credentials: set `auth.roles.<role>` or `PW_AUTH_USERNAME`/`PW_AUTH_PASSWORD` |
| Setup logs in as `default` with no username | The roles are only in a project's `use` block. Pass `roles: [...]` to `setupAuth` |
| Requests have no token | No `issuer`/`tokenUrl`, or `applyTo` excludes that client |

Error messages name the endpoint, role, client ID and the server's error. Secrets and tokens never appear in them, and recorded headers are redacted.
