/**
 * Appium Step Class
 *
 * Reusable step sequences for Appium tests (local Appium, grids, cloud farms, GADS).
 * Every method wraps its work in test.step() so it shows up in reports and traces.
 *
 * Selectors are WebdriverIO selectors:
 *   '~login'                                   accessibility id
 *   'id=com.example:id/email'                  resource id (Android) / name (iOS)
 *   '//XCUIElementTypeButton[@name="OK"]'      xpath
 *   'android=new UiSelector().text("OK")'      UiAutomator
 *   '-ios predicate string:label == "OK"'      iOS predicate
 *   '-ios class chain:**\/XCUIElementTypeCell'  iOS class chain
 */

import { test, expect } from '../index.js';
import type { AppiumDriver } from '../fixtures/appium.fixture.js';

export type { AppiumDriver } from '../fixtures/appium.fixture.js';

/** Default wait for elements to appear (ms). */
const DEFAULT_WAIT = 10_000;

export class AppiumSteps {
    constructor(private driver: AppiumDriver) {}

    /**
     * Brings an installed app to the foreground (bundle ID on iOS, package name on Android).
     */
    async launchApp(description: string, appId: string): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.driver.execute('mobile: activateApp', { bundleId: appId, appId });
        });
    }

    /**
     * Stops a running app (bundle ID on iOS, package name on Android).
     */
    async terminateApp(description: string, appId: string): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.driver.execute('mobile: terminateApp', { bundleId: appId, appId });
        });
    }

    /**
     * Opens a URL or deep link on the device.
     */
    async openUrl(description: string, url: string): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.driver.url(url);
        });
    }

    /**
     * Waits for an element to be displayed and taps it.
     */
    async tap(description: string, selector: string, timeout: number = DEFAULT_WAIT): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const el = this.driver.$(selector);
            await el.waitForDisplayed({ timeout });
            await el.click();
        });
    }

    /**
     * Waits for an input, replaces its value with `text`.
     */
    async fill(description: string, selector: string, text: string, timeout: number = DEFAULT_WAIT): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const el = this.driver.$(selector);
            await el.waitForDisplayed({ timeout });
            await el.clearValue();
            await el.setValue(text);
        });
    }

    /**
     * Asserts an element becomes displayed within `timeout`.
     */
    async expectVisible(description: string, selector: string, timeout: number = DEFAULT_WAIT): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const el = this.driver.$(selector);
            await el.waitForDisplayed({ timeout });
            expect(await el.isDisplayed()).toBe(true);
        });
    }

    /**
     * Waits for an element and asserts its text.
     */
    async expectText(description: string, selector: string, expected: string | RegExp, timeout: number = DEFAULT_WAIT): Promise<string> {
        let text = '';

        await test.step(`Step: ${description}`, async () => {
            const el = this.driver.$(selector);
            await el.waitForDisplayed({ timeout });
            text = await el.getText();
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
    async attachScreenshot(description: string, name: string = 'appium-screenshot'): Promise<Buffer> {
        let png: Buffer = Buffer.alloc(0);

        await test.step(`Step: ${description}`, async () => {
            png = Buffer.from(await this.driver.takeScreenshot(), 'base64');
            expect(png.length).toBeGreaterThan(0);
            await test.info().attach(name, { body: png, contentType: 'image/png' });
        });

        return png;
    }
}
