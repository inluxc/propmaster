# Appium Fixture

The `appiumDriver` fixture opens an [Appium](https://appium.io/) session with [WebdriverIO](https://webdriver.io/) and gives your test the WebdriverIO `Browser`. It works with any Appium-compatible server:

- a local `appium` server driving a device, emulator or simulator
- Selenium Grid, or a cloud farm (BrowserStack, Sauce Labs, LambdaTest and others) using their capabilities
- a **[GADS](https://github.com/shamanec/GADS)** self-hosted device farm, through the [GADS preset](#gads-preset)

The fixture deletes the session after each test, even when the test fails, so the device is freed.

---

## Setup

### Install

The driver is an optional peer dependency. Install it in your project:

```bash
npm install --save-dev webdriverio
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_APPIUM_SERVER_URL` | Yes | Server URL, e.g. `http://127.0.0.1:4723`. Keep any base path, such as `/wd/hub` for Appium 1. For GADS, use the hub URL. |
| `PW_APPIUM_PLATFORM` | Yes* | `ios` or `android`. Sets `platformName` and the default automation engine. |
| `PW_APPIUM_UDID` | No | Pin one device (`appium:udid`) |
| `PW_APPIUM_DEVICE_NAME` | No | `appium:deviceName`. For GADS, a regex matched against device names. |
| `PW_APPIUM_PLATFORM_VERSION` | No | `appium:platformVersion` |
| `PW_APPIUM_AUTOMATION_NAME` | No | Defaults to `XCUITest` (iOS) or `UiAutomator2` (Android) |
| `PW_APPIUM_APP` | No | App to install (`appium:app`): a path, a URL, or a farm app reference |
| `PW_APPIUM_CAPABILITIES` | No | JSON object of extra capabilities, e.g. `{"appium:bundleId":"com.example.app"}` |
| `PW_APPIUM_NEW_COMMAND_TIMEOUT` | No | Idle seconds before the server ends the session |
| `PW_APPIUM_SESSION_TIMEOUT` | No | Session creation timeout in ms (default 240000) |
| `PW_GADS_CLIENT_SECRET` | GADS only | Turns on the GADS preset. See below. |
| `PW_GADS_QUEUE_TIMEOUT` | GADS only | Seconds to wait for a free device |

\* Or set `platformName` in `capabilities`.

### Configuration via `environments.json`

```json
{
  "environments": {
    "local": {
      "appium": {
        "serverUrl": "http://127.0.0.1:4723",
        "platform": "android",
        "deviceName": "emulator-5554",
        "app": "./apps/example.apk",
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

Session creation can take a while, because the server may be installing an app or the farm may be queueing for a device. Give mobile projects a generous timeout. Run the same specs once per platform:

```typescript
{
    name: 'appium-android',
    testMatch: '**/*.mobile.ts',
    timeout: 300_000,
    use: { appium: { ...config.appium!, platform: 'android' } },
},
{
    name: 'appium-ios',
    testMatch: '**/*.mobile.ts',
    timeout: 300_000,
    use: { appium: { ...config.appium!, platform: 'ios', capabilities: { 'appium:bundleId': 'com.example.app' } } },
},
```

Each test holds one device. Keep `workers` at or below the number of devices you have.

---

## Usage

`appiumDriver` is a standard WebdriverIO `Browser`, so the whole [WebdriverIO API](https://webdriver.io/docs/api) is available:

```typescript
import { test, expect } from '@inluxc/stagehand';

test('[TC-APM-NNN] log in', { tag: ['@TC-APM-NNN'] }, async ({ appiumDriver }) => {
    await test.step('Step 1: Fill in the login form', async () => {
        await appiumDriver.$('~email').setValue('user@example.com');
        await appiumDriver.$('~password').setValue('secret');
        await appiumDriver.$('~login').click();
    });

    await test.step('Step 2: Verify the welcome screen', async () => {
        const title = appiumDriver.$('~welcome-title');
        await title.waitForDisplayed({ timeout: 15_000 });
        expect(await title.getText()).toContain('Welcome');
    });
});
```

Use Playwright's `expect` for assertions. WebdriverIO's own `expect` isn't loaded.

### Selectors

| Selector | Strategy |
|----------|----------|
| `~login` | Accessibility id (works on both platforms) |
| `id=com.example:id/email` | Resource id (Android) or name (iOS) |
| `//XCUIElementTypeButton[@name="OK"]` | XPath. Slow, so use it as a last resort. |
| `android=new UiSelector().text("OK")` | UiAutomator |
| `-ios predicate string:label == "OK"` | iOS predicate |
| `-ios class chain:**/XCUIElementTypeCell` | iOS class chain |

### Common commands

```typescript
await appiumDriver.execute('mobile: activateApp', { bundleId: 'com.example.app', appId: 'com.example.app' });
await appiumDriver.execute('mobile: swipe', { direction: 'up' });           // any Appium `mobile:` command
await appiumDriver.url('myapp://settings');                                 // deep link
const png = Buffer.from(await appiumDriver.takeScreenshot(), 'base64');
const xml = await appiumDriver.getPageSource();
if (appiumDriver.isIOS) { /* platform-specific branch */ }
```

### Steps class

`AppiumSteps` wraps common actions in `test.step()`:

```typescript
import { AppiumSteps } from '../../src/steps';

const steps = new AppiumSteps(appiumDriver);
await steps.launchApp('Launch the app', 'com.example.app');
await steps.fill('Enter the email', '~email', 'user@example.com');
await steps.tap('Submit the form', '~login');
await steps.expectText('Verify the greeting', '~welcome-title', /Welcome/);
await steps.attachScreenshot('Attach the final screen');
```

### Outside the fixture

`startAppiumSession(config)` returns a WebdriverIO `Browser`. Use it for worker-scoped sessions or in custom fixtures, and call `driver.deleteSession()` yourself when you're done.

---

## GADS Preset

[GADS](https://github.com/shamanec/GADS) is a self-hosted device farm. A **hub** serves the UI, the API and an Appium grid. **Providers** are hosts with iOS and Android devices attached. Tests only talk to the hub. To turn on the preset, add `gads` to the Appium config:

```json
"appium": {
  "serverUrl": "http://gads-hub:10000",
  "platform": "ios",
  "deviceName": "iPhone 15",
  "capabilities": { "appium:bundleId": "com.example.app" },
  "gads": { "clientSecret": "", "queueTimeout": 60 }
}
```

The same works with environment variables: `PW_APPIUM_SERVER_URL=http://gads-hub:10000` plus `PW_GADS_CLIENT_SECRET=...`.

With the preset on:

| | |
|---|---|
| Endpoint | Sessions go to `<hub>/grid`. A `serverUrl` that already ends in `/grid` also works. |
| Authentication | The fixture adds `gads:clientSecret`. Create the secret under **Admin → Client credentials** in the GADS UI. GADS shows it only once, so store it in an env var or a [secrets provider](secrets.md) mapped to `appium.gads.clientSecret`. Never commit it. |
| Device choice | `udid` pins a device. `deviceName` is a regex the fixture resolves to a UDID from `GET /grid/status`, trying free devices first. `platform` alone takes any free device. `platformVersion` can be exact (`17.5.1`) or a major version (`17`). |
| Queueing | `gads.queueTimeout` seconds to wait when every matching device is busy. The hub default is 10 and the maximum is 300. |
| Release | Teardown deletes the session, and the hub frees the device. If a run crashes, the hub frees it after `newCommandTimeout` seconds. |

The `gadsHub` fixture lists devices without reserving any:

```typescript
test('[TC-GDS-NNN] farm has a free Android device', { tag: ['@TC-GDS-NNN'] }, async ({ gadsHub }) => {
    await test.step('Step 1: List free Android devices', async () => {
        const free = (await gadsHub.listDevices({ platform: 'android' })).filter((d) => d.available);
        expect(free.length).toBeGreaterThan(0);
    });
});
```

`gadsSessionInfo(appiumDriver)` returns the device the hub allocated: `{ udid, name, provider, controlUrl }`. `controlUrl` opens that device's live view in the GADS UI.

---

## Errors

| Error | When |
|-------|------|
| `FixtureInitError('appium', 'init')` | `serverUrl` is missing, or there's no `platformName` |
| `FixtureInitError('appium', 'connect')` | The server is unreachable or rejected the session. The error includes the server's message and the capabilities that were sent. |
| `FixtureInitError('gads', 'init')` | `clientSecret` is missing, or no device matches `deviceName`. The message lists the known devices. |
| `FixtureInitError('gads', 'connect')` | Invalid client secret (401), no free device within `queueTimeout` (404), or the hub is unreachable |
| WebdriverIO errors | Commands that fail inside the test, such as an element not found or a timeout |

The GADS client secret is redacted from every error the fixture throws, and WebdriverIO's log level defaults to `warn`, so the capabilities aren't logged. `appiumDriver.requestedCapabilities` still holds the secret, so don't print it.

---

## Troubleshooting

- **`session not created` locally**: check `appium driver list --installed`, and that `adb devices` or `xcrun simctl list` shows your device.
- **GADS 401 `Invalid client credentials`**: create a new secret. GADS shows each one only once.
- **GADS 404 `No available device found`**: every matching device is busy, or none is enabled for automation. Raise `gads.queueTimeout`, or check the device's usage setting in the GADS UI.
- **BiDi / `webSocketUrl`**: the GADS grid strips it. Use classic WebDriver commands.
