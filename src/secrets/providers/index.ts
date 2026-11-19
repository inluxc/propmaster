/**
 * Provider registry for secrets provider backends.
 *
 * Exports all built-in provider classes and a factory function
 * that creates default provider instances from configuration options.
 */

export { AwsSecretsProvider, type AwsProviderOptions } from './aws.provider.js';
export { GitLabSecretsProvider, type GitLabProviderOptions } from './gitlab.provider.js';
export { VaultSecretsProvider, type VaultProviderOptions } from './vault.provider.js';
export { OpenBaoSecretsProvider, type OpenBaoProviderOptions } from './openbao.provider.js';
export { VaultCompatibleProvider, type VaultCompatibleOptions, type VaultAuthMethod } from './vault-compatible.js';
export { AzureSecretsProvider, type AzureProviderOptions } from './azure.provider.js';
export { EnvFileSecretsProvider, type EnvFileProviderOptions } from './env-file.provider.js';

import type { SecretsProvider } from '../provider.interface.js';
import { AwsSecretsProvider, AwsProviderOptions } from './aws.provider.js';
import { GitLabSecretsProvider, GitLabProviderOptions } from './gitlab.provider.js';
import { VaultSecretsProvider, VaultProviderOptions } from './vault.provider.js';
import { OpenBaoSecretsProvider, OpenBaoProviderOptions } from './openbao.provider.js';
import { AzureSecretsProvider, AzureProviderOptions } from './azure.provider.js';
import { EnvFileSecretsProvider, EnvFileProviderOptions } from './env-file.provider.js';

/**
 * Options for creating provider instances.
 * Each key corresponds to a provider name, and the value is the provider-specific options.
 */
export interface ProviderRegistryOptions {
    aws?: AwsProviderOptions;
    gitlab?: GitLabProviderOptions;
    vault?: VaultProviderOptions;
    openbao?: OpenBaoProviderOptions;
    azure?: AzureProviderOptions;
    'env-file'?: EnvFileProviderOptions;
}

/**
 * Creates an array of built-in provider instances based on the provided options.
 * Only providers with configuration options supplied will be instantiated.
 *
 * If no options are provided, creates a default env-file provider.
 *
 * @param options - Provider-specific configuration options
 * @returns Array of instantiated SecretsProvider instances
 */
export function createDefaultProviders(options?: ProviderRegistryOptions): SecretsProvider[] {
    const providers: SecretsProvider[] = [];

    if (options?.aws) {
        providers.push(new AwsSecretsProvider(options.aws));
    }

    if (options?.gitlab) {
        providers.push(new GitLabSecretsProvider(options.gitlab));
    }

    if (options?.vault) {
        providers.push(new VaultSecretsProvider(options.vault));
    }

    if (options?.openbao) {
        providers.push(new OpenBaoSecretsProvider(options.openbao));
    }

    if (options?.azure) {
        providers.push(new AzureSecretsProvider(options.azure));
    }

    if (options?.['env-file']) {
        providers.push(new EnvFileSecretsProvider(options['env-file']));
    }

    // If no providers were configured, add a default env-file provider
    if (providers.length === 0) {
        providers.push(new EnvFileSecretsProvider());
    }

    return providers;
}

/**
 * Creates a single provider instance by name with the given options.
 *
 * @param name - Provider name ('aws', 'gitlab', 'vault', 'openbao', 'azure', 'env-file')
 * @param options - Provider-specific configuration options
 * @returns A SecretsProvider instance
 * @throws Error if the provider name is not recognized
 */
export function createProvider(name: string, options: Record<string, unknown>): SecretsProvider {
    switch (name) {
        case 'aws':
            return new AwsSecretsProvider(options as unknown as AwsProviderOptions);
        case 'gitlab':
            return new GitLabSecretsProvider(options as unknown as GitLabProviderOptions);
        case 'vault':
            return new VaultSecretsProvider(options as unknown as VaultProviderOptions);
        case 'openbao':
            return new OpenBaoSecretsProvider(options as OpenBaoProviderOptions);
        case 'azure':
            return new AzureSecretsProvider(options as unknown as AzureProviderOptions);
        case 'env-file':
            return new EnvFileSecretsProvider(options as unknown as EnvFileProviderOptions);
        default:
            throw new Error(`Unknown secrets provider: "${name}". Available providers: aws, gitlab, vault, openbao, azure, env-file`);
    }
}
