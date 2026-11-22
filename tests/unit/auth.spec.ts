/**
 * Unit tests for the auth helpers (src/auth): the token manager against a
 * local mock token endpoint (grants, client auth, caching, refresh, discovery,
 * errors without secrets), role resolution, header application, login-state
 * files, the auth-setup scaffold, and PW_AUTH_* variables.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ConfigLoader } from '../../src/config/loader';
import { TokenManager, jwtExpiry, resolveRole } from '../../src/auth/token-manager';
import { authApplies, withBearer } from '../../src/auth/apply';
import { authStateFile } from '../../src/auth/state-file';
import { hasFreshAuthState, rolesToSetUp } from '../../src/auth/setup';
import { authSetupTemplate, runAuthSetup } from '../../src/cli/init';
import { redactCredentials } from '../../src/annotations/truncation';

interface Seen {
    path: string;
    authorization?: string;
    form: Record<string, string>;
}

/** A token endpoint that records requests; `respond` decides each answer. */
async function tokenServer(respond: (form: Record<string, string>, n: number) => { status?: number; body: object }) {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://x');
            if (url.pathname === '/issuer/.well-known/openid-configuration') {
                seen.push({ path: url.pathname, form: {} });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token` }));
                return;
            }
            const form = Object.fromEntries(new URLSearchParams(raw));
            seen.push({ path: url.pathname, authorization: req.headers.authorization, form });
            const { status = 200, body } = respond(form, seen.filter((s) => s.path === '/token').length);
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ok = (n: number, extra: object = {}) => ({ body: { access_token: `token-${n}`, token_type: 'Bearer', expires_in: 300, ...extra } });

test.describe('auth — token manager', () => {
    test('client_credentials with HTTP Basic client auth, scope and audience', async () => {
        const srv = await tokenServer((_f, n) => ok(n));
        try {
            const tm = new TokenManager();
            const token = await tm.getToken({ tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 's3cr3t', scope: 'api read', audience: 'https://api' });
            expect(token).toBe('token-1');
            expect(srv.seen[0].form).toEqual({ grant_type: 'client_credentials', scope: 'api read', audience: 'https://api' });
            expect(srv.seen[0].authorization).toBe(`Basic ${Buffer.from('svc:s3cr3t').toString('base64')}`);
        } finally {
            await srv.close();
        }
    });

    test('password grant with client_secret_post for a role', async () => {
        const srv = await tokenServer((_f, n) => ok(n));
        try {
            const tm = new TokenManager();
            await tm.getToken(
                { tokenUrl: `${srv.base}/token`, clientId: 'web', clientSecret: 'x', clientAuth: 'post', roles: { admin: { username: 'admin@example.test', password: 'pw' } } },
                'admin',
            );
            expect(srv.seen[0].form).toEqual({ grant_type: 'password', username: 'admin@example.test', password: 'pw', client_id: 'web', client_secret: 'x' });
            expect(srv.seen[0].authorization).toBeUndefined();
        } finally {
            await srv.close();
        }
    });

    test('caches per role, refreshes before expiry, prefers the refresh token', async () => {
        const srv = await tokenServer((form, n) => ok(n, { expires_in: 120, refresh_token: `refresh-${n}`, granted: form.grant_type }));
        try {
            let now = 1_000_000;
            const tm = new TokenManager(undefined, () => now);
            const config = { tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 's', refreshBeforeExpiry: 30 };
            expect(await tm.getToken(config)).toBe('token-1');
            now += 80_000; // 40 s left, more than the 30 s margin: cached
            expect(await tm.getToken(config)).toBe('token-1');
            now += 15_000; // 25 s left: refresh
            expect(await tm.getToken(config)).toBe('token-2');
            expect(srv.seen.filter((s) => s.path === '/token').map((s) => s.form.grant_type)).toEqual(['client_credentials', 'refresh_token']);
            expect(srv.seen[1].form.refresh_token).toBe('refresh-1');
        } finally {
            await srv.close();
        }
    });

    test('falls back to a fresh grant when the refresh token is rejected', async () => {
        const srv = await tokenServer((form, n) =>
            form.grant_type === 'refresh_token' ? { status: 400, body: { error: 'invalid_grant' } } : ok(n, { expires_in: 1, refresh_token: 'r' }),
        );
        try {
            const tm = new TokenManager();
            const config = { tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 's' };
            await tm.getToken(config);
            expect(await tm.getToken(config)).toBe('token-3'); // refresh (2) failed, new grant (3)
        } finally {
            await srv.close();
        }
    });

    test('concurrent requests for one role share a single token request', async () => {
        const srv = await tokenServer((_f, n) => ok(n));
        try {
            const tm = new TokenManager();
            const config = { tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 's' };
            const tokens = await Promise.all(Array.from({ length: 10 }, () => tm.getToken(config)));
            expect(new Set(tokens)).toEqual(new Set(['token-1']));
            expect(srv.seen.filter((s) => s.path === '/token')).toHaveLength(1);
        } finally {
            await srv.close();
        }
    });

    test('roles get separate tokens; invalidate forgets one role', async () => {
        const srv = await tokenServer((_f, n) => ok(n));
        try {
            const tm = new TokenManager();
            const config = { tokenUrl: `${srv.base}/token`, roles: { admin: { username: 'a', password: 'p' }, viewer: { username: 'v', password: 'p' } } };
            expect(await tm.getToken(config, 'admin')).toBe('token-1');
            expect(await tm.getToken(config, 'viewer')).toBe('token-2');
            expect(await tm.getToken(config, 'admin')).toBe('token-1');
            tm.invalidate('admin');
            expect(await tm.getToken(config, 'admin')).toBe('token-3');
            expect(await tm.getToken(config, 'viewer')).toBe('token-2');
        } finally {
            await srv.close();
        }
    });

    test('discovers the token endpoint from the issuer, once', async () => {
        const srv = await tokenServer((_f, n) => ok(n));
        try {
            const tm = new TokenManager();
            const config = { issuer: `${srv.base}/issuer/`, clientId: 'svc', clientSecret: 's' };
            await tm.getToken(config);
            tm.invalidate();
            await tm.getToken(config);
            expect(srv.seen.map((s) => s.path)).toEqual(['/issuer/.well-known/openid-configuration', '/token', '/token']);
        } finally {
            await srv.close();
        }
    });

    test('errors name the server error but never the secrets', async () => {
        const srv = await tokenServer(() => ({ status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed' } }));
        try {
            const tm = new TokenManager();
            const err = await tm
                .getToken({ tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 'TOP-SECRET-VALUE', roles: { admin: { username: 'a', password: 'PASSWORD-VALUE' } } }, 'admin')
                .then(() => new Error('expected a failure'), (e: Error) => e);
            expect(err.message).toContain('invalid_client: Client authentication failed');
            expect(err.message).toContain('role="admin"');
            expect(err.message).not.toContain('TOP-SECRET-VALUE');
            expect(err.message).not.toContain('PASSWORD-VALUE');
        } finally {
            await srv.close();
        }
    });

    test('missing endpoint, missing credentials and unknown roles fail clearly', async () => {
        const tm = new TokenManager();
        await expect(tm.getToken({ clientId: 'x' })).rejects.toThrow(/tokenUrl or auth\.issuer/);
        await expect(tm.getToken({ tokenUrl: 'http://127.0.0.1:1/token', grantType: 'password' })).rejects.toThrow(/needs a username and password/);
        expect(() => resolveRole({ roles: { admin: {} } }, 'editor')).toThrow(/configured roles: admin/);
    });

    test('expiry falls back to the JWT exp claim', async () => {
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
        expect(jwtExpiry(jwt)).toBe(exp * 1000);
        expect(jwtExpiry('opaque-token')).toBeUndefined();
        const srv = await tokenServer(() => ({ body: { access_token: jwt } }));
        try {
            const set = await new TokenManager().getTokenSet({ tokenUrl: `${srv.base}/token`, clientId: 'svc', clientSecret: 's' });
            expect(set.expiresAt).toBe(exp * 1000);
        } finally {
            await srv.close();
        }
    });
});

test.describe('auth — roles and headers', () => {
    test('resolveRole merges the role over top-level settings and picks the grant', () => {
        const config = { clientId: 'web', clientSecret: 's', scope: 'api', defaultRole: 'viewer', roles: { viewer: { username: 'v', password: 'p' }, svc: { clientId: 'svc', scope: 'admin' } } };
        expect(resolveRole(config)).toMatchObject({ name: 'viewer', clientId: 'web', username: 'v', scope: 'api', grantType: 'password' });
        expect(resolveRole(config, 'svc')).toMatchObject({ name: 'svc', clientId: 'svc', scope: 'admin', grantType: 'client_credentials', username: undefined });
        expect(resolveRole({ username: 'u', password: 'p' })).toMatchObject({ name: 'default', username: 'u', grantType: 'password' });
    });

    test('recorded headers never show the token or client secret', () => {
        const out = redactCredentials('Authorization: Bearer eyJhbGciOi.payload.sig; Authorization: Basic c3ZjOnNlY3JldA==');
        expect(out).not.toContain('eyJhbGciOi');
        expect(out).not.toContain('c3ZjOnNlY3JldA==');
    });

    test('authApplies needs an endpoint and respects applyTo', () => {
        expect(authApplies(undefined, 'openapi')).toBe(false);
        expect(authApplies({ roles: {} }, 'openapi')).toBe(false); // browser-only auth config
        expect(authApplies({ tokenUrl: 't' }, 'graphql')).toBe(true);
        expect(authApplies({ issuer: 'i', applyTo: ['openapi'] }, 'graphql')).toBe(false);
        expect(authApplies({ tokenUrl: 't' }, 'grpc')).toBe(true); // default: every client
        expect(authApplies({ tokenUrl: 't', applyTo: ['openapi', 'graphql'] }, 'grpc')).toBe(false);
    });

    test('withBearer adds the token unless an Authorization header is set', async () => {
        const token = async () => 'abc';
        expect((await withBearer({ 'X-A': '1' }, token)).get('authorization')).toBe('Bearer abc');
        expect((await withBearer({ authorization: 'Bearer mine' }, token)).get('authorization')).toBe('Bearer mine');
    });
});

test.describe('auth — browser login state', () => {
    test('authStateFile resolves under the state dir and rejects unsafe names', () => {
        expect(authStateFile('admin')).toBe(path.resolve('.auth/admin.json'));
        expect(authStateFile('qa-1', 'tmp/state')).toBe(path.resolve('tmp/state/qa-1.json'));
        expect(() => authStateFile('../etc/passwd')).toThrow(/invalid role name/);
    });

    test('rolesToSetUp: configured roles, else the default role', () => {
        expect(rolesToSetUp({ roles: { admin: {}, viewer: {} } })).toEqual(['admin', 'viewer']);
        expect(rolesToSetUp({})).toEqual(['default']);
        expect(rolesToSetUp({ defaultRole: 'qa' })).toEqual(['qa']);
    });

    test('hasFreshAuthState checks existence and age', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-state-'));
        try {
            expect(hasFreshAuthState('admin', 30, dir)).toBe(false);
            fs.writeFileSync(path.join(dir, 'admin.json'), '{}');
            expect(hasFreshAuthState('admin', 30, dir)).toBe(true);
            const old = new Date(Date.now() - 31 * 60_000);
            fs.utimesSync(path.join(dir, 'admin.json'), old, old);
            expect(hasFreshAuthState('admin', 30, dir)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('auth-setup writes the setup file once, with the given roles', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-setup-'));
        try {
            const lines: string[] = [];
            expect(runAuthSetup(['admin', 'viewer'], dir, (l = '') => lines.push(l))).toBe(0);
            const file = path.join(dir, 'tests/e2e/auth.setup.ts');
            expect(fs.readFileSync(file, 'utf8')).toContain("roles: ['admin', 'viewer'],");
            fs.writeFileSync(file, '// mine');
            runAuthSetup([], dir, () => {});
            expect(fs.readFileSync(file, 'utf8')).toBe('// mine'); // never overwritten
            expect(authSetupTemplate()).not.toContain('roles:');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test.describe('auth — PW_AUTH_* variables', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-config-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { auth: { roles: { admin: { username: 'a' } } } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('map onto the auth config and merge with environments.json', () => {
        Object.assign(process.env, {
            PW_AUTH_ISSUER: 'https://idp.test/realm',
            PW_AUTH_CLIENT_ID: 'web',
            PW_AUTH_CLIENT_SECRET: 'sec',
            PW_AUTH_CLIENT_AUTH: 'post',
            PW_AUTH_GRANT_TYPE: 'password',
            PW_AUTH_SCOPE: 'openid api',
            PW_AUTH_ROLE: 'admin',
            PW_AUTH_STATE_DIR: '.state',
        });
        expect(new ConfigLoader(dir).load('local').auth).toMatchObject({
            issuer: 'https://idp.test/realm',
            clientId: 'web',
            clientSecret: 'sec',
            clientAuth: 'post',
            grantType: 'password',
            scope: 'openid api',
            defaultRole: 'admin',
            stateDir: '.state',
            roles: { admin: { username: 'a' } },
        });
    });
});
