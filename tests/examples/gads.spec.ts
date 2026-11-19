/**
 * GADS Preset — Example Test
 *
 * Demonstrates the Appium fixture's GADS preset (https://github.com/shamanec/GADS).
 * With `appium.gads` set, `appiumDriver` asks the GADS hub for a device, opens an
 * Appium session on it, and releases the device after the test. `gadsHub` lists
 * devices without reserving one.
 *
 * Prerequisites:
 *   - A running GADS hub with at least one provider and an automation-enabled device
 *   - A client secret from GADS Admin → Client credentials
 *   - PW_APPIUM_SERVER_URL=http://<hub>:10000, PW_GADS_CLIENT_SECRET, and
 *     PW_APPIUM_PLATFORM (optionally PW_APPIUM_DEVICE_NAME or PW_APPIUM_UDID)
 */

import { test, expect, gadsSessionInfo } from '../../src';
import { AppiumSteps } from '../../src/steps';

test.describe('GADS Preset Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires a GADS hub and devices');

    test('[TC-GDS-001] hub reports ready with automation-enabled devices', { tag: ['@TC-GDS-001'] }, async ({ gadsHub }) => {
        let status: Awaited<ReturnType<typeof gadsHub.status>>;

        await test.step('Step 1: Query the hub grid status', async () => {
            status = await gadsHub.status();
        });

        await test.step('Step 2: Verify the hub is ready and lists devices', async () => {
            expect(status.ready).toBe(true);
            expect(status.devices.length).toBeGreaterThan(0);
            for (const device of status.devices) {
                expect(device.udid).toBeTruthy();
                expect(['ios', 'android']).toContain(device.os.toLowerCase());
            }
        });
    });

    test('[TC-GDS-002] allocate a device through the hub', { tag: ['@TC-GDS-002'] }, async ({ appiumDriver }) => {
        await test.step('Step 1: Verify the hub allocated a device', async () => {
            const info = gadsSessionInfo(appiumDriver);
            expect(appiumDriver.sessionId).toBeTruthy();
            expect(info.udid).toBeTruthy();
            expect(info.provider).toBeTruthy();
        });

        await test.step('Step 2: Read the UI hierarchy from the device', async () => {
            const xml = await appiumDriver.getPageSource();
            expect(xml).toContain('<');
        });
    });

    test('[TC-GDS-003] device is busy while the session runs', { tag: ['@TC-GDS-003'] }, async ({ appiumDriver, gadsHub }) => {
        const steps = new AppiumSteps(appiumDriver);

        await test.step('Step 1: Capture the device screen', async () => {
            const png = await steps.attachScreenshot('Attach a screenshot of the device', 'device-home');
            expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
        });

        await test.step('Step 2: Verify the hub reports the device as in use', async () => {
            const { udid } = gadsSessionInfo(appiumDriver);
            const [device] = await gadsHub.listDevices({ udid });
            expect(device?.available).toBe(false);
        });
    });

    test('[TC-GDS-004] launch an app and find an element', { tag: ['@TC-GDS-004'] }, async ({ appiumDriver }) => {
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
});
