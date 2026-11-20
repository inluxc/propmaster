/**
 * OAuth 2.0 / OIDC access tokens for tests.
 *
 * One TokenManager lives per Playwright worker (the `propmasterAuth` worker
 * fixture). It fetches a token the first time a role needs one, caches it,
 * and gets a new one shortly before it expires — with the refresh token when
 * the server issued one, otherwise with a fresh grant. Concurrent requests for
 * the same role share one network call.
 *
 * Secrets never appear in errors: messages name the endpoint, role, client ID
 * and the server's `error`/`error_description`, nothing else.
 *
 * Uses Node's built-in fetch; no package needed.
 */

import type { AuthConfig, AuthRoleConfig } from '../config/schema.js';
import { FixtureInitError } from '../errors.js';

export const DEFAULT_ROLE = 'default';
const DEFAULT_REFRESH_BEFORE_EXPIRY = 60;
/** Lifetime assumed when the server sends neither `expires_in` nor a JWT `exp`. */
const DEFAULT_LIFETIME = 300;

export interface TokenSet {
    accessToken: string;
    tokenType: string;
    /** Epoch ms. */
    expiresAt: number;
    refreshToken?: string;
    idToken?: string;
}

/** A role's effective settings: the role's own values over the top-level ones. */
export interface ResolvedRole {
    name: string;
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    scope?: string;
    grantType: 'client_credentials' | 'password';
    extra: Record<string, string>;
}

/** The role a test uses: `authRole`, else `defaultRole`, else `default`. */
export function roleName(config: AuthConfig, authRole?: string): string {
    return authRole ?? config.defaultRole ?? DEFAULT_ROLE;
}

/** Merges a role's settings over the top-level ones. Unknown roles fail with the list of known ones. */
export function resolveRole(config: AuthConfig, authRole?: string): ResolvedRole {
    const name = roleName(config, authRole);
    const roles = config.roles ?? {};
    const own: AuthRoleConfig | undefined = roles[name];
    if (!own && name !== (config.defaultRole ?? DEFAULT_ROLE)) {
        throw new FixtureInitError('auth', 'init', {
            role: name,
            reason: `unknown role; configured roles: ${Object.keys(roles).join(', ') || 'none'} (add it under auth.roles)`,
        });
    }
    const username = own?.username ?? (own ? undefined : config.username);
    const password = own?.password ?? (own ? undefined : config.password);
    return {
        name,
        clientId: own?.clientId ?? config.clientId,
        clientSecret: own?.clientSecret ?? config.clientSecret,
        username,
        password,
        scope: own?.scope ?? config.scope,
        grantType: config.grantType ?? (username ? 'password' : 'client_credentials'),
        extra: { ...(own?.extra ?? {}) },
    };
}

/** `exp` from a JWT, without verifying it (only to schedule a refresh). */
export function jwtExpiry(token: string): number | undefined {
    const part = token.split('.')[1];
    if (!part) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
        return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
    } catch {
        return undefined;
    }
}

type Fetch = typeof fetch;

export class TokenManager {
    private readonly tokens = new Map<string, TokenSet>();
    private readonly pending = new Map<string, Promise<TokenSet>>();
    private readonly endpoints = new Map<string, Promise<string>>();

    constructor(
        private readonly fetchImpl: Fetch = (...args) => fetch(...args),
        private readonly now: () => number = Date.now,
    ) {}

    /** A valid access token for the role, fetched or refreshed as needed. */
    async getToken(config: AuthConfig, authRole?: string): Promise<string> {
        return (await this.getTokenSet(config, authRole)).accessToken;
    }

    async getTokenSet(config: AuthConfig, authRole?: string): Promise<TokenSet> {
        const role = resolveRole(config, authRole);
        const key = JSON.stringify([config.tokenUrl ?? config.issuer, role.clientId, role.name, role.username, role.scope, config.audience]);
        const cached = this.tokens.get(key);
        const margin = (config.refreshBeforeExpiry ?? DEFAULT_REFRESH_BEFORE_EXPIRY) * 1000;
        if (cached && this.now() < cached.expiresAt - margin) return cached;

        let inflight = this.pending.get(key);
        if (!inflight) {
            inflight = this.obtain(config, role, cached?.refreshToken)
                .then((set) => {
                    this.tokens.set(key, set);
                    return set;
                })
                .finally(() => this.pending.delete(key));
            this.pending.set(key, inflight);
        }
        return inflight;
    }

    /** Forgets cached tokens (all, or one role's), e.g. after the server revoked them. */
    invalidate(authRole?: string): void {
        if (authRole === undefined) this.tokens.clear();
        else for (const key of this.tokens.keys()) if (JSON.parse(key)[2] === authRole) this.tokens.delete(key);
    }

    /** `tokenUrl`, or the issuer's discovery document's `token_endpoint`. */
    tokenEndpoint(config: AuthConfig): Promise<string> {
        if (config.tokenUrl) return Promise.resolve(config.tokenUrl);
        if (!config.issuer) {
            return Promise.reject(new FixtureInitError('auth', 'init', { reason: 'set auth.tokenUrl or auth.issuer (PW_AUTH_TOKEN_URL / PW_AUTH_ISSUER)' }));
        }
        const issuer = config.issuer.replace(/\/+$/, '');
        let endpoint = this.endpoints.get(issuer);
        if (!endpoint) {
            const url = `${issuer}/.well-known/openid-configuration`;
            endpoint = this.fetchImpl(url, { headers: { Accept: 'application/json' } })
                .then(async (res) => {
                    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
                    const doc = (await res.json()) as { token_endpoint?: string };
                    if (!doc.token_endpoint) throw new Error(`${url} has no token_endpoint`);
                    return doc.token_endpoint;
                })
                .catch((error: unknown) => {
                    this.endpoints.delete(issuer);
                    throw new FixtureInitError('auth', 'connect', { issuer, reason: error instanceof Error ? error.message : String(error) });
                });
            this.endpoints.set(issuer, endpoint);
        }
        return endpoint;
    }

    private async obtain(config: AuthConfig, role: ResolvedRole, refreshToken?: string): Promise<TokenSet> {
        const endpoint = await this.tokenEndpoint(config);
        if (refreshToken) {
            try {
                return await this.request(endpoint, config, role, { grant_type: 'refresh_token', refresh_token: refreshToken });
            } catch {
                // An expired or revoked refresh token: fall back to a fresh grant below.
            }
        }
        if (role.grantType === 'password') {
            if (!role.username || role.password === undefined) {
                throw new FixtureInitError('auth', 'init', {
                    role: role.name,
                    reason: 'the password grant needs a username and password for this role (auth.roles.<role> or PW_AUTH_USERNAME/PW_AUTH_PASSWORD)',
                });
            }
            return this.request(endpoint, config, role, { grant_type: 'password', username: role.username, password: role.password });
        }
        return this.request(endpoint, config, role, { grant_type: 'client_credentials' });
    }

    private async request(endpoint: string, config: AuthConfig, role: ResolvedRole, params: Record<string, string>): Promise<TokenSet> {
        const body = new URLSearchParams(params);
        if (role.scope) body.set('scope', role.scope);
        if (config.audience) body.set('audience', config.audience);
        const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (role.clientId) {
            if ((config.clientAuth ?? 'basic') === 'basic' && role.clientSecret !== undefined) {
                const id = encodeURIComponent(role.clientId);
                const secret = encodeURIComponent(role.clientSecret);
                headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
            } else {
                body.set('client_id', role.clientId);
                if (role.clientSecret !== undefined) body.set('client_secret', role.clientSecret);
            }
        }

        const context = { tokenUrl: endpoint, role: role.name, clientId: role.clientId, grantType: params.grant_type };
        let res: Response;
        try {
            res = await this.fetchImpl(endpoint, { method: 'POST', headers, body });
        } catch (error) {
            throw new FixtureInitError('auth', 'connect', { ...context, reason: error instanceof Error ? error.message : String(error) });
        }
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || typeof data.access_token !== 'string') {
            const detail = [data.error, data.error_description].filter((v) => typeof v === 'string').join(': ');
            throw new FixtureInitError('auth', 'init', {
                ...context,
                reason: `token request failed with ${res.status}${detail ? ` (${detail})` : typeof data.access_token !== 'string' && res.ok ? ' (no access_token in the response)' : ''}`,
            });
        }

        const accessToken = data.access_token;
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in);
        const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : (jwtExpiry(accessToken) ?? this.now() + DEFAULT_LIFETIME * 1000);
        return {
            accessToken,
            tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
            expiresAt,
            refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
            idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
        };
    }
}
