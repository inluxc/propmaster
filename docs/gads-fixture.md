# GADS Fixture

The `gadsDevice` and `gadsHub` fixtures run Appium tests on real devices from a [GADS](https://github.com/shamanec/GADS) device farm. GADS is a self-hosted farm. A **hub** serves the UI, the REST API and an Appium grid. One or more **providers** are hosts with iOS and Android devices attached. Tests only talk to the hub.

The fixture uses plain W3C WebDriver over HTTP, so it adds no dependencies.

---

## What It Does

- Opens an Appium session through the hub's grid endpoint, `POST <hub>/grid/session`. The hub picks a free device, or queues until one frees up.
- Picks the device by **platform**, by **UDID**, or by **name**. A name is a regex resolved to a UDID from `GET <hub>/grid/status`, and free devices come first.
- Gives the test a `gadsDevice` with the common WebDriver/Appium commands: find, click, type, text, source, screenshot, `mobile:` scripts, and app activate/terminate. A raw `command()` covers everything else.
- Ends the session and **releases the device** on teardown with `DELETE <hub>/grid/session/<id>`. This runs even when the test fails.
- Gives the test a `gadsHub` that checks hub status and lists devices without reserving any.
- Redacts the client secret from every error and from `gadsDevice.capabilities`.

---

## How GADS Clients Connect

| What | Where |
|------|-------|
| Appium / WebDriver endpoint | `http://<hub>:<port>/grid` (the hub is usually on port `10000`) |
| Authentication | `gads:clientSecret` capability. Create the secret under **Admin → Client credentials** in the GADS UI. GADS shows it only once. |
| Device selection | `appium:udid` pins a device. Otherwise `platformName` / `appium:automationName`, with an optional `appium:platformVersion` (exact, or major version) |
| Queueing | `gads:queueTimeout` sets how many seconds to wait for a free device. The hub default is 10 and the maximum is 300. |
| Idle release | The hub frees the device after `appium:newCommandTimeout` seconds without commands. The hub default is 60. |
| Device list | `GET /grid/status` with `Authorization: Bearer <clientSecret>` |

The hub adds `gads:deviceUdid`, `gads:deviceName`, `gads:provider` and `gads:controlUrl` to the session's capabilities. The fixture exposes these as `udid`, `name`, `provider` and `controlUrl`.

---

## Setup

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_GADS_HUB_URL` | Yes | Hub base URL, e.g. `http://gads-hub:10000` |
| `PW_GADS_CLIENT_SECRET` | Yes | Client secret, sent as `gads:clientSecret` |
| `PW_GADS_PLATFORM` | One of these three | `ios` or `android` |
| `PW_GADS_UDID` | One of these three | Pin one device |
| `PW_GADS_DEVICE_NAME` | One of these three | Regex matched against device names, case-insensitive |
| `PW_GADS_PLATFORM_VERSION` | No | `17.5.1` (exact) or `17` (major) |
| `PW_GADS_AUTOMATION_NAME` | No | Defaults to `XCUITest` (iOS) or `UiAutomator2` (Android) |
| `PW_GADS_QUEUE_TIMEOUT` | No | Seconds to wait for a free device |
| `PW_GADS_NEW_COMMAND_TIMEOUT` | No | Idle seconds before the hub releases the device |
| `PW_GADS_SESSION_TIMEOUT` | No | Session-creation timeout in ms (default 240000) |

Keep the client secret out of `environments.json`. Set it with `PW_GADS_CLIENT_SECRET`, in `.env.{environment}`, or through a [secrets provider](secrets.md) mapped to `gads.clientSecret`.

### Configuration via `environments.json`

```json
{
  "environments": {
    "local": {
      "gads": {
        "hubUrl": "http://localhost:10000",
        "clientSecret": "",
        "platform": "android",
        "deviceName": "Pixel",
        "queueTimeout": 60,
        "newCommandTimeout": 120,
        "capabilities": {
          "appium:appPackage": "com.example.app",
          "appium:appActivity": ".MainActivity"
        }
      }
    }
  }
}
```

### Configuration via `playwright.config.ts`

Session creation can wait for a free device, and it may install an app. Give the project a generous timeout:

```typescript
{
    name: 'mobile-gads',
    testMatch: '**/examples/gads.spec.ts',
    timeout: 300_000,
    use: {
        gads: config.gads,
    },
},
```

Use one project per platform to run the same specs on iOS and Android:

```typescript
{ name: 'gads-ios',     testMatch: '**/*.gads.spec.ts', use: { gads: { ...config.gads!, platform: 'ios' } } },
{ name: 'gads-android', testMatch: '**/*.gads.spec.ts', use: { gads: { ...config.gads!, platform: 'android' } } },
```

Each Playwright worker holds one device per test. Set `workers` no higher than the number of devices, or raise `queueTimeout`.

---

## Usage

```typescript
import { test, expect } from '@inluxc/stagehand';

test('[TC-GDS-NNN] log in on a farm device', { tag: ['@TC-GDS-NNN'] }, async ({ gadsDevice }) => {
    await test.step('Step 1: Launch the app', async () => {
        await gadsDevice.activateApp('com.example.app');
    });

    await test.step('Step 2: Fill in the login form', async () => {
        const email = await gadsDevice.waitForElement('accessibility id', 'email');
        await gadsDevice.sendKeys(email, 'user@example.com');
        await gadsDevice.click(await gadsDevice.findElement('accessibility id', 'login'));
    });

    await test.step('Step 3: Verify the welcome screen', async () => {
        const title = await gadsDevice.waitForElement('accessibility id', 'welcome-title', 15_000);
        expect(await gadsDevice.getText(title)).toContain('Welcome');
    });
});
```

### `gadsDevice` API

| Member | Description |
|--------|-------------|
| `sessionId`, `udid`, `name`, `provider`, `platform`, `controlUrl` | Session and device details from the hub |
| `capabilities` | Capabilities the hub returned, with the secret redacted |
| `webDriverUrl` | `<hub>/grid`. Pass it to WebdriverIO or another Appium client if you need its richer API. |
| `findElement(using, value)` / `findElements(using, value)` | Return element IDs. Strategies: `accessibility id`, `id`, `xpath`, `class name`, `-android uiautomator`, `-ios predicate string`, `-ios class chain` |
| `waitForElement(using, value, timeout?)` | Polls until found (default 10 s) |
| `click(id)`, `sendKeys(id, text)`, `clear(id)`, `getText(id)`, `isDisplayed(id)` | Element commands |
| `source()` / `screenshot()` | UI hierarchy XML and PNG `Buffer` |
| `execute(script, args?)` | e.g. `execute('mobile: swipe', [{ direction: 'up' }])` |
| `activateApp(appId)` / `terminateApp(appId)` | Bundle ID (iOS) or package name (Android) |
| `openUrl(url)` | Open a URL or deep link |
| `command(method, path, body?)` | Any WebDriver command relative to the session, e.g. `command('GET', '/orientation')` |
| `release()` | End the session early. Calling it again does nothing, and the fixture calls it on teardown anyway. |

### `gadsHub` API

| Member | Description |
|--------|-------------|
| `status()` | `{ ready, message, queued, devices }` |
| `listDevices(criteria?)` | Devices filtered by `platform`, `udid`, `deviceName` (regex) and `platformVersion`, free devices first |
| `hubUrl`, `webDriverUrl` | Base URLs |

### Steps class

```typescript
import { GadsSteps } from '../../src/steps';

const steps = new GadsSteps(gadsDevice, gadsHub);
await steps.launchApp('Launch the app', 'com.example.app');
await steps.fill('Enter the email', 'accessibility id', 'email', 'user@example.com');
await steps.tap('Submit the form', 'accessibility id', 'login');
await steps.expectText('Verify the greeting', 'accessibility id', 'welcome-title', /Welcome/);
await steps.attachScreenshot('Attach the final screen');
```

### Outside the fixture

`startGadsSession(config)` and `createGadsHubClient(config)` are exported for worker-scoped sessions or custom fixtures. Call `release()` yourself when you use them.

---

## Errors

| Error | When |
|-------|------|
| `FixtureInitError('gads', 'init')` | Config missing `hubUrl` or `clientSecret`. Also when nothing identifies a device, or no device matches `deviceName`. The message lists the known devices. |
| `FixtureInitError('gads', 'connect')` | Hub unreachable, invalid client secret (401), no device free within `queueTimeout` (404), or a provider error during session creation |
| `FixtureOperationError('gads', 'command')` | A WebDriver command failed or `waitForElement` timed out. The error includes the WebDriver message. |
| `FixtureOperationError('gads', 'release')` | The hub rejected the session delete. The fixture swallows this on teardown, because the hub frees the device after `newCommandTimeout` anyway. |

---

## Troubleshooting

- **401 `Invalid client credentials`**: create a new secret under Admin → Client credentials. A secret is shown only once.
- **404 `No available device found`**: every matching device is busy, or none has automation enabled. Raise `queueTimeout`, or check the device's usage setting in the GADS UI. Devices set to `control` or `disabled` are never given to automation.
- **Device stays busy after a crashed run**: the hub frees it after `newCommandTimeout` seconds. Keep that value low in CI.
- **BiDi / `webSocketUrl`**: the GADS grid strips it. Use classic WebDriver commands.
