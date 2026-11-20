/**
 * A tiny fake web app for the auth examples, served entirely through
 * page.route(), so the examples need no server: a login form that sets a
 * session cookie, and a /whoami page that reads it.
 */

import type { BrowserContext, Page } from '@playwright/test';

export const APP = 'http://app.propmaster.test';

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

/** Serves the fake app for every page in the context; `users` maps email → password. */
export async function serveFakeApp(target: Page | BrowserContext, users: Record<string, string>): Promise<void> {
    await target.route(`${APP}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());

        if (url.pathname === '/login' && request.method() === 'GET') {
            await route.fulfill({
                contentType: 'text/html',
                body: html(`<h1>Sign in</h1>
                    <form method="post" action="/login">
                        <label>Email <input name="email"></label>
                        <label>Password <input name="password" type="password"></label>
                        <button>Sign in</button>
                    </form>`),
            });
            return;
        }

        if (url.pathname === '/login' && request.method() === 'POST') {
            const form = new URLSearchParams(request.postData() ?? '');
            const email = form.get('email') ?? '';
            if (users[email] === undefined || users[email] !== form.get('password')) {
                await route.fulfill({ status: 401, contentType: 'text/html', body: html('<h1>Wrong email or password</h1>') });
                return;
            }
            await route.fulfill({
                contentType: 'text/html',
                headers: { 'Set-Cookie': `session=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax` },
                body: html(`<h1>Dashboard</h1><p>Welcome, ${email}</p>`),
            });
            return;
        }

        if (url.pathname === '/whoami') {
            const session = /(?:^|;\s*)session=([^;]+)/.exec(request.headers()['cookie'] ?? '')?.[1];
            const body = session ? `<h1>Signed in as ${decodeURIComponent(session)}</h1>` : '<h1>Not signed in</h1>';
            await route.fulfill({ contentType: 'text/html', body: html(body) });
            return;
        }

        await route.fulfill({ status: 404, body: 'not found' });
    });
}
