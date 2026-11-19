/**
 * OpenBao provider.
 *
 * OpenBao (https://openbao.org) is the Linux Foundation's open-source fork of
 * HashiCorp Vault. Its HTTP API is wire-compatible with Vault's for everything
 * this provider uses — `/v1` KV v1/v2 reads, the `X-Vault-Token` and
 * `X-Vault-Namespace` headers, and the AppRole / Kubernetes / JWT login
 * endpoints — so it shares the Vault implementation (`vault-compatible.ts`).
 *
 * What differs is configuration: every option falls back to environment
 * variables in this order, so the framework's own `PW_*` variables win over the
 * OpenBao CLI's `BAO_*`, which win over the `VAULT_*` names OpenBao also accepts:
 *
 *   PW_OPENBAO_<NAME>  →  BAO_<NAME>  →  VAULT_<NAME>
 *
 * e.g. `PW_OPENBAO_ADDR` / `BAO_ADDR` / `VAULT_ADDR`, `BAO_TOKEN`, `BAO_NAMESPACE`,
 * `BAO_CACERT`, `BAO_CLIENT_CERT`, `BAO_SKIP_VERIFY`. Because `BAO_ADDR` and
 * `BAO_TOKEN` are enough, `url` is optional here.
 */

import { VaultCompatibleProvider, type VaultCompatibleOptions } from './vault-compatible.js';

export type OpenBaoProviderOptions = VaultCompatibleOptions;

/** Environment variable prefixes the OpenBao provider reads, highest precedence first. */
export const OPENBAO_ENV_PREFIXES = ['PW_OPENBAO_', 'BAO_', 'VAULT_'] as const;

export class OpenBaoSecretsProvider extends VaultCompatibleProvider {
    readonly name = 'openbao';

    constructor(options: OpenBaoProviderOptions = {}) {
        super('openbao', options, OPENBAO_ENV_PREFIXES);
    }
}
