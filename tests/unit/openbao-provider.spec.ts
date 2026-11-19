import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OpenBaoSecretsProvider, OPENBAO_ENV_PREFIXES } from '../../src/secrets/providers/openbao.provider';
import { VaultSecretsProvider } from '../../src/secrets/providers/vault.provider';
import { createProvider, createDefaultProviders } from '../../src/secrets/providers';
import { SecretsManager } from '../../src/secrets/secrets-manager';
import { SecretsError } from '../../src/errors';
import type { FrameworkConfig } from '../../src/config/schema';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
}

type Handler = (call: Call) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

const realFetch = globalThis.fetch;
const ENV_SUFFIXES = [
    'ADDR', 'TOKEN', 'NAMESPACE', 'ROLE_ID', 'SECRET_ID', 'MOUNT_PATH', 'KV_VERSION', 'AUTH_METHOD', 'AUTH_MOUNT',
    'AUTH_ROLE', 'JWT', 'JWT_PATH', 'CACERT', 'CAPATH', 'CLIENT_CERT', 'CLIENT_KEY', 'TLS_SERVER_NAME', 'SKIP_VERIFY',
];
const ENV_NAMES = OPENBAO_ENV_PREFIXES.flatMap((p) => ENV_SUFFIXES.map((s) => `${p}${s}`));
let savedEnv: Record<string, string | undefined>;

/** Replaces global fetch with a recorder; returns the recorded calls. */
function mockFetch(handler: Handler): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const call: Call = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        const { status = 200, body } = await handler(call);
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return calls;
}

const kv2 = (data: Record<string, string>) => ({ body: { data: { data, metadata: { version: 1 } } } });

async function catchError(fn: () => unknown): Promise<SecretsError> {
    try {
        await fn();
    } catch (error) {
        expect(error).toBeInstanceOf(SecretsError);
        return error as SecretsError;
    }
    throw new Error('expected a SecretsError');
}

test.beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const n of ENV_NAMES) delete process.env[n];
});

test.afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [n, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
    }
});

test.describe('OpenBaoSecretsProvider — registration', () => {
    test('createProvider("openbao") returns the OpenBao provider', () => {
        const provider = createProvider('openbao', { url: 'https://bao.test', mountPath: 'secret/data/app', token: 't' });
        expect(provider).toBeInstanceOf(OpenBaoSecretsProvider);
        expect(provider.name).toBe('openbao');
    });

    test('createDefaultProviders includes openbao when configured', () => {
        const providers = createDefaultProviders({ openbao: { url: 'https://bao.test', mountPath: 'kv', token: 't' } });
        expect(providers.map((p) => p.name)).toEqual(['openbao']);
    });

    test('unknown provider error lists openbao', () => {
        expect(() => createProvider('nope', {})).toThrow(/openbao/);
    });

    test('secrets.provider "openbao" resolves through SecretsManager', async () => {
        mockFetch((call) => kv2({ value: call.url.endsWith('/db-password') ? 'pg-pass' : 'redis-pass' }));
        const manager = new SecretsManager();
        manager.registerProvider(createProvider('openbao', { url: 'https://bao.test', mountPath: 'secret/data/app', token: 't' }));

        const config = {
            environment: 'dev',
            database: { type: 'postgresql', host: 'h', port: 5432, database: 'd', username: 'u', password: '' },
            redis: { host: 'h', port: 6379, password: '' },
            secrets: { provider: 'openbao', keyMappings: { 'db-password': 'database.password', 'redis-password': 'redis.password' } },
        } as unknown as FrameworkConfig;

        const resolved = await manager.resolve(config);
        expect(resolved.database?.password).toBe('pg-pass');
        expect(resolved.redis?.password).toBe('redis-pass');
    });
});

test.describe('OpenBaoSecretsProvider — KV reads', () => {
    test('reads KV v2 with token and namespace headers', async () => {
        const calls = mockFetch(() => kv2({ value: 's3cret' }));
        const provider = new OpenBaoSecretsProvider({
            url: 'https://bao.test/',
            mountPath: '/secret/data/playwright/',
            token: 'tok',
            namespace: 'team-qa',
        });

        expect(await provider.getSecret('db-password')).toBe('s3cret');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://bao.test/v1/secret/data/playwright/db-password');
        expect(calls[0].method).toBe('GET');
        expect(calls[0].headers['X-Vault-Token']).toBe('tok');
        expect(calls[0].headers['X-Vault-Namespace']).toBe('team-qa');
        expect(calls[0].headers['X-Vault-Request']).toBe('true');
    });

    test('keeps slashes in nested keys and encodes other characters', async () => {
        const calls = mockFetch(() => kv2({ value: 'v' }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret/data', token: 't' });
        await provider.getSecret('team a/db password');
        expect(calls[0].url).toBe('https://bao.test/v1/secret/data/team%20a/db%20password');
    });

    test('reads KV v1 responses', async () => {
        mockFetch(() => ({ body: { data: { 'api-key': 'k1' } } }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'kv', kvVersion: 1, token: 't' });
        expect(await provider.getSecret('api-key')).toBe('k1');
    });

    test('resolves value field, then key-named field, then first value', async () => {
        const data: Record<string, Record<string, string>> = {
            a: { other: 'x', value: 'from-value' },
            b: { other: 'x', b: 'from-key' },
            c: { first: 'from-first', second: 'y' },
        };
        mockFetch((call) => kv2(data[call.url.split('/').pop()!]));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret/data', token: 't' });
        const result = await provider.getSecrets(['a', 'b', 'c']);
        expect(Object.fromEntries(result)).toEqual({ a: 'from-value', b: 'from-key', c: 'from-first' });
    });

    test('KV v2 response without data.data points at the mount path', async () => {
        mockFetch(() => ({ body: { data: { value: 'looks like v1' } } }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret', token: 't' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.operation).toBe('fetch');
        expect(error.message).toContain('data.data');
        expect(error.message).toContain('mountPath');
    });

    test('empty secret raises SecretsError', async () => {
        mockFetch(() => kv2({}));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret/data', token: 't' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).toContain('contains no data');
    });
});

test.describe('OpenBaoSecretsProvider — environment fallbacks', () => {
    test('PW_OPENBAO_* wins over BAO_*, which wins over VAULT_*', async () => {
        process.env.VAULT_ADDR = 'https://vault-addr.test';
        process.env.BAO_ADDR = 'https://bao-addr.test';
        process.env.PW_OPENBAO_ADDR = 'https://pw-addr.test';
        process.env.VAULT_TOKEN = 'vault-token';
        process.env.BAO_TOKEN = 'bao-token';
        process.env.BAO_MOUNT_PATH = 'secret/data/env';
        const calls = mockFetch(() => kv2({ value: 'v' }));

        await new OpenBaoSecretsProvider().getSecret('k');
        expect(calls[0].url).toBe('https://pw-addr.test/v1/secret/data/env/k');
        expect(calls[0].headers['X-Vault-Token']).toBe('bao-token');
    });

    test('falls back to VAULT_* when no BAO_* is set', async () => {
        process.env.VAULT_ADDR = 'https://vault-addr.test';
        process.env.VAULT_TOKEN = 'vault-token';
        process.env.VAULT_NAMESPACE = 'ns1';
        const calls = mockFetch(() => kv2({ value: 'v' }));

        await new OpenBaoSecretsProvider({ mountPath: 'secret/data' }).getSecret('k');
        expect(calls[0].url).toBe('https://vault-addr.test/v1/secret/data/k');
        expect(calls[0].headers['X-Vault-Token']).toBe('vault-token');
        expect(calls[0].headers['X-Vault-Namespace']).toBe('ns1');
    });

    test('explicit options win over every env var', async () => {
        process.env.PW_OPENBAO_ADDR = 'https://pw-addr.test';
        process.env.PW_OPENBAO_TOKEN = 'env-token';
        const calls = mockFetch(() => kv2({ value: 'v' }));

        await new OpenBaoSecretsProvider({ url: 'https://opt.test', mountPath: 'm', token: 'opt-token' }).getSecret('k');
        expect(calls[0].url).toBe('https://opt.test/v1/m/k');
        expect(calls[0].headers['X-Vault-Token']).toBe('opt-token');
    });

    test('BAO_KV_VERSION selects KV v1', async () => {
        process.env.BAO_KV_VERSION = '1';
        mockFetch(() => ({ body: { data: { value: 'v1-value' } } }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'kv', token: 't' });
        expect(await provider.getSecret('k')).toBe('v1-value');
    });

    test('the Vault provider ignores BAO_* variables', async () => {
        process.env.BAO_TOKEN = 'bao-token';
        process.env.VAULT_TOKEN = 'vault-token';
        const calls = mockFetch(() => kv2({ value: 'v' }));

        const provider = new VaultSecretsProvider({ url: 'https://vault.test', mountPath: 'secret/data' });
        expect(provider.name).toBe('vault');
        await provider.getSecret('k');
        expect(calls[0].headers['X-Vault-Token']).toBe('vault-token');
    });

    test('missing URL raises SecretsError naming the env vars', async () => {
        const error = await catchError(() => new OpenBaoSecretsProvider({ mountPath: 'm', token: 't' }));
        expect(error.operation).toBe('resolve');
        expect(error.message).toContain('PW_OPENBAO_ADDR / BAO_ADDR / VAULT_ADDR');
    });

    test('missing mount path raises SecretsError', async () => {
        const error = await catchError(() => new OpenBaoSecretsProvider({ url: 'https://bao.test', token: 't' }));
        expect(error.message).toContain('BAO_MOUNT_PATH');
    });

    test('invalid kvVersion and authMethod raise SecretsError', async () => {
        process.env.BAO_KV_VERSION = '3';
        expect((await catchError(() => new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm' }))).message).toContain('kvVersion');
        delete process.env.BAO_KV_VERSION;
        process.env.BAO_AUTH_METHOD = 'ldap';
        expect((await catchError(() => new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm' }))).message).toContain('ldap');
    });
});

test.describe('OpenBaoSecretsProvider — authentication', () => {
    test('AppRole logs in once and uses the returned token', async () => {
        const calls = mockFetch((call) =>
            call.url.endsWith('/v1/auth/approle/login')
                ? { body: { auth: { client_token: 'approle-token', lease_duration: 60, renewable: true } } }
                : kv2({ value: 'v' })
        );
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret/data', roleId: 'rid', secretId: 'sid' });

        await provider.getSecrets(['a', 'b', 'c']);
        await provider.getSecret('d');

        const logins = calls.filter((c) => c.url.includes('/auth/'));
        expect(logins).toHaveLength(1);
        expect(logins[0].method).toBe('POST');
        expect(logins[0].body).toEqual({ role_id: 'rid', secret_id: 'sid' });
        expect(logins[0].headers['X-Vault-Token']).toBeUndefined();
        const reads = calls.filter((c) => !c.url.includes('/auth/'));
        expect(reads).toHaveLength(4);
        for (const read of reads) expect(read.headers['X-Vault-Token']).toBe('approle-token');
    });

    test('AppRole credentials come from BAO_ROLE_ID / BAO_SECRET_ID', async () => {
        process.env.BAO_ROLE_ID = 'env-rid';
        process.env.BAO_SECRET_ID = 'env-sid';
        const calls = mockFetch((call) =>
            call.url.includes('/auth/') ? { body: { auth: { client_token: 'tk' } } } : kv2({ value: 'v' })
        );
        await new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'm' }).getSecret('k');
        expect(calls[0].body).toEqual({ role_id: 'env-rid', secret_id: 'env-sid' });
    });

    test('Kubernetes login reads the service-account JWT file and honours authMount', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'bao-k8s-'));
        try {
            const jwtPath = join(dir, 'token');
            writeFileSync(jwtPath, 'k8s.jwt.value\n');
            const calls = mockFetch((call) =>
                call.url.includes('/auth/') ? { body: { auth: { client_token: 'k8s-token' } } } : kv2({ value: 'v' })
            );
            const provider = new OpenBaoSecretsProvider({
                url: 'https://bao.test',
                mountPath: 'secret/data',
                authMethod: 'kubernetes',
                authMount: 'k8s-prod',
                role: 'playwright',
                jwtPath,
                namespace: 'qa',
            });

            await provider.getSecret('k');
            expect(calls[0].url).toBe('https://bao.test/v1/auth/k8s-prod/login');
            expect(calls[0].body).toEqual({ jwt: 'k8s.jwt.value', role: 'playwright' });
            expect(calls[0].headers['X-Vault-Namespace']).toBe('qa');
            expect(calls[1].headers['X-Vault-Token']).toBe('k8s-token');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('Kubernetes login requires a role', async () => {
        mockFetch(() => kv2({ value: 'v' }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', authMethod: 'kubernetes', jwt: 'j' });
        expect((await catchError(() => provider.getSecret('k'))).message).toContain('role is required');
    });

    test('Kubernetes login with an unreadable JWT file raises SecretsError', async () => {
        mockFetch(() => kv2({ value: 'v' }));
        const provider = new OpenBaoSecretsProvider({
            url: 'https://b', mountPath: 'm', authMethod: 'kubernetes', role: 'r', jwtPath: '/nonexistent/bao/token',
        });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).toContain('cannot read JWT file');
        expect(error.message).toContain('ENOENT');
    });

    test('JWT login is inferred from an inline JWT', async () => {
        process.env.PW_OPENBAO_JWT = 'ci.oidc.jwt';
        process.env.BAO_AUTH_ROLE = 'ci';
        const calls = mockFetch((call) =>
            call.url.includes('/auth/') ? { body: { auth: { client_token: 'jwt-token' } } } : kv2({ value: 'v' })
        );
        await new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'm' }).getSecret('k');
        expect(calls[0].url).toBe('https://bao.test/v1/auth/jwt/login');
        expect(calls[0].body).toEqual({ jwt: 'ci.oidc.jwt', role: 'ci' });
    });

    test('no credentials raises SecretsError listing every option', async () => {
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).toContain('PW_OPENBAO_TOKEN / BAO_TOKEN / VAULT_TOKEN');
        expect(error.message).toContain('BAO_ROLE_ID');
    });

    test('login response without client_token raises SecretsError', async () => {
        mockFetch(() => ({ body: { auth: {} } }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', roleId: 'r', secretId: 's' });
        expect((await catchError(() => provider.getSecret('k'))).message).toContain('missing auth.client_token');
    });

    test('a failed login can be retried', async () => {
        let attempt = 0;
        mockFetch((call) => {
            if (call.url.includes('/auth/')) {
                attempt++;
                return attempt === 1 ? { status: 503, body: 'sealed' } : { body: { auth: { client_token: 'tk' } } };
            }
            return kv2({ value: 'v' });
        });
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', roleId: 'r', secretId: 's' });
        await catchError(() => provider.getSecret('k'));
        expect(await provider.getSecret('k')).toBe('v');
    });
});

test.describe('OpenBaoSecretsProvider — errors and redaction', () => {
    test('HTTP error raises SecretsError with status and the token redacted', async () => {
        mockFetch((call) => ({
            status: 403,
            body: { errors: [`permission denied for token ${call.headers['X-Vault-Token']}`] },
        }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://bao.test', mountPath: 'secret/data', token: 'hvs.SUPERSECRET', namespace: 'qa' });
        const error = await catchError(() => provider.getSecret('db-password'));

        expect(error.providerName).toBe('openbao');
        expect(error.operation).toBe('fetch');
        expect(error.secretKey).toBe('db-password');
        expect(error.message).toContain('403');
        expect(error.message).toContain('[REDACTED]');
        expect(error.message).toContain('namespace="qa"');
        expect(error.message).not.toContain('hvs.SUPERSECRET');
        expect(JSON.stringify(error.details)).not.toContain('hvs.SUPERSECRET');
    });

    test('login failure redacts secret_id and JWT echoed by the server', async () => {
        mockFetch((call) => ({ status: 400, body: { errors: [`invalid secret_id ${(call.body as Record<string, string>).secret_id}`] } }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', roleId: 'rid', secretId: 'very-secret-id' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).toContain('approle login failed');
        expect(error.message).toContain('400');
        expect(error.message).not.toContain('very-secret-id');

        mockFetch((call) => ({ status: 400, body: `bad jwt ${(call.body as Record<string, string>).jwt}` }));
        const jwtProvider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', jwt: 'eyJ.secret.jwt', role: 'r' });
        const jwtError = await catchError(() => jwtProvider.getSecret('k'));
        expect(jwtError.message).not.toContain('eyJ.secret.jwt');
    });

    test('a token obtained by login is redacted from later errors', async () => {
        mockFetch((call) =>
            call.url.includes('/auth/')
                ? { body: { auth: { client_token: 'issued-token-xyz' } } }
                : { status: 403, body: `token issued-token-xyz lacks policy` }
        );
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', roleId: 'r', secretId: 's' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).not.toContain('issued-token-xyz');
    });

    test('network failure raises SecretsError with the cause attached', async () => {
        globalThis.fetch = (async () => {
            throw new TypeError('fetch failed');
        }) as typeof fetch;
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', token: 't' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.message).toContain('fetch failed');
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    test('long error bodies are truncated', async () => {
        mockFetch(() => ({ status: 500, body: 'x'.repeat(5000) }));
        const provider = new OpenBaoSecretsProvider({ url: 'https://b', mountPath: 'm', token: 't' });
        expect((await catchError(() => provider.getSecret('k'))).message.length).toBeLessThan(1000);
    });
});

test.describe('OpenBaoSecretsProvider — TLS', () => {
    let dir: string;
    let server: Server;
    let baseUrl: string;
    let seen: Array<{ url?: string; token?: string | string[] }>;

    test.beforeAll(() => {
        try {
            execFileSync('openssl', ['version'], { stdio: 'ignore' });
        } catch {
            test.skip(true, 'openssl is not installed');
        }
    });

    test.beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'bao-tls-'));
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
            '-subj', '/CN=bao.local', '-addext', 'subjectAltName=DNS:bao.local',
        ], { stdio: 'ignore' });
        seen = [];
        server = createServer(
            { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
            (req, res) => {
                seen.push({ url: req.url, token: req.headers['x-vault-token'] });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ data: { data: { value: 'over-tls' } } }));
            }
        );
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    test.afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    });

    test('trusts a custom CA bundle with an SNI server name', async () => {
        const provider = new OpenBaoSecretsProvider({
            url: baseUrl, mountPath: 'secret/data', token: 'tls-token',
            caCert: join(dir, 'cert.pem'), tlsServerName: 'bao.local',
        });
        expect(await provider.getSecret('k')).toBe('over-tls');
        expect(seen).toEqual([{ url: '/v1/secret/data/k', token: 'tls-token' }]);
    });

    test('reads CAs from BAO_CAPATH', async () => {
        process.env.BAO_CAPATH = dir;
        process.env.BAO_TLS_SERVER_NAME = 'bao.local';
        const provider = new OpenBaoSecretsProvider({ url: baseUrl, mountPath: 'secret/data', token: 't' });
        expect(await provider.getSecret('k')).toBe('over-tls');
    });

    test('rejects an untrusted certificate with SecretsError', async () => {
        const provider = new OpenBaoSecretsProvider({ url: baseUrl, mountPath: 'secret/data', token: 't', tlsServerName: 'bao.local' });
        const error = await catchError(() => provider.getSecret('k'));
        expect(error.operation).toBe('fetch');
    });

    test('BAO_SKIP_VERIFY disables verification', async () => {
        process.env.BAO_SKIP_VERIFY = 'true';
        const provider = new OpenBaoSecretsProvider({ url: baseUrl, mountPath: 'secret/data', token: 't' });
        expect(await provider.getSecret('k')).toBe('over-tls');
    });

    test('missing CA file and half-configured mTLS raise SecretsError', async () => {
        const missing = await catchError(() => new OpenBaoSecretsProvider({ url: baseUrl, mountPath: 'm', caCert: join(dir, 'nope.pem') }));
        expect(missing.operation).toBe('resolve');
        expect(missing.message).toContain('ENOENT');

        const half = await catchError(() => new OpenBaoSecretsProvider({ url: baseUrl, mountPath: 'm', clientCert: join(dir, 'cert.pem') }));
        expect(half.message).toContain('clientCert and clientKey');
    });
});
