/**
 * Appium Fixture — Example Test
 *
 * Demonstrates driving a mobile device through any Appium-compatible server
 * (local `appium`, Selenium Grid, cloud farm). `appiumDriver` is a WebdriverIO
 * Browser: use `$()` selectors, `execute('mobile: ...')`, and the full
 * WebdriverIO API. The session is deleted after each test.
 *
 * The `appium-android` / `appium-ios` projects run this file per platform.
 *
 * Prerequisites:
 *   - An Appium 2+ server (npm i -g appium && appium driver install uiautomator2 / xcuitest && appium)
 *   - A connected device, emulator or simulator
 *   - PW_APPIUM_SERVER_URL (default http://127.0.0.1:4723) and optionally PW_APPIUM_DEVICE_NAME / _UDID
 */

import { test, expect } from '../../src';
import { AppiumSteps } from '../../src/steps';

test.describe('Appium Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires an Appium server and a device');

    test('[TC-APM-001] open a session and read the UI hierarchy', { tag: ['@TC-APM-001'] }, async ({ appiumDriver }) => {
        await test.step('Step 1: Verify the session is open', async () => {
            expect(appiumDriver.sessionId).toBeTruthy();
            expect(appiumDriver.isMobile).toBe(true);
        });

        await test.step('Step 2: Read the page source', async () => {
            const xml = await appiumDriver.getPageSource();
            expect(xml).toContain('<');
        });
    });

    test('[TC-APM-002] launch Settings and find a visible element', { tag: ['@TC-APM-002'] }, async ({ appiumDriver }) => {
        const settingsApp = appiumDriver.isIOS ? 'com.apple.Preferences' : 'com.android.settings';

        await test.step('Step 1: Launch the system Settings app', async () => {
            await appiumDriver.execute('mobile: activateApp', { bundleId: settingsApp, appId: settingsApp });
        });

        await test.step('Step 2: Wait for a list on the Settings screen', async () => {
            const list = appiumDriver.isIOS
                ? appiumDriver.$('-ios class chain:**/XCUIElementTypeCell')
                : appiumDriver.$('android=new UiSelector().scrollable(true)');
            await list.waitForDisplayed({ timeout: 15_000 });
            expect(await list.isDisplayed()).toBe(true);
        });

        await test.step('Step 3: Close the Settings app', async () => {
            await appiumDriver.execute('mobile: terminateApp', { bundleId: settingsApp, appId: settingsApp });
        });
    });

    test('[TC-APM-003] attach a screenshot with AppiumSteps', { tag: ['@TC-APM-003'] }, async ({ appiumDriver }) => {
        const steps = new AppiumSteps(appiumDriver);

        await test.step('Step 1: Capture the device screen', async () => {
            const png = await steps.attachScreenshot('Attach a screenshot of the device', 'device-home');
            // PNG signature
            expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
        });
    });
});
