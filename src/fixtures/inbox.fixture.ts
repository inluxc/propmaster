/**
 * Inbox fixture: read the emails your application sends — verification
 * links, password resets, magic links and one-time codes — from a test mail
 * server, so a test can complete the whole flow.
 *
 * Backed by Mailpit (https://mailpit.axllent.org/): the app sends to Mailpit's
 * SMTP port and the fixture reads through its HTTP API with Node's built-in
 * fetch, so it needs no extra package. Providers implement InboxProvider, so
 * another catcher (MailHog, a hosted inbox API) can be added later.
 *
 * Isolation: tests run in parallel against one mail server, so each test asks
 * for its own address with `uniqueAddress()`. Messages to those addresses are
 * deleted when the test ends.
 */

import type { InboxFixtureConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InboxAddress {
    name: string;
    address: string;
}

/** One email, with the parts tests usually need already extracted. */
export interface InboxMessage {
    id: string;
    from: InboxAddress;
    to: InboxAddress[];
    cc: InboxAddress[];
    subject: string;
    /** Plain-text body (Mailpit derives one from the HTML when the email has none). */
    text: string;
    html: string;
    date: Date;
    /** Every http(s) link in the email, from `href`s first, then bare URLs in the text; no duplicates. */
    links: string[];
}

export interface MessageQuery {
    /** Recipient address (exact, case-insensitive). */
    to?: string;
    /** Sender address (exact, case-insensitive). */
    from?: string;
    /** A substring of the subject, or a pattern it must match. */
    subject?: string | RegExp;
    /** Only messages received at or after this time. */
    since?: Date;
    /** Any extra condition. */
    where?: (message: InboxMessage) => boolean;
}

export interface WaitOptions extends MessageQuery {
    /** How long to wait in ms (default: the fixture's `timeout`, 30000). */
    timeout?: number;
}

export interface SendOptions {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
}

/** What a mail-catcher must provide. Mailpit is the built-in one. */
export interface InboxProvider {
    readonly name: string;
    /** Summaries of messages to `to` (or all, without `to`), newest first. */
    search(to?: string): Promise<{ id: string; created: Date }[]>;
    get(id: string): Promise<InboxMessage>;
    /** Deletes messages to `to` (or all, without `to`). */
    deleteTo(to?: string): Promise<void>;
    /** Sends an email through the catcher, to simulate an app in tests. Optional. */
    send?(message: SendOptions): Promise<void>;
}

/** Client exposed to tests as `inboxClient`. */
export interface InboxClient {
    /** Where the application should send email (host and port of the SMTP server), when known. */
    readonly smtp: { host: string; port: number } | undefined;
    /** A new address no other test uses, e.g. `signup-k3x9f2@test.local`. Its mail is deleted after the test. */
    uniqueAddress(prefix?: string): string;
    /** Waits for the newest message matching the query; throws with what arrived if none does in time. */
    waitForMessage(query: WaitOptions): Promise<InboxMessage>;
    /** Messages matching the query right now, newest first, without waiting. */
    messages(query?: MessageQuery): Promise<InboxMessage[]>;
    /** A one-time code from the message: the first capture group of `pattern`, or the whole match. Default: a 6-digit number. */
    extractCode(message: InboxMessage, pattern?: RegExp): string;
    /** The first link containing `match` (a substring or pattern), or the first link when omitted. */
    extractLink(message: InboxMessage, match?: string | RegExp): string;
    /** Deletes messages to `to` (or every message on the server, without `to`). */
    deleteAll(options?: { to?: string }): Promise<void>;
    /** Sends an email through the mail server, to stand in for your app in tests. Mailpit only. */
    send(message: SendOptions): Promise<void>;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the HTML entities found in hrefs and text: named ones above, plus numeric. */
export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
        }
        return ENTITIES[code.toLowerCase()] ?? whole;
    });
}

/** Links in an email: `href`s from the HTML (in order), then bare URLs from the text. */
export function extractLinks(html: string, text: string): string[] {
    const links: string[] = [];
    for (const m of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) links.push(decodeEntities(m[2].trim()));
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) links.push(m[0].replace(/[.,;:!?]+$/, ''));
    return [...new Set(links.filter((l) => /^https?:\/\//i.test(l)))];
}

/** Visible text of an HTML body, for code extraction when the text part is empty. */
export function htmlToText(html: string): string {
    return decodeEntities(
        html
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
            .replace(/<[^>]+>/g, ' '),
    )
        .replace(/[ \t]+/g, ' ')
        .trim();
}

export const DEFAULT_CODE_PATTERN = /\b(\d{6})\b/;

export function extractCode(message: Pick<InboxMessage, 'text' | 'html' | 'subject'>, pattern: RegExp = DEFAULT_CODE_PATTERN): string {
    for (const source of [message.text, htmlToText(message.html), message.subject]) {
        const m = pattern.exec(source ?? '');
        if (m) return m[1] ?? m[0];
    }
    throw new FixtureOperationError('inbox', 'extractCode', {
        pattern: String(pattern),
        reason: `no match in '${message.subject}'`,
    });
}

export function extractLink(message: Pick<InboxMessage, 'links' | 'subject'>, match?: string | RegExp): string {
    const link = message.links.find((l) => (match === undefined ? true : typeof match === 'string' ? l.includes(match) : match.test(l)));
    if (link) return link;
    throw new FixtureOperationError('inbox', 'extractLink', {
        match: String(match ?? '(any)'),
        reason: `no matching link in '${message.subject}'; links: ${message.links.join(', ') || 'none'}`,
    });
}

export function matchesQuery(message: InboxMessage, query: MessageQuery): boolean {
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (query.to && ![...message.to, ...message.cc].some((a) => eq(a.address, query.to!))) return false;
    if (query.from && !eq(message.from.address, query.from)) return false;
    if (query.subject !== undefined) {
        const ok = typeof query.subject === 'string' ? message.subject.includes(query.subject) : query.subject.test(message.subject);
        if (!ok) return false;
    }
    if (query.since && message.date.getTime() < query.since.getTime()) return false;
    if (query.where && !query.where(message)) return false;
    return true;
}

function describeQuery(query: MessageQuery): string {
    const parts = [
        query.to && `to ${query.to}`,
        query.from && `from ${query.from}`,
        query.subject !== undefined && `subject ${typeof query.subject === 'string' ? `containing '${query.subject}'` : `matching ${query.subject}`}`,
        query.since && `since ${query.since.toISOString()}`,
        query.where && 'matching the `where` condition',
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'any message';
}

// ─── Mailpit ────────────────────────────────────────────────────────────────

type MailpitAddress = { Name?: string; Address: string };
type MailpitMessage = {
    ID: string;
    From: MailpitAddress;
    To: MailpitAddress[] | null;
    Cc: MailpitAddress[] | null;
    Subject: string;
    Text: string;
    HTML: string;
    Date: string;
};

const toAddress = (a: MailpitAddress): InboxAddress => ({ name: a.Name ?? '', address: a.Address });

/** Mailpit's HTTP API (`/api/v1`). */
export class MailpitProvider implements InboxProvider {
    readonly name = 'mailpit';
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(config: Pick<InboxFixtureConfig, 'url' | 'username' | 'password'>) {
        this.base = config.url.replace(/\/+$/, '');
        this.headers = { Accept: 'application/json' };
        if (config.username) {
            this.headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`).toString('base64')}`;
        }
    }

    private async request(method: string, path: string, body?: unknown): Promise<unknown> {
        const init: RequestInit = { method, headers: { ...this.headers } };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
            (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
        const res = await fetch(`${this.base}${path}`, init);
        if (!res.ok) throw new Error(`${method} ${path} returned ${res.status} ${res.statusText}`);
        const type = res.headers.get('content-type') ?? '';
        return type.includes('json') ? res.json() : res.text();
    }

    private static queryFor(to?: string): string {
        return to ? `?query=${encodeURIComponent(`to:"${to}"`)}` : '';
    }

    async search(to?: string): Promise<{ id: string; created: Date }[]> {
        const path = to ? `/api/v1/search${MailpitProvider.queryFor(to)}&limit=200` : '/api/v1/messages?limit=200';
        const data = (await this.request('GET', path)) as { messages: { ID: string; Created: string }[] };
        return data.messages.map((m) => ({ id: m.ID, created: new Date(m.Created) }));
    }

    async get(id: string): Promise<InboxMessage> {
        const m = (await this.request('GET', `/api/v1/message/${encodeURIComponent(id)}`)) as MailpitMessage;
        return {
            id: m.ID,
            from: toAddress(m.From),
            to: (m.To ?? []).map(toAddress),
            cc: (m.Cc ?? []).map(toAddress),
            subject: m.Subject,
            text: m.Text ?? '',
            html: m.HTML ?? '',
            date: new Date(m.Date),
            links: extractLinks(m.HTML ?? '', m.Text ?? ''),
        };
    }

    async deleteTo(to?: string): Promise<void> {
        if (to) await this.request('DELETE', `/api/v1/search${MailpitProvider.queryFor(to)}`);
        else await this.request('DELETE', '/api/v1/messages');
    }

    async send(message: SendOptions): Promise<void> {
        const to = Array.isArray(message.to) ? message.to : [message.to];
        await this.request('POST', '/api/v1/send', {
            From: { Email: message.from },
            To: to.map((Email) => ({ Email })),
            Subject: message.subject,
            Text: message.text ?? '',
            HTML: message.html ?? '',
        });
    }

    /** True when the API answers. */
    async ping(): Promise<void> {
        await this.request('GET', '/api/v1/info');
    }
}

// ─── Client ─────────────────────────────────────────────────────────────────

export const DEFAULT_INBOX_DOMAIN = 'test.local';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL_INTERVAL = 500;

/** Builds the test-facing client over a provider. `created` collects the addresses to clean up. */
export function createInboxClient(
    provider: InboxProvider,
    config: Pick<InboxFixtureConfig, 'domain' | 'timeout' | 'pollInterval' | 'smtpHost' | 'smtpPort'>,
    created: Set<string> = new Set(),
): InboxClient {
    const domain = config.domain ?? DEFAULT_INBOX_DOMAIN;
    const pollInterval = config.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const smtp = config.smtpHost && config.smtpPort ? { host: config.smtpHost, port: config.smtpPort } : undefined;

    async function messages(query: MessageQuery = {}): Promise<InboxMessage[]> {
        const found = await provider.search(query.to);
        const candidates = query.since ? found.filter((m) => m.created.getTime() >= query.since!.getTime() - 1_000) : found;
        const full = await Promise.all(candidates.map((m) => provider.get(m.id)));
        return full.filter((m) => matchesQuery(m, query)).sort((a, b) => b.date.getTime() - a.date.getTime());
    }

    return {
        smtp,

        uniqueAddress(prefix = 'test') {
            const slug = prefix.toLowerCase().replace(/[^a-z0-9.+-]/g, '-').replace(/^-+|-+$/g, '') || 'test';
            const address = `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@${domain}`;
            created.add(address);
            return address;
        },

        messages,

        async waitForMessage(query) {
            const timeout = query.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
            const deadline = Date.now() + timeout;
            for (;;) {
                const [newest] = await messages(query);
                if (newest) return newest;
                if (Date.now() >= deadline) break;
                await new Promise((r) => setTimeout(r, Math.min(pollInterval, Math.max(0, deadline - Date.now()))));
            }
            const seen = await messages({ to: query.to }).catch(() => []);
            throw new FixtureOperationError('inbox', 'waitForMessage', {
                waitedFor: describeQuery(query),
                timeout,
                reason: seen.length
                    ? `${seen.length} other message(s)${query.to ? ` to ${query.to}` : ''}: ${seen.slice(0, 5).map((m) => `'${m.subject}'`).join(', ')}`
                    : `no message${query.to ? ` to ${query.to}` : ''} arrived`,
            });
        },

        extractCode,
        extractLink,

        async deleteAll(options = {}) {
            await provider.deleteTo(options.to);
        },

        async send(message) {
            if (!provider.send) {
                throw new FixtureOperationError('inbox', 'send', { reason: `the ${provider.name} provider can't send email` });
            }
            await provider.send(message);
        },
    };
}

/**
 * Playwright fixture: `inboxClient`. Checks the mail server is reachable,
 * gives the test a client, and deletes mail sent to its unique addresses
 * when the test ends.
 */
export const inboxFixture = {
    inboxClient: async ({ inboxConfig }: { inboxConfig: InboxFixtureConfig }, use: (client: InboxClient) => Promise<void>) => {
        const provider = new MailpitProvider(inboxConfig);
        try {
            await provider.ping();
        } catch (error) {
            throw new FixtureInitError(
                'inbox',
                'connect',
                { url: inboxConfig.url, reason: error instanceof Error ? error.message : String(error) },
                error instanceof Error ? error : undefined,
            );
        }

        const created = new Set<string>();
        await use(createInboxClient(provider, inboxConfig, created));
        await Promise.allSettled([...created].map((address) => provider.deleteTo(address)));
    },
};
