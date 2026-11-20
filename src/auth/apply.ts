/**
 * Applies the auth helpers' bearer token to the OpenAPI and GraphQL clients.
 * The token is fetched per request from the worker's TokenManager, so a token
 * that expires mid-test is refreshed. A header the test set itself wins.
 */

import type { AuthConfig } from '../config/schema.js';
import type { TokenManager } from './token-manager.js';

export type AuthTarget = 'openapi' | 'graphql';

/** True when auth has a token endpoint and `applyTo` (default: both clients) includes `target`. */
export function authApplies(config: AuthConfig | undefined, target: AuthTarget): config is AuthConfig {
    return !!config && !!(config.tokenUrl || config.issuer) && (config.applyTo ?? ['openapi', 'graphql']).includes(target);
}

/** A function that returns the current bearer token for the test's role. */
export function bearerSource(tokens: TokenManager, config: AuthConfig, role: string | undefined): () => Promise<string> {
    return () => tokens.getToken(config, role);
}

/** Headers with `Authorization: Bearer <token>` added unless one is already set (any case). */
export async function withBearer(headers: HeadersInit | undefined, token: () => Promise<string>): Promise<Headers> {
    const result = new Headers(headers);
    if (!result.has('authorization')) result.set('Authorization', `Bearer ${await token()}`);
    return result;
}
