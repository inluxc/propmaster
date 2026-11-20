/**
 * Inbox Step Class
 *
 * Reusable steps for reading the email an application sends: wait for a
 * message, check it, and pull out a one-time code or a link. Each method runs
 * inside `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type { InboxClient, InboxMessage, WaitOptions } from '../fixtures/inbox.fixture.js';

export type { InboxClient, InboxMessage } from '../fixtures/inbox.fixture.js';

export class InboxSteps {
    constructor(private inboxClient: InboxClient) {}

    /** A fresh address for this test; its mail is deleted when the test ends. */
    async createAddress(description: string = 'Create a unique test email address', prefix?: string): Promise<string> {
        let address = '';
        await test.step(`Step: ${description}`, async () => {
            address = this.inboxClient.uniqueAddress(prefix);
            expect(address).toContain('@');
        });
        return address;
    }

    /** Waits for the newest message matching `query`. */
    async waitForMessage(description: string, query: WaitOptions): Promise<InboxMessage> {
        let message!: InboxMessage;
        await test.step(`Step: ${description}`, async () => {
            message = await this.inboxClient.waitForMessage(query);
        });
        return message;
    }

    /** Checks the subject and, optionally, that the body contains each of `bodyContains`. */
    async verifyMessage(
        description: string,
        message: InboxMessage,
        expected: { subject?: string | RegExp; from?: string; bodyContains?: string[] },
    ): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            if (expected.subject !== undefined) {
                if (typeof expected.subject === 'string') expect(message.subject).toContain(expected.subject);
                else expect(message.subject).toMatch(expected.subject);
            }
            if (expected.from) expect(message.from.address.toLowerCase()).toBe(expected.from.toLowerCase());
            for (const text of expected.bodyContains ?? []) expect(`${message.text}\n${message.html}`).toContain(text);
        });
    }

    /** Extracts a one-time code (default: a 6-digit number). */
    async extractCode(description: string, message: InboxMessage, pattern?: RegExp): Promise<string> {
        let code = '';
        await test.step(`Step: ${description}`, async () => {
            code = this.inboxClient.extractCode(message, pattern);
            expect(code).not.toBe('');
        });
        return code;
    }

    /** Extracts the first link containing `match` (or the first link). */
    async extractLink(description: string, message: InboxMessage, match?: string | RegExp): Promise<string> {
        let link = '';
        await test.step(`Step: ${description}`, async () => {
            link = this.inboxClient.extractLink(message, match);
            expect(link).toMatch(/^https?:\/\//);
        });
        return link;
    }

    /** Checks that no message matching `query` arrives within `waitMs` (default 2000). */
    async verifyNoMessage(description: string, query: Omit<WaitOptions, 'timeout'>, waitMs = 2_000): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await new Promise((r) => setTimeout(r, waitMs));
            expect(await this.inboxClient.messages(query)).toHaveLength(0);
        });
    }
}
