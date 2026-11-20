/**
 * Unit tests for the inbox fixture (src/fixtures/inbox.fixture.ts): parsing
 * helpers, and the client's waiting/filtering/cleanup logic against an
 * in-memory provider. The Mailpit provider itself runs against a real server
 * in tests/examples/inbox.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigLoader } from '../../src/config/loader';
import { mailpitSpec } from '../../src/containers/container-manager';
import {
    createInboxClient,
    decodeEntities,
    extractCode,
    extractLink,
    extractLinks,
    htmlToText,
    matchesQuery,
    type InboxMessage,
    type InboxProvider,
} from '../../src/fixtures/inbox.fixture';

function message(over: Partial<InboxMessage> = {}): InboxMessage {
    const text = over.text ?? '';
    const html = over.html ?? '';
    return {
        id: over.id ?? Math.random().toString(36).slice(2),
        from: over.from ?? { name: 'App', address: 'app@example.com' },
        to: over.to ?? [{ name: '', address: 'u@test.local' }],
        cc: over.cc ?? [],
        subject: over.subject ?? 'Hello',
        text,
        html,
        date: over.date ?? new Date(),
        links: over.links ?? extractLinks(html, text),
    };
}

/** In-memory provider; `deliverAfter` lets a message "arrive" later. */
class FakeProvider implements InboxProvider {
    readonly name = 'fake';
    messages: InboxMessage[] = [];
    deleted: (string | undefined)[] = [];
    async search(to?: string) {
        return this.messages
            .filter((m) => !to || m.to.some((a) => a.address.toLowerCase() === to.toLowerCase()))
            .map((m) => ({ id: m.id, created: m.date }));
    }
    async get(id: string) {
        return this.messages.find((m) => m.id === id)!;
    }
    async deleteTo(to?: string) {
        this.deleted.push(to);
        this.messages = to ? this.messages.filter((m) => !m.to.some((a) => a.address === to)) : [];
    }
    deliverAfter(ms: number, m: InboxMessage) {
        setTimeout(() => this.messages.push({ ...m, date: new Date() }), ms);
    }
}

test.describe('inbox — parsing helpers', () => {
    test('decodeEntities handles named and numeric entities', () => {
        expect(decodeEntities('a&amp;b &lt;x&gt; &#39;q&#x27; &quot;z&quot; &unknown;')).toBe(`a&b <x> 'q' "z" &unknown;`);
    });

    test('extractLinks: hrefs first, then bare URLs, decoded, unique, http(s) only', () => {
        const html = '<a href="https://a.test/verify?t=1&amp;u=2">x</a> <a href=\'mailto:x@y\'>m</a> <a HREF="https://a.test/help">h</a>';
        const text = 'Open https://a.test/verify?t=1&u=2. Or https://b.test/x, or (https://c.test/y)';
        expect(extractLinks(html, text)).toEqual(['https://a.test/verify?t=1&u=2', 'https://a.test/help', 'https://b.test/x', 'https://c.test/y']);
    });

    test('htmlToText keeps visible text only', () => {
        expect(htmlToText('<style>p{}</style><p>Code <b>123456</b></p><div>Bye&nbsp;now</div>')).toBe('Code 123456 \n Bye now');
    });

    test('extractCode: default 6 digits, capture groups, HTML and subject fallbacks', () => {
        expect(extractCode(message({ text: 'Your code is 482913.' }))).toBe('482913');
        expect(extractCode(message({ text: '', html: '<p>Code: <b>771100</b></p>' }))).toBe('771100');
        expect(extractCode(message({ subject: '123456 is your code' }))).toBe('123456');
        expect(extractCode(message({ text: 'PIN: AB-12' }), /PIN: ([A-Z]{2}-\d{2})/)).toBe('AB-12');
        expect(extractCode(message({ text: 'ref 1234' }), /\d{4}/)).toBe('1234');
        expect(() => extractCode(message({ subject: 'No code', text: 'none' }))).toThrow(/no match in 'No code'/);
    });

    test('extractLink by substring or pattern, with a helpful error', () => {
        const m = message({ html: '<a href="https://a.test/help">h</a><a href="https://a.test/reset/9">r</a>' });
        expect(extractLink(m)).toBe('https://a.test/help');
        expect(extractLink(m, '/reset/')).toBe('https://a.test/reset/9');
        expect(extractLink(m, /reset\/\d+$/)).toBe('https://a.test/reset/9');
        expect(() => extractLink(m, 'verify')).toThrow(/links: https:\/\/a\.test\/help, https:\/\/a\.test\/reset\/9/);
    });

    test('matchesQuery: to/cc, from, subject, since, where', () => {
        const m = message({ subject: 'Reset password', to: [{ name: '', address: 'A@Test.local' }], cc: [{ name: '', address: 'c@test.local' }], date: new Date(1000) });
        expect(matchesQuery(m, { to: 'a@test.local' })).toBe(true);
        expect(matchesQuery(m, { to: 'c@test.local' })).toBe(true);
        expect(matchesQuery(m, { from: 'APP@example.com' })).toBe(true);
        expect(matchesQuery(m, { subject: 'Reset' })).toBe(true);
        expect(matchesQuery(m, { subject: /^reset/i })).toBe(true);
        expect(matchesQuery(m, { subject: 'reset' })).toBe(false); // substring is case-sensitive
        expect(matchesQuery(m, { since: new Date(2000) })).toBe(false);
        expect(matchesQuery(m, { where: (x) => x.cc.length === 1 })).toBe(true);
    });
});

test.describe('inbox — client', () => {
    test('uniqueAddress: slugged prefix, configured domain, unique, tracked for cleanup', () => {
        const created = new Set<string>();
        const client = createInboxClient(new FakeProvider(), { domain: 'mail.test' }, created);
        const a = client.uniqueAddress('Sign Up!');
        const b = client.uniqueAddress('Sign Up!');
        expect(a).toMatch(/^sign-up-[a-z0-9]+@mail\.test$/);
        expect(a).not.toBe(b);
        expect([...created]).toEqual([a, b]);
        expect(createInboxClient(new FakeProvider(), {}).uniqueAddress()).toMatch(/@test\.local$/);
    });

    test('waitForMessage waits for mail that arrives later, newest first', async () => {
        const provider = new FakeProvider();
        const client = createInboxClient(provider, { pollInterval: 20 });
        provider.messages.push(message({ subject: 'Old', date: new Date(Date.now() - 60_000) }));
        provider.deliverAfter(100, message({ subject: 'Your code 111222' }));
        const m = await client.waitForMessage({ to: 'u@test.local', subject: 'code', timeout: 2_000 });
        expect(m.subject).toBe('Your code 111222');
        expect((await client.messages({ to: 'u@test.local' })).map((x) => x.subject)).toEqual(['Your code 111222', 'Old']);
    });

    test('waitForMessage timeout names the query and what did arrive', async () => {
        const provider = new FakeProvider();
        provider.messages.push(message({ subject: 'Newsletter' }));
        const client = createInboxClient(provider, { pollInterval: 20 });
        const start = Date.now();
        await expect(client.waitForMessage({ to: 'u@test.local', subject: 'Invoice', timeout: 150 })).rejects.toThrow(
            /subject containing 'Invoice'.*1 other message\(s\) to u@test\.local: 'Newsletter'/s,
        );
        expect(Date.now() - start).toBeLessThan(1_000);
        await expect(client.waitForMessage({ to: 'nobody@test.local', timeout: 50 })).rejects.toThrow(/no message to nobody@test\.local arrived/);
    });

    test('since skips older mail', async () => {
        const provider = new FakeProvider();
        provider.messages.push(message({ subject: 'Before', date: new Date(Date.now() - 10_000) }));
        const client = createInboxClient(provider, { pollInterval: 20 });
        await expect(client.waitForMessage({ to: 'u@test.local', since: new Date(), timeout: 80 })).rejects.toThrow();
    });

    test('smtp is exposed only when host and port are both known', () => {
        expect(createInboxClient(new FakeProvider(), { smtpHost: 'localhost', smtpPort: 1025 }).smtp).toEqual({ host: 'localhost', port: 1025 });
        expect(createInboxClient(new FakeProvider(), { smtpHost: 'localhost' }).smtp).toBeUndefined();
    });

    test('deleteAll and send delegate to the provider; send fails clearly without support', async () => {
        const provider = new FakeProvider();
        const client = createInboxClient(provider, {});
        await client.deleteAll({ to: 'x@test.local' });
        await client.deleteAll();
        expect(provider.deleted).toEqual(['x@test.local', undefined]);
        await expect(client.send({ from: 'a@b.c', to: 'x@test.local', subject: 's' })).rejects.toThrow(/fake provider can't send/);
    });
});

test.describe('inbox — config and container', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-config-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: {} } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_INBOX_* variables map to the inbox config', () => {
        Object.assign(process.env, {
            PW_INBOX_URL: 'http://mail:8025',
            PW_INBOX_SMTP_HOST: 'mail',
            PW_INBOX_SMTP_PORT: '1025',
            PW_INBOX_DOMAIN: 'qa.test',
            PW_INBOX_TIMEOUT: '5000',
            PW_INBOX_USERNAME: 'qa',
            PW_INBOX_PASSWORD: 'pw',
            PW_INBOX_CONTAINER: 'axllent/mailpit:v1.34',
        });
        expect(new ConfigLoader(dir).load('local').inbox).toEqual({
            url: 'http://mail:8025',
            smtpHost: 'mail',
            smtpPort: 1025,
            domain: 'qa.test',
            timeout: 5000,
            username: 'qa',
            password: 'pw',
            container: { image: 'axllent/mailpit:v1.34' },
        });
    });

    test('Mailpit container publishes the API and SMTP ports and uses readyz', () => {
        const spec = mailpitSpec({});
        expect(spec.image).toBe('axllent/mailpit:latest');
        expect(spec.port).toBe(8025);
        expect(spec.extraPorts).toEqual([1025]);
        expect(spec.healthCheck).toBe('/mailpit readyz');
    });
});
