/**
 * GADS Step Class
 *
 * Reusable step sequences for tests running on a GADS device farm session.
 * Every method wraps its work in test.step() so it shows up in reports and traces.
 */

import { test, expect } from '../index.js';
import type {
    GadsDevice,
    GadsDeviceCriteria,
    GadsDeviceInfo,
    GadsHubClient,
    GadsLocatorStrategy,
} from '../fixtures/gads.fixture.js';

export type { GadsDevice, GadsHubClient } from '../fixtures/gads.fixture.js';

export class GadsSteps {
    constructor(
        private device: GadsDevice,
        private hub?: GadsHubClient,
    ) {}

    /**
     * Verifies the hub has at least one device matching the criteria and returns them.
     * Requires the `gadsHub` fixture to be passed to the constructor.
     */
    async expectDevicesAvailable(description: string, criteria: GadsDeviceCriteria = {}): Promise<GadsDeviceInfo[]> {
        let devices: GadsDeviceInfo[] = [];

        await test.step(`Step: ${description}`, async () => {
            if (!this.hub) throw new Error('GadsSteps.expectDevicesAvailable needs the gadsHub fixture: new GadsSteps(gadsDevice, gadsHub)');
            devices = await this.hub.listDevices(criteria);
            expect(devices.length).toBeGreaterThan(0);
        });

        return devices;
    }

    /**
     * Brings an installed app to the foreground (bundle ID or package name).
     */
    async launchApp(description: string, appId: string): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.device.activateApp(appId);
        });
    }

    /**
     * Opens a URL or deep link on the device.
     */
    async openUrl(description: string, url: string): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.device.openUrl(url);
        });
    }

    /**
     * Waits for an element and taps it.
     */
    async tap(description: string, using: GadsLocatorStrategy, value: string, timeout?: number): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const id = await this.device.waitForElement(using, value, timeout);
            await this.device.click(id);
        });
    }

    /**
     * Waits for an input element, clears it and types `text`.
     */
    async fill(description: string, using: GadsLocatorStrategy, value: string, text: string, timeout?: number): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const id = await this.device.waitForElement(using, value, timeout);
            await this.device.clear(id);
            await this.device.sendKeys(id, text);
        });
    }

    /**
     * Waits for an element and asserts it is displayed.
     */
    async expectVisible(description: string, using: GadsLocatorStrategy, value: string, timeout?: number): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const id = await this.device.waitForElement(using, value, timeout);
            expect(await this.device.isDisplayed(id)).toBe(true);
        });
    }

    /**
     * Waits for an element and asserts its text.
     */
    async expectText(description: string, using: GadsLocatorStrategy, value: string, expected: string | RegExp, timeout?: number): Promise<string> {
        let text = '';

        await test.step(`Step: ${description}`, async () => {
            const id = await this.device.waitForElement(using, value, timeout);
            text = await this.device.getText(id);
            if (typeof expected === 'string') {
                expect(text).toBe(expected);
            } else {
                expect(text).toMatch(expected);
            }
        });

        return text;
    }

    /**
     * Takes a screenshot and attaches it to the test report.
     */
    async attachScreenshot(description: string, name: string = 'gads-screenshot'): Promise<Buffer> {
        let png: Buffer = Buffer.alloc(0);

        await test.step(`Step: ${description}`, async () => {
            png = await this.device.screenshot();
            expect(png.length).toBeGreaterThan(0);
            await test.info().attach(name, { body: png, contentType: 'image/png' });
        });

        return png;
    }
}
