# Inbox Fixture

The `inboxClient` fixture reads the email your application sends, so a test can finish a flow that goes through someone's inbox: sign-up verification, password reset, magic links and emailed one-time codes. It's backed by [Mailpit](https://mailpit.axllent.org/), a test mail server: your app sends to Mailpit over SMTP, and the fixture reads the messages through Mailpit's API.

---

## What It Does

- Gives each test its own email address (`uniqueAddress()`), so parallel tests never read each other's mail
- Waits for a message by recipient, sender, subject, time or any condition, and fails with a readable error naming what arrived instead
- Extracts one-time codes and links (`href`s and bare URLs, with HTML entities decoded)
- Deletes the test's mail when it ends
- Can start Mailpit itself in a container for the run (`PW_INBOX_CONTAINER=true`)

SMS isn't covered yet. The client is built on an `InboxProvider` interface so other providers can be added.

---

## Setup

### Install

Nothing extra: the fixture uses Node's built-in `fetch`. You need a Mailpit server, so pick one of these:

```bash
# Locally, with the repo's compose file
docker compose -f compose.test.yaml up -d --wait mailpit

# Or let the test run start one (needs Docker and testcontainers)
npm install --save-dev testcontainers
PW_INBOX_CONTAINER=true npx playwright test
```

### Point your app at Mailpit

Configure the application under test to send email to Mailpit's SMTP server, which listens on port `1025` by default with no authentication or TLS. For example, set `SMTP_HOST=localhost` and `SMTP_PORT=1025` in the app's test environment. When the fixture starts Mailpit itself, `inboxClient.smtp` has the host and port to give your app.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_INBOX_URL` | Yes (unless container) | Mailpit's web/API URL, e.g. `http://localhost:8025` |
| `PW_INBOX_SMTP_HOST`, `PW_INBOX_SMTP_PORT` | No | Where your app sends mail; exposed as `inboxClient.smtp` |
| `PW_INBOX_DOMAIN` | No | Domain for `uniqueAddress()` (default: `test.local`) |
| `PW_INBOX_TIMEOUT` | No | Default `waitForMessage()` timeout in ms (default: `30000`) |
| `PW_INBOX_USERNAME`, `PW_INBOX_PASSWORD` | No | Basic auth, when Mailpit's UI is protected (`MP_UI_AUTH`) |
| `PW_INBOX_CONTAINER` | No | `true` (or an image) starts Mailpit for the run; see [Testcontainers](./testcontainers) |

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "inbox": { "url": "http://localhost:8025", "smtpHost": "localhost", "smtpPort": 1025 }
        },
        "stg": {
            "inbox": { "url": "https://mailpit.stg.internal", "domain": "stg-mail.test", "username": "qa" }
        }
    }
}
```

Keep `password` out of the file; set `PW_INBOX_PASSWORD` or use a [secrets provider](./secrets).

### Configuration via `playwright.config.ts`

```typescript
{
    name: 'e2e-chromium',
    testDir: './tests/e2e',
    use: {
        inbox: { url: 'http://localhost:8025', timeout: 15_000 },
    },
},
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | — | Mailpit API URL |
| `smtpHost` / `smtpPort` | `string` / `number` | — | Where your app sends mail (informational) |
| `domain` | `string` | `test.local` | Domain for unique addresses |
| `timeout` | `number` | `30000` | Default wait in ms |
| `pollInterval` | `number` | `500` | How often to check for mail, in ms |
| `username` / `password` | `string` | — | Basic auth for Mailpit's API |
| `container` | `boolean \| ContainerOptions` | — | Start Mailpit in a container |

---

## Usage

### Sign up in the browser, then confirm the email

A complete flow: the browser fills the sign-up form with a fresh address, the app emails a verification link, and the test opens it.

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-EML-NNN] a new user confirms their email', { tag: ['@TC-EML-NNN'] }, async ({ page, inboxClient }) => {
    const email = inboxClient.uniqueAddress('signup');

    await test.step('Step 1: Sign up with a fresh address', async () => {
        await page.goto('/signup');
        await page.getByLabel('Email').fill(email);
        await page.getByLabel('Password').fill('Corr3ct-Horse');
        await page.getByRole('button', { name: 'Create account' }).click();
        await expect(page.getByText('Check your inbox')).toBeVisible();
    });

    let link = '';
    await test.step('Step 2: Read the verification link from the email', async () => {
        const message = await inboxClient.waitForMessage({ to: email, subject: 'Confirm your email' });
        link = inboxClient.extractLink(message, '/verify');
    });

    await test.step('Step 3: Open the link and land on the dashboard', async () => {
        await page.goto(link);
        await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
    });
});
```

### Read an emailed login code

```typescript
const message = await inboxClient.waitForMessage({ to: email, subject: /login code/i });
const code = inboxClient.extractCode(message);              // first 6-digit number
const pin = inboxClient.extractCode(message, /PIN: (\w+)/); // first capture group
```

`extractCode` looks in the text body, then the visible text of the HTML, then the subject.

### Pick a message, or check none was sent

```typescript
// Only mail that arrived after this point
const since = new Date();
await page.getByRole('button', { name: 'Resend' }).click();
const resent = await inboxClient.waitForMessage({ to: email, since });

// Any condition
const invoice = await inboxClient.waitForMessage({ to: email, where: (m) => m.links.some((l) => l.includes('/invoices/')) });

// Everything for an address right now, newest first
const all = await inboxClient.messages({ to: email });

// Nothing should be sent (with InboxSteps)
await new InboxSteps(inboxClient).verifyNoMessage('Verify no email is sent for a failed sign-up', { to: email }, 2_000);
```

### With the Steps class

```typescript
import { InboxSteps } from '@inluxc/propmaster/steps';

const inbox = new InboxSteps(inboxClient);
const email = await inbox.createAddress('Create an address for the user', 'reset');
// ... trigger the email in the app ...
const message = await inbox.waitForMessage('Wait for the reset email', { to: email, subject: 'Reset' });
await inbox.verifyMessage('Check the sender', message, { from: 'no-reply@app.example.com' });
const link = await inbox.extractLink('Extract the reset link', message, '/reset/');
```

### API Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `uniqueAddress(prefix?)` | `string` | A fresh address, e.g. `signup-lq2k3x9f@test.local`; its mail is deleted after the test |
| `waitForMessage(query)` | `Promise<InboxMessage>` | Newest match; waits up to `query.timeout` |
| `messages(query?)` | `Promise<InboxMessage[]>` | Matches right now, newest first |
| `extractCode(message, pattern?)` | `string` | A one-time code (default `/\b(\d{6})\b/`) |
| `extractLink(message, match?)` | `string` | First link containing `match` (substring or pattern) |
| `deleteAll({ to? })` | `Promise<void>` | Deletes an address's mail, or everything |
| `send({ from, to, subject, text?, html? })` | `Promise<void>` | Sends through Mailpit, to stand in for your app in tests |
| `smtp` | `{ host, port } \| undefined` | Where your app should send |

A query takes `to`, `from`, `subject` (substring or pattern), `since` and `where`. An `InboxMessage` has `id`, `from`, `to`, `cc`, `subject`, `text`, `html`, `date` and `links`.

---

## Lifecycle

1. **Setup:** loads the config, starts Mailpit if `container` is set, and checks the API answers.
2. **Test:** use the client; every `uniqueAddress()` is recorded.
3. **Teardown:** deletes the mail sent to the test's unique addresses. Mail to other addresses is left alone.

---

## Error Handling

- **`FixtureInitError`:** the inbox config is missing, or Mailpit can't be reached at `url`.
- **`FixtureOperationError` (`waitForMessage`):** nothing matched in time. The message names the query and lists up to five other messages that did arrive for that address, which usually shows the cause (a different subject, a typo in the address).
- **`FixtureOperationError` (`extractCode` / `extractLink`):** no match. The error lists the message's subject, or all of its links.
