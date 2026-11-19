/**
 * GADS Fixture — Example Test
 *
 * Demonstrates running Appium tests on a real device allocated from a GADS
 * device farm (https://github.com/shamanec/GADS). The `gadsDevice` fixture asks
 * the hub for a device, opens an Appium session on it, and releases the device
 * after the test. `gadsHub` lists devices without reserving one.
 *
 * Prerequisites:
 *   - A running GADS hub with at least one provider and an automation-enabled device
 *   - A client secret from GADS Admin → Client credentials
 *   - PW_GADS_HUB_URL and PW_GADS_CLIENT_SECRET set (plus PW_GADS_PLATFORM,
 *     PW_GADS_DEVICE_NAME or PW_GADS_UDID to choose the device)
 */

import { test, expect } from '../../src';
import { GadsSteps } from '../../src/steps';

test.describe('GADS Fixture Examples', () => {
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

    test('[TC-GDS-002] allocate a device and open an Appium session', { tag: ['@TC-GDS-002'] }, async ({ gadsDevice }) => {
        await test.step('Step 1: Verify the hub allocated a device', async () => {
            expect(gadsDevice.sessionId).toBeTruthy();
            expect(gadsDevice.udid).toBeTruthy();
        });

        await test.step('Step 2: Read the UI hierarchy from the device', async () => {
            const xml = await gadsDevice.source();
            expect(xml).toContain('<');
        });

        await test.step('Step 3: Verify the client secret is not exposed in capabilities', async () => {
            expect(JSON.stringify(gadsDevice.capabilities)).not.toContain(process.env.PW_GADS_CLIENT_SECRET ?? '\u0000');
        });
    });

    test('[TC-GDS-003] take a screenshot and attach it to the report', { tag: ['@TC-GDS-003'] }, async ({ gadsDevice, gadsHub }) => {
        const steps = new GadsSteps(gadsDevice, gadsHub);

        await test.step('Step 1: Capture the device screen', async () => {
            const png = await steps.attachScreenshot('Attach a screenshot of the device', 'device-home');
            // PNG signature
            expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
        });

        await test.step('Step 2: Verify the device is busy while the session runs', async () => {
            const [device] = await gadsHub.listDevices({ udid: gadsDevice.udid });
            expect(device?.available).toBe(false);
        });
    });

    test('[TC-GDS-004] launch an app and find an element', { tag: ['@TC-GDS-004'] }, async ({ gadsDevice }) => {
        const isIos = gadsDevice.platform === 'ios';
        const settingsApp = isIos ? 'com.apple.Preferences' : 'com.android.settings';

        await test.step('Step 1: Launch the system Settings app', async () => {
            await gadsDevice.activateApp(settingsApp);
        });

        await test.step('Step 2: Wait for a visible element on the Settings screen', async () => {
            const id = await gadsDevice.waitForElement(
                isIos ? '-ios class chain' : '-android uiautomator',
                isIos ? '**/XCUIElementTypeCell' : 'new UiSelector().scrollable(true)',
                15_000,
            );
            expect(await gadsDevice.isDisplayed(id)).toBe(true);
        });

        await test.step('Step 3: Close the Settings app', async () => {
            await gadsDevice.terminateApp(settingsApp);
        });
    });
});
