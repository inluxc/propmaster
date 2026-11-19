/**
 * HashiCorp Vault provider.
 *
 * Retrieves secrets from HashiCorp Vault via the HTTP API (KV v1 or v2 secrets engine)
 * using the native `fetch` API (or `node:https` when TLS options are set).
 *
 * Authentication: token, AppRole, Kubernetes or JWT. Supports Vault Enterprise
 * namespaces and custom TLS (CA, mutual TLS, SNI, skip-verify).
 *
 * Options fall back to `VAULT_*` environment variables (`VAULT_ADDR`, `VAULT_TOKEN`,
 * `VAULT_NAMESPACE`, `VAULT_CACERT`, ...). The implementation is shared with the
 * OpenBao provider; see `vault-compatible.ts`.
 */

import { VaultCompatibleProvider, type VaultCompatibleOptions } from './vault-compatible.js';

export interface VaultProviderOptions extends VaultCompatibleOptions {
    /** Vault server URL (e.g., 'https://vault.example.com'). Env: `VAULT_ADDR`. */
    url: string;
    /** Path prefix for secrets; for KV v2 include `data` (e.g., 'secret/data/playwright'). */
    mountPath: string;
}

/** Environment variable prefixes the Vault provider reads, in order. */
export const VAULT_ENV_PREFIXES = ['VAULT_'] as const;

export class VaultSecretsProvider extends VaultCompatibleProvider {
    readonly name = 'vault';

    constructor(options: VaultProviderOptions) {
        super('vault', options, VAULT_ENV_PREFIXES);
    }
}
