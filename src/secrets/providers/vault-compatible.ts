/**
 * Shared implementation for servers that speak the HashiCorp Vault HTTP API.
 *
 * Both HashiCorp Vault and OpenBao (the Linux Foundation fork of Vault) serve
 * the same `/v1` API: KV v1/v2 reads, `X-Vault-Token` / `X-Vault-Namespace`
 * headers, and the AppRole, Kubernetes and JWT login endpoints. The concrete
 * providers differ only in their name and in which environment variables they
 * read, so they subclass this base and pass an ordered list of env prefixes.
 *
 * Authentication methods:
 *   - token       — a client token (option or `<PREFIX>TOKEN`)
 *   - approle     — role_id + secret_id
 *   - kubernetes  — role + the pod's service-account JWT
 *   - jwt         — role + any JWT (e.g. a CI OIDC token)
 *
 * TLS: custom CA bundle/directory, mutual TLS client cert/key, SNI server name
 * and skip-verify, mirroring the `*_CACERT`, `*_CAPATH`, `*_CLIENT_CERT`,
 * `*_CLIENT_KEY`, `*_TLS_SERVER_NAME` and `*_SKIP_VERIFY` CLI variables.
 *
 * Credentials (tokens, secret_ids, JWTs, client keys) are never included in
 * error details, and are scrubbed from any server text echoed into an error.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent as HttpsAgent, request as httpsRequest, type AgentOptions } from 'node:https';
import type { SecretsProvider } from '../provider.interface.js';
import { SecretsError } from '../../errors.js';

/** Default location of the Kubernetes service-account token inside a pod. */
export const KUBERNETES_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

const MAX_ERROR_BODY_CHARS = 500;
const REDACTED = '[REDACTED]';
const MIN_REDACT_LENGTH = 4;

export type VaultAuthMethod = 'token' | 'approle' | 'kubernetes' | 'jwt';

/**
 * Options shared by every Vault-API-compatible provider.
 * Every option except `kvVersion` also has an environment-variable fallback;
 * see the concrete provider for the prefixes it reads.
 */
export interface VaultCompatibleOptions {
    /** Server URL (e.g., 'https://vault.example.com'). Env: `<PREFIX>ADDR`. */
    url?: string;
    /**
     * Path prefix that secret keys are appended to, after `/v1/`. For KV v2 this
     * includes the `data` segment (e.g., 'secret/data/playwright'); for KV v1 it
     * is the mount plus any folder (e.g., 'kv/playwright'). Env: `<PREFIX>MOUNT_PATH`.
     */
    mountPath?: string;
    /** KV secrets engine version: 1 or 2 (default: 2). Env: `<PREFIX>KV_VERSION`. */
    kvVersion?: 1 | 2;
    /** Namespace (e.g., 'admin/team-qa'), sent as `X-Vault-Namespace`. Env: `<PREFIX>NAMESPACE`. */
    namespace?: string;

    /**
     * Authentication method. When omitted it is inferred: `token` if a token is set,
     * otherwise `approle` if role_id + secret_id are set, otherwise `jwt` if a JWT
     * (or JWT path) is set. `kubernetes` must be chosen explicitly. Env: `<PREFIX>AUTH_METHOD`.
     */
    authMethod?: VaultAuthMethod;
    /**
     * Auth mount path, for auth methods mounted somewhere other than their default
     * (`approle`, `kubernetes`, `jwt`). Env: `<PREFIX>AUTH_MOUNT`.
     */
    authMount?: string;
    /** Client token. Env: `<PREFIX>TOKEN`. */
    token?: string;
    /** AppRole role_id. Env: `<PREFIX>ROLE_ID`. */
    roleId?: string;
    /** AppRole secret_id. Env: `<PREFIX>SECRET_ID`. */
    secretId?: string;
    /** Role name for Kubernetes / JWT login. Env: `<PREFIX>AUTH_ROLE`. */
    role?: string;
    /** JWT for Kubernetes / JWT login, given inline. Env: `<PREFIX>JWT`. */
    jwt?: string;
    /**
     * File to read the JWT from. For `kubernetes` it defaults to the pod's
     * service-account token. Env: `<PREFIX>JWT_PATH`.
     */
    jwtPath?: string;

    /** PEM CA bundle file used to verify the server. Env: `<PREFIX>CACERT`. */
    caCert?: string;
    /** Directory of PEM CA certificates (ignored when `caCert` is set). Env: `<PREFIX>CAPATH`. */
    caPath?: string;
    /** PEM client certificate for mutual TLS. Env: `<PREFIX>CLIENT_CERT`. */
    clientCert?: string;
    /** Unencrypted PEM client key for mutual TLS. Env: `<PREFIX>CLIENT_KEY`. */
    clientKey?: string;
    /** SNI server name to use when connecting. Env: `<PREFIX>TLS_SERVER_NAME`. */
    tlsServerName?: string;
    /** Disable server certificate verification (never use in shared environments). Env: `<PREFIX>SKIP_VERIFY`. */
    skipVerify?: boolean;
}

interface KV2Response {
    data?: { data?: Record<string, string> };
}

interface KV1Response {
    data?: Record<string, string>;
}

interface AuthResponse {
    auth?: { client_token?: string };
}

interface HttpResponse {
    status: number;
    ok: boolean;
    text: string;
}

/**
 * Reads option values, falling back to environment variables under each prefix
 * in order (e.g., `PW_OPENBAO_TOKEN`, then `BAO_TOKEN`, then `VAULT_TOKEN`).
 */
export class EnvFallback {
    constructor(
        private readonly prefixes: readonly string[],
        private readonly env: NodeJS.ProcessEnv = process.env
    ) {}

    get(explicit: string | undefined, suffix: string): string | undefined {
        if (explicit !== undefined && explicit !== '') return explicit;
        for (const prefix of this.prefixes) {
            const value = this.env[`${prefix}${suffix}`];
            if (value !== undefined && value !== '') return value;
        }
        return undefined;
    }

    /** All env var names consulted for a suffix, for error messages. */
    names(suffix: string): string {
        return this.prefixes.map((p) => `${p}${suffix}`).join(' / ');
    }
}

function parseBool(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export abstract class VaultCompatibleProvider implements SecretsProvider {
    abstract readonly name: string;

    protected readonly url: string;
    protected readonly mountPath: string;
    protected readonly kvVersion: 1 | 2;
    protected readonly namespace: string | undefined;

    private readonly authMethod: VaultAuthMethod | undefined;
    private readonly authMount: string | undefined;
    private readonly roleId: string | undefined;
    private readonly secretId: string | undefined;
    private readonly role: string | undefined;
    private readonly jwt: string | undefined;
    private readonly jwtPath: string | undefined;
    private readonly tls: AgentOptions | undefined;
    private readonly env: EnvFallback;
    private agent: HttpsAgent | undefined;
    private token: string;
    private login: Promise<void> | undefined;
    /** Credential values to scrub from any text that ends up in an error. */
    private readonly sensitive = new Set<string>();

    protected constructor(providerName: string, options: VaultCompatibleOptions, envPrefixes: readonly string[]) {
        const env = new EnvFallback(envPrefixes);
        this.env = env;

        const url = env.get(options.url, 'ADDR');
        if (!url) {
            throw new SecretsError(providerName, 'resolve', undefined, {
                reason: `No server URL configured. Set options.url or ${env.names('ADDR')}.`,
            });
        }
        const mountPath = env.get(options.mountPath, 'MOUNT_PATH');
        if (!mountPath) {
            throw new SecretsError(providerName, 'resolve', undefined, {
                reason: `No mount path configured. Set options.mountPath or ${env.names('MOUNT_PATH')}.`,
            });
        }

        this.url = url.replace(/\/+$/, '');
        this.mountPath = mountPath.replace(/^\/+|\/+$/g, '');

        const kvVersion = options.kvVersion ?? Number(env.get(undefined, 'KV_VERSION') ?? 2);
        if (kvVersion !== 1 && kvVersion !== 2) {
            throw new SecretsError(providerName, 'resolve', undefined, {
                reason: `kvVersion must be 1 or 2, got ${JSON.stringify(kvVersion)}`,
            });
        }
        this.kvVersion = kvVersion;
        this.namespace = env.get(options.namespace, 'NAMESPACE');

        const authMethod = env.get(options.authMethod, 'AUTH_METHOD');
        if (authMethod !== undefined && !['token', 'approle', 'kubernetes', 'jwt'].includes(authMethod)) {
            throw new SecretsError(providerName, 'resolve', undefined, {
                reason: `Unknown authMethod "${authMethod}". Use token, approle, kubernetes or jwt.`,
            });
        }
        this.authMethod = authMethod as VaultAuthMethod | undefined;
        this.authMount = env.get(options.authMount, 'AUTH_MOUNT')?.replace(/^\/+|\/+$/g, '');
        this.token = env.get(options.token, 'TOKEN') ?? '';
        this.roleId = env.get(options.roleId, 'ROLE_ID');
        this.secretId = env.get(options.secretId, 'SECRET_ID');
        this.role = env.get(options.role, 'AUTH_ROLE');
        this.jwt = env.get(options.jwt, 'JWT');
        this.jwtPath = env.get(options.jwtPath, 'JWT_PATH');

        for (const value of [this.token, this.secretId, this.jwt]) {
            if (value) this.sensitive.add(value);
        }

        this.tls = this.buildTlsOptions(providerName, options);
    }

    async getSecret(key: string): Promise<string> {
        await this.ensureAuthenticated();

        const secretData = await this.fetchSecretData(key);

        // Resolution order: a `value` field, then a field named after the key,
        // then the first value in the secret.
        if ('value' in secretData) {
            return secretData['value'];
        }
        if (key in secretData) {
            return secretData[key];
        }
        const values = Object.values(secretData);
        if (values.length === 0) {
            throw new SecretsError(this.name, 'fetch', key, {
                reason: 'Secret path exists but contains no data',
                ...this.location(),
            });
        }
        return values[0];
    }

    async getSecrets(keys: string[]): Promise<Map<string, string>> {
        await this.ensureAuthenticated();

        const results = new Map<string, string>();
        await Promise.all(
            keys.map(async (key) => {
                results.set(key, await this.getSecret(key));
            })
        );
        return results;
    }

    /** Context included in every error. Never contains credentials. */
    protected location(): Record<string, unknown> {
        const details: Record<string, unknown> = { url: this.url, mountPath: this.mountPath };
        if (this.namespace) details.namespace = this.namespace;
        return details;
    }

    /** Replaces every known credential value in `text` with `[REDACTED]` and truncates it. */
    protected redact(text: string): string {
        let out = text;
        for (const value of this.sensitive) {
            // Skip trivially short values: scrubbing them would mangle the whole message.
            if (value.length < MIN_REDACT_LENGTH) continue;
            out = out.split(value).join(REDACTED);
        }
        return out.length > MAX_ERROR_BODY_CHARS ? `${out.slice(0, MAX_ERROR_BODY_CHARS)}…` : out;
    }

    private resolveAuthMethod(): VaultAuthMethod {
        if (this.authMethod) return this.authMethod;
        if (this.token) return 'token';
        if (this.roleId && this.secretId) return 'approle';
        if (this.jwt || this.jwtPath) return 'jwt';
        throw new SecretsError(this.name, 'fetch', undefined, {
            reason:
                `No authentication method available. Provide a token (${this.env.names('TOKEN')}), ` +
                `AppRole credentials (${this.env.names('ROLE_ID')} + ${this.env.names('SECRET_ID')}), ` +
                `or a role and JWT for authMethod "kubernetes" / "jwt".`,
            ...this.location(),
        });
    }

    /** Logs in once (concurrent callers share the same login) unless a token is already held. */
    private async ensureAuthenticated(): Promise<void> {
        const method = this.resolveAuthMethod();
        if (method === 'token') {
            if (!this.token) {
                throw new SecretsError(this.name, 'fetch', undefined, {
                    reason: `authMethod "token" selected but no token is set (${this.env.names('TOKEN')}).`,
                    ...this.location(),
                });
            }
            return;
        }
        if (this.token) return;

        this.login ??= this.authenticate(method).catch((error: unknown) => {
            this.login = undefined; // allow a retry after a failed login
            throw error;
        });
        await this.login;
    }

    private async authenticate(method: Exclude<VaultAuthMethod, 'token'>): Promise<void> {
        let body: Record<string, string>;
        if (method === 'approle') {
            if (!this.roleId) {
                throw this.authError(method, `role_id is required (${this.env.names('ROLE_ID')})`);
            }
            body = { role_id: this.roleId };
            if (this.secretId) body.secret_id = this.secretId;
        } else {
            const jwt = this.readJwt(method);
            if (method === 'kubernetes' && !this.role) {
                throw this.authError(method, `role is required (${this.env.names('AUTH_ROLE')})`);
            }
            body = { jwt };
            if (this.role) body.role = this.role;
        }

        const mount = this.authMount ?? method;
        const url = `${this.url}/v1/auth/${mount}/login`;

        let response: HttpResponse;
        try {
            response = await this.send('POST', url, this.buildHeaders(false), JSON.stringify(body));
        } catch (error) {
            throw new SecretsError(
                this.name,
                'fetch',
                undefined,
                { reason: `${method} login failed: ${this.redact((error as Error).message)}`, authMount: mount, ...this.location() },
                error as Error
            );
        }

        if (!response.ok) {
            throw this.authError(method, `login returned ${response.status}: ${this.redact(response.text)}`, mount);
        }

        const token = (this.parseJson(response.text) as AuthResponse | undefined)?.auth?.client_token;
        if (!token) {
            throw this.authError(method, 'login response missing auth.client_token', mount);
        }
        this.token = token;
        this.sensitive.add(token);
    }

    private readJwt(method: 'kubernetes' | 'jwt'): string {
        if (this.jwt) return this.jwt;
        const path = this.jwtPath ?? (method === 'kubernetes' ? KUBERNETES_SA_TOKEN_PATH : undefined);
        if (!path) {
            throw this.authError(method, `a JWT is required (${this.env.names('JWT')} or ${this.env.names('JWT_PATH')})`);
        }
        let jwt: string;
        try {
            jwt = readFileSync(path, 'utf8').trim();
        } catch (error) {
            throw new SecretsError(
                this.name,
                'fetch',
                undefined,
                { reason: `${method} login: cannot read JWT file ${path}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, ...this.location() },
                error as Error
            );
        }
        if (!jwt) {
            throw this.authError(method, `JWT file ${path} is empty`);
        }
        this.sensitive.add(jwt);
        return jwt;
    }

    private authError(method: string, reason: string, authMount?: string): SecretsError {
        return new SecretsError(this.name, 'fetch', undefined, {
            reason: `${method} login failed: ${reason}`,
            ...(authMount ? { authMount } : {}),
            ...this.location(),
        });
    }

    private async fetchSecretData(secretPath: string): Promise<Record<string, string>> {
        // Encode each segment so nested keys like 'db/password' keep their slashes.
        const encodedPath = secretPath.split('/').map(encodeURIComponent).join('/');
        const url = `${this.url}/v1/${this.mountPath}/${encodedPath}`;

        let response: HttpResponse;
        try {
            response = await this.send('GET', url, this.buildHeaders(true));
        } catch (error) {
            throw new SecretsError(
                this.name,
                'fetch',
                secretPath,
                { reason: this.redact((error as Error).message), ...this.location() },
                error as Error
            );
        }

        if (!response.ok) {
            throw new SecretsError(this.name, 'fetch', secretPath, {
                reason: `API returned ${response.status}: ${this.redact(response.text)}`,
                ...this.location(),
            });
        }

        const body = this.parseJson(response.text);
        const data =
            this.kvVersion === 2 ? (body as KV2Response | undefined)?.data?.data : (body as KV1Response | undefined)?.data;
        if (!data || typeof data !== 'object') {
            throw new SecretsError(this.name, 'fetch', secretPath, {
                reason:
                    this.kvVersion === 2
                        ? 'Unexpected KV v2 response format (missing data.data). Does mountPath include the "data" segment?'
                        : 'Unexpected KV v1 response format (missing data)',
                ...this.location(),
            });
        }
        return data;
    }

    private parseJson(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }

    private buildHeaders(includeToken: boolean): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Vault-Request': 'true',
        };
        if (includeToken && this.token) {
            headers['X-Vault-Token'] = this.token;
        }
        if (this.namespace) {
            headers['X-Vault-Namespace'] = this.namespace;
        }
        return headers;
    }

    private buildTlsOptions(providerName: string, options: VaultCompatibleOptions): AgentOptions | undefined {
        const env = this.env;
        const caCert = env.get(options.caCert, 'CACERT');
        const caPath = env.get(options.caPath, 'CAPATH');
        const clientCert = env.get(options.clientCert, 'CLIENT_CERT');
        const clientKey = env.get(options.clientKey, 'CLIENT_KEY');
        const servername = env.get(options.tlsServerName, 'TLS_SERVER_NAME');
        const skipVerify = options.skipVerify ?? parseBool(env.get(undefined, 'SKIP_VERIFY'));

        if (!caCert && !caPath && !clientCert && !clientKey && !servername && !skipVerify) {
            return undefined;
        }
        if (Boolean(clientCert) !== Boolean(clientKey)) {
            throw new SecretsError(providerName, 'resolve', undefined, {
                reason: 'clientCert and clientKey must be set together for mutual TLS',
            });
        }

        const read = (file: string, what: string): string => {
            try {
                return readFileSync(file, 'utf8');
            } catch (error) {
                throw new SecretsError(
                    providerName,
                    'resolve',
                    undefined,
                    { reason: `Cannot read ${what} ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}` },
                    error as Error
                );
            }
        };

        const tls: AgentOptions = {};
        if (caCert) {
            tls.ca = read(caCert, 'CA certificate');
        } else if (caPath) {
            let files: string[];
            try {
                files = readdirSync(caPath).filter((f) => /\.(pem|crt|cer)$/i.test(f));
            } catch (error) {
                throw new SecretsError(
                    providerName,
                    'resolve',
                    undefined,
                    { reason: `Cannot read CA directory ${caPath}: ${(error as NodeJS.ErrnoException).code ?? 'error'}` },
                    error as Error
                );
            }
            tls.ca = files.map((f) => read(join(caPath, f), 'CA certificate'));
        }
        if (clientCert && clientKey) {
            tls.cert = read(clientCert, 'client certificate');
            const key = read(clientKey, 'client key');
            tls.key = key;
            this.sensitive.add(key);
        }
        if (servername) tls.servername = servername;
        if (skipVerify) tls.rejectUnauthorized = false;
        return tls;
    }

    /**
     * Sends a request. Uses the global `fetch` unless TLS options are configured
     * for an https URL, in which case `node:https` is used with a dedicated agent
     * (native fetch cannot take a CA or client certificate without undici).
     */
    private async send(method: string, url: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
        if (!this.tls || !url.startsWith('https:')) {
            const response = await fetch(url, { method, headers, body });
            const text = await response.text().catch(() => '');
            return { status: response.status, ok: response.ok, text };
        }

        this.agent ??= new HttpsAgent(this.tls);
        const agent = this.agent;
        return new Promise<HttpResponse>((resolve, reject) => {
            const req = httpsRequest(url, { method, headers, agent }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') });
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            if (body !== undefined) req.write(body);
            req.end();
        });
    }
}
