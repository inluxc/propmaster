/**
 * Example tests for the inbox fixture (Mailpit).
 *
 * In a real suite your application sends the email (sign-up, password reset,
 * login code). Here `inboxClient.send()` stands in for the app, so the
 * examples run with nothing but a Mailpit server:
 *
 *   PW_INBOX_URL=http://localhost:8025   (or PW_INBOX_CONTAINER=true)
 */

import { test, expect } from '../../src';
import { InboxSteps } from '../../src/steps';

const APP = 'no-reply@app.example.com';

test.describe('Inbox Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-EML-001] read a one-time login code', { tag: ['@TC-EML-001'] }, async ({ inboxClient }) => {
        const inbox = new InboxSteps(inboxClient);
        const user = await inbox.createAddress('Create an address for the user', 'login');

        await test.step('Step 1: The app emails a login code', async () => {
            await inboxClient.send({ from: APP, to: user, subject: 'Your login code', text: 'Use 482913 to sign in. It expires in 10 minutes.' });
        });

        const message = await inbox.waitForMessage('Step 2: Wait for the login email', { to: user, subject: 'login code' });
        const code = await inbox.extractCode('Step 3: Extract the 6-digit code', message);

        await test.step('Step 4: Verify the code', async () => {
            expect(code).toBe('482913');
        });
    });

    test('[TC-EML-002] follow a verification link from an HTML email', { tag: ['@TC-EML-002'] }, async ({ inboxClient }) => {
        const inbox = new InboxSteps(inboxClient);
        const user = await inbox.createAddress('Create an address for the new account', 'signup');

        await test.step('Step 1: The app emails a verification link', async () => {
            await inboxClient.send({
                from: APP,
                to: user,
                subject: 'Confirm your email',
                html: '<p>Welcome!</p><p><a href="https://app.example.com/help">Help</a> · <a href="https://app.example.com/verify?token=t0k3n&amp;u=42">Confirm email</a></p>',
            });
        });

        const message = await inbox.waitForMessage('Step 2: Wait for the verification email', { to: user });
        await inbox.verifyMessage('Step 3: Check sender and subject', message, { from: APP, subject: 'Confirm your email' });
        const link = await inbox.extractLink('Step 4: Extract the verification link', message, '/verify');

        await test.step('Step 5: Verify the link, with HTML entities decoded', async () => {
            expect(link).toBe('https://app.example.com/verify?token=t0k3n&u=42');
            // In a browser test: await page.goto(link);
        });
    });

    test('[TC-EML-003] pick the right message by subject', { tag: ['@TC-EML-003'] }, async ({ inboxClient }) => {
        const user = inboxClient.uniqueAddress('reset');

        await test.step('Step 1: The app sends a welcome email and a reset email', async () => {
            await inboxClient.send({ from: APP, to: user, subject: 'Welcome aboard', text: 'Hello!' });
            await inboxClient.send({ from: APP, to: user, subject: 'Reset your password', text: 'Reset: https://app.example.com/reset/abc123' });
        });

        await test.step('Step 2: Wait for the reset email by subject pattern', async () => {
            const message = await inboxClient.waitForMessage({ to: user, subject: /reset/i });
            expect(message.subject).toBe('Reset your password');
            expect(inboxClient.extractLink(message, /\/reset\//)).toBe('https://app.example.com/reset/abc123');
        });

        await test.step('Step 3: Verify both messages are in the inbox', async () => {
            const all = await inboxClient.messages({ to: user });
            expect(all.map((m) => m.subject).sort()).toEqual(['Reset your password', 'Welcome aboard']);
        });
    });

    test('[TC-EML-004] unique addresses keep parallel tests apart', { tag: ['@TC-EML-004'] }, async ({ inboxClient }) => {
        const alice = inboxClient.uniqueAddress('alice');
        const bob = inboxClient.uniqueAddress('bob');

        await test.step('Step 1: Send one email to each address', async () => {
            await inboxClient.send({ from: APP, to: alice, subject: 'For Alice', text: 'a' });
            await inboxClient.send({ from: APP, to: bob, subject: 'For Bob', text: 'b' });
        });

        await test.step('Step 2: Verify each address sees only its own mail', async () => {
            expect((await inboxClient.waitForMessage({ to: alice })).subject).toBe('For Alice');
            expect((await inboxClient.messages({ to: bob })).map((m) => m.subject)).toEqual(['For Bob']);
        });
    });

    test('[TC-EML-005] waiting for mail that never comes fails with a readable error', { tag: ['@TC-EML-005'] }, async ({ inboxClient }) => {
        const user = inboxClient.uniqueAddress('nothing');

        await test.step('Step 1: Send an unrelated email to the same address', async () => {
            await inboxClient.send({ from: APP, to: user, subject: 'Newsletter', text: 'news' });
        });

        await test.step('Step 2: Verify the timeout names what arrived instead', async () => {
            await expect(inboxClient.waitForMessage({ to: user, subject: 'Invoice', timeout: 1_500 })).rejects.toThrow(/'Newsletter'/);
        });
    });

    test('[TC-EML-006] check that no email is sent', { tag: ['@TC-EML-006'] }, async ({ inboxClient }) => {
        const inbox = new InboxSteps(inboxClient);
        const user = await inbox.createAddress('Create an address that should get no mail', 'quiet');

        await inbox.verifyNoMessage('Step 1: Verify no email arrives within a second', { to: user }, 1_000);
    });
});
