/**
 * gRPC fixture.
 *
 * `grpcClient` calls gRPC services the way `openApiClient` calls REST ones:
 *
 * - Services come from `.proto` files, or from the server itself through
 *   server reflection (v1, falling back to v1alpha) for anything the proto
 *   files don't cover. With reflection, a test needs no proto files at all.
 * - `call()` for unary methods, `serverStream()` (messages collected into an
 *   array), `clientStream()` and `bidiStream()`. Methods are named
 *   `package.Service/Method`.
 * - Metadata per call or on every call, a deadline on every call, TLS and
 *   bearer tokens from config, the secrets providers or the auth helpers.
 * - A failed call throws GrpcError with the status code (`code`, `codeName`),
 *   the server's message and its trailers. `invoke()` returns the status
 *   instead of throwing, for tests that expect a failure.
 *
 * The driver (@grpc/grpc-js and @grpc/proto-loader) is loaded on first use.
 */

import { readFileSync } from 'node:fs';
import type * as GrpcJs from '@grpc/grpc-js';
import type * as ProtoLoader from '@grpc/proto-loader';
import type { AuthConfig, GrpcFixtureConfig, GrpcTlsConfig } from '../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { authApplies, bearerSource } from '../auth/apply.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import { loadOptional } from './optional-package.js';

export const DEFAULT_GRPC_TIMEOUT = 10_000;

/** proto-loader options: field names as in the .proto, 64-bit ints and enums as strings, defaults filled in. */
export const DEFAULT_LOADER_OPTIONS = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;

/** gRPC status codes by number. */
export const GRPC_STATUS_NAMES = [
    'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
    'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
] as const;

export type GrpcStatusName = (typeof GRPC_STATUS_NAMES)[number];

// ─── Types ──────────────────────────────────────────────────────────────────

/** Metadata values: strings, or Buffers for `-bin` keys. An array sends the key several times. */
export type GrpcMetadataInput = Record<string, string | Buffer | Array<string | Buffer>>;

export interface GrpcCallOptions {
    /** Metadata for this call, on top of the client's. */
    metadata?: GrpcMetadataInput;
    /** Deadline in ms (default: the config's `timeout`, 10000). `0` for none. */
    timeout?: number;
}

export interface GrpcServerStreamOptions extends GrpcCallOptions {
    /** Stop after this many messages: the call is cancelled and the messages so far are returned. */
    limit?: number;
}

/** Status of a finished call, with the response when it succeeded. */
export interface GrpcResult<T = unknown> {
    ok: boolean;
    /** Numeric status code (0 = OK). */
    code: number;
    /** Status name, e.g. `NOT_FOUND`. */
    codeName: GrpcStatusName;
    /** The server's status message. */
    details: string;
    /** The response message (unary and client-streaming calls, when `ok`). */
    response?: T;
    /** Messages received (streaming responses), including those before a failure. */
    messages?: T[];
    /** Response headers. Repeated keys are joined with `, `; binary values are base64. */
    metadata: Record<string, string>;
    /** Trailers sent with the status. */
    trailers: Record<string, string>;
}

/** A method as the client sees it. */
export interface GrpcMethodInfo {
    /** `package.Service/Method` */
    path: string;
    name: string;
    requestType: string;
    responseType: string;
    requestStream: boolean;
    responseStream: boolean;
    /** `unary`, `serverStream`, `clientStream` or `bidiStream`: the client function to use. */
    kind: 'unary' | 'serverStream' | 'clientStream' | 'bidiStream';
}

export interface GrpcClient {
    /** Calls a unary method and returns the response. Throws GrpcError when the status isn't OK. */
    call<TRes = any, TReq = Record<string, unknown>>(method: string, request?: TReq, options?: GrpcCallOptions): Promise<TRes>;
    /** Calls any method and returns its status, response and metadata. Never throws for a non-OK status. */
    invoke<TRes = any, TReq = Record<string, unknown>>(method: string, request?: TReq | TReq[], options?: GrpcServerStreamOptions): Promise<GrpcResult<TRes>>;
    /** Calls a server-streaming method and returns every message once the stream ends. */
    serverStream<TRes = any, TReq = Record<string, unknown>>(method: string, request?: TReq, options?: GrpcServerStreamOptions): Promise<TRes[]>;
    /** Sends `requests` on a client-streaming method and returns the single response. */
    clientStream<TRes = any, TReq = Record<string, unknown>>(method: string, requests: TReq[], options?: GrpcCallOptions): Promise<TRes>;
    /** Sends `requests` on a bidirectional method, closes the sending side and returns every response. */
    bidiStream<TRes = any, TReq = Record<string, unknown>>(method: string, requests: TReq[], options?: GrpcCallOptions): Promise<TRes[]>;
    /** Every service the proto files and the server's reflection know, sorted. */
    services(): Promise<string[]>;
    /** The methods of `service` (`package.Service`). */
    methods(service: string): Promise<GrpcMethodInfo[]>;
    /** Loads more `.proto` files into this client (on top of the config's). */
    loadProtos(files: string | string[], options?: { includeDirs?: string[] }): Promise<void>;
    /** Metadata sent on every later call of this client. */
    setMetadata(key: string, value: string | Buffer): void;
    /** Sets `authorization: Bearer <token>` on every later call. */
    setAuthToken(token: string): void;
    /** The server address. */
    readonly address: string;
    /** Closes the channel. Called after every test. */
    close(): void;
}

/**
 * A call that ended with a non-OK status. `code`/`codeName` are the gRPC
 * status, `statusDetails` the server's message, `trailers` its trailing metadata.
 */
export class GrpcError extends FixtureOperationError {
    /** Status name, e.g. `NOT_FOUND`. */
    public readonly codeName: GrpcStatusName;

    constructor(
        operation: 'call' | 'serverStream' | 'clientStream' | 'bidiStream',
        public readonly method: string,
        public readonly code: number,
        /** The server's status message. */
        public readonly statusDetails: string,
        public readonly trailers: Record<string, string>,
        /** Messages received before the failure (streaming calls). */
        public readonly messages: unknown[] = [],
    ) {
        const codeName = statusName(code);
        super('grpc', operation, { method, code, codeName, details: statusDetails });
        this.codeName = codeName;
        const shown = Object.fromEntries(Object.entries(trailers).filter(([k]) => !TRANSPORT_HEADERS.has(k)));
        const extra = Object.keys(shown).length ? ` (trailers: ${JSON.stringify(shown)})` : '';
        const received = messages.length ? ` after ${messages.length} message(s)` : '';
        this.message = `gRPC ${method} failed${received}: ${code} ${codeName}${statusDetails ? `: ${statusDetails}` : ''}${extra}`;
        this.name = 'GrpcError';
    }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** HTTP/2 headers a trailers-only response repeats; left out of error messages (still in `trailers`). */
const TRANSPORT_HEADERS = new Set(['content-type', 'date', 'server', 'grpc-accept-encoding', 'grpc-encoding', 'accept-encoding']);

export function statusName(code: number): GrpcStatusName {
    return GRPC_STATUS_NAMES[code] ?? 'UNKNOWN';
}

/** `host:port`, plus TLS when the address says `grpcs://` (or `https://`). */
export function parseAddress(address: string): { target: string; tls?: boolean } {
    const m = /^(grpcs?|https?):\/\/([^/]+)\/?$/i.exec(address.trim());
    if (!m) return { target: address.trim() };
    const secure = /^(grpcs|https)$/i.test(m[1]);
    return { target: m[2], tls: secure };
}

/** `pkg.Svc/Method`, `/pkg.Svc/Method` or `pkg.Svc.Method` → `{ service, method }`. */
export function parseMethod(name: string): { service: string; method: string } {
    const trimmed = name.trim().replace(/^\//, '');
    const slash = trimmed.lastIndexOf('/');
    const cut = slash >= 0 ? slash : trimmed.lastIndexOf('.');
    if (cut <= 0 || cut === trimmed.length - 1) {
        throw new Error(`"${name}" isn't a method name: use package.Service/Method`);
    }
    return { service: trimmed.slice(0, cut), method: trimmed.slice(cut + 1) };
}

/** A PEM value: the text itself, or the file it points to. */
export function readPem(value: string): Buffer {
    return Buffer.from(value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8'));
}

/** grpc-js Metadata → plain object; repeated keys joined, binary values base64. */
export function metadataToObject(md: { toJSON(): Record<string, Array<string | Buffer>> } | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!md) return out;
    for (const [key, values] of Object.entries(md.toJSON())) {
        out[key] = values.map((v) => (Buffer.isBuffer(v) ? v.toString('base64') : v)).join(', ');
    }
    return out;
}

function kindOf(requestStream: boolean, responseStream: boolean): GrpcMethodInfo['kind'] {
    if (requestStream) return responseStream ? 'bidiStream' : 'clientStream';
    return responseStream ? 'serverStream' : 'unary';
}

// Minimal protobuf wire format, enough for reflection's FileDescriptorProto bytes.

function readVarint(buf: Uint8Array, pos: number): [number, number] {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
        if (pos >= buf.length) throw new Error('truncated varint');
        byte = buf[pos++];
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return [result, pos];
}

function writeVarint(n: number): Buffer {
    const bytes: number[] = [];
    while (n > 0x7f) {
        bytes.push((n % 128) | 0x80);
        n = Math.floor(n / 128);
    }
    bytes.push(n);
    return Buffer.from(bytes);
}

/** Name (field 1) and imports (field 3) of a serialized FileDescriptorProto. */
export function descriptorNameAndDeps(bytes: Uint8Array): { name: string; dependencies: string[] } {
    let pos = 0;
    let name = '';
    const dependencies: string[] = [];
    while (pos < bytes.length) {
        let key: number;
        [key, pos] = readVarint(bytes, pos);
        const field = Math.floor(key / 8);
        const wire = key & 7;
        if (wire === 0) [, pos] = readVarint(bytes, pos);
        else if (wire === 1) pos += 8;
        else if (wire === 5) pos += 4;
        else if (wire === 2) {
            let len: number;
            [len, pos] = readVarint(bytes, pos);
            const text = () => Buffer.from(bytes.subarray(pos, pos + len)).toString('utf8');
            if (field === 1) name = text();
            else if (field === 3) dependencies.push(text());
            pos += len;
        } else throw new Error(`unsupported wire type ${wire}`);
    }
    return { name, dependencies };
}

/** Serialized FileDescriptorSet: field 1, repeated, one entry per file. */
export function fileDescriptorSet(files: Uint8Array[]): Buffer {
    return Buffer.concat(files.flatMap((f) => [Buffer.from([0x0a]), writeVarint(f.length), Buffer.from(f)]));
}

/** The reflection service (v1 and v1alpha share their messages), for proto-loader's fromJSON. */
function reflectionJson(version: 'v1' | 'v1alpha') {
    return {
        nested: { grpc: { nested: { reflection: { nested: { [version]: { nested: {
            ServerReflection: { methods: { ServerReflectionInfo: { requestType: 'ServerReflectionRequest', requestStream: true, responseType: 'ServerReflectionResponse', responseStream: true } } },
            ServerReflectionRequest: {
                oneofs: { messageRequest: { oneof: ['fileByFilename', 'fileContainingSymbol', 'listServices'] } },
                fields: { host: { type: 'string', id: 1 }, fileByFilename: { type: 'string', id: 3 }, fileContainingSymbol: { type: 'string', id: 4 }, listServices: { type: 'string', id: 7 } },
            },
            ServerReflectionResponse: {
                fields: {
                    validHost: { type: 'string', id: 1 },
                    originalRequest: { type: 'ServerReflectionRequest', id: 2 },
                    fileDescriptorResponse: { type: 'FileDescriptorResponse', id: 4 },
                    listServicesResponse: { type: 'ListServiceResponse', id: 6 },
                    errorResponse: { type: 'ErrorResponse', id: 7 },
                },
            },
            FileDescriptorResponse: { fields: { fileDescriptorProto: { rule: 'repeated', type: 'bytes', id: 1 } } },
            ListServiceResponse: { fields: { service: { rule: 'repeated', type: 'ServiceResponse', id: 1 } } },
            ServiceResponse: { fields: { name: { type: 'string', id: 1 } } },
            ErrorResponse: { fields: { errorCode: { type: 'int32', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
        } } } } } } },
    };
}

interface ReflectionResponse {
    originalRequest?: { fileByFilename?: string; fileContainingSymbol?: string; listServices?: string };
    fileDescriptorResponse?: { fileDescriptorProto: Buffer[] };
    listServicesResponse?: { service: { name: string }[] };
    errorResponse?: { errorCode: number; errorMessage: string };
}

// ─── Client ─────────────────────────────────────────────────────────────────

type Grpc = typeof GrpcJs;
type Loader = typeof ProtoLoader;
type MethodDef = ProtoLoader.MethodDefinition<object, object>;
type ServiceDef = Record<string, MethodDef>;

/** Proto files parsed once per process, by files + options. */
const protoCache = new Map<string, Promise<ProtoLoader.PackageDefinition>>();

async function loadDriver(): Promise<{ grpc: Grpc; loader: Loader }> {
    const install = ['@grpc/grpc-js', '@grpc/proto-loader'];
    const [grpc, loader] = await Promise.all([
        loadOptional<Partial<Grpc> & { default?: Grpc }>('@grpc/grpc-js', 'grpcClient', install),
        loadOptional<Partial<Loader> & { default?: Loader }>('@grpc/proto-loader', 'grpcClient', install),
    ]);
    // Both are CommonJS: the namespace may carry them under `default`.
    return { grpc: (grpc.credentials ? grpc : grpc.default) as Grpc, loader: (loader.loadSync ? loader : loader.default) as Loader };
}

/** The services in a package definition: entries that aren't message or enum types. */
function servicesOf(def: ProtoLoader.PackageDefinition): Map<string, ServiceDef> {
    const out = new Map<string, ServiceDef>();
    for (const [name, value] of Object.entries(def)) {
        if (!('format' in value)) out.set(name, value as unknown as ServiceDef);
    }
    return out;
}

function credentialsFor(grpc: Grpc, tls: boolean | GrpcTlsConfig | undefined): GrpcJs.ChannelCredentials {
    if (!tls) return grpc.credentials.createInsecure();
    const t: GrpcTlsConfig = tls === true ? {} : tls;
    const verify: GrpcJs.VerifyOptions = {};
    if (t.insecureSkipVerify) {
        verify.rejectUnauthorized = false;
        verify.checkServerIdentity = () => undefined;
    }
    return grpc.credentials.createSsl(
        t.ca ? readPem(t.ca) : null,
        t.key ? readPem(t.key) : null,
        t.cert ? readPem(t.cert) : null,
        verify,
    );
}

function toMetadata(grpc: Grpc, ...sources: Array<GrpcMetadataInput | undefined>): GrpcJs.Metadata {
    const md = new grpc.Metadata();
    for (const source of sources) {
        for (const [key, value] of Object.entries(source ?? {})) {
            const k = key.toLowerCase();
            md.remove(k); // a later source replaces the key
            for (const v of Array.isArray(value) ? value : [value]) {
                md.add(k, k.endsWith('-bin') && !Buffer.isBuffer(v) ? Buffer.from(v) : v);
            }
        }
    }
    return md;
}

/**
 * Creates a gRPC client outside the fixture (e.g. in a global setup).
 * Nothing connects until the first call. Call `close()` when done.
 */
export function createGrpcClient(config: GrpcFixtureConfig, deps: { bearer?: () => Promise<string> } = {}): GrpcClient {
    if (!config.address) {
        throw new FixtureInitError('grpc', 'connect', {
            reason: 'no gRPC address configured: set grpc.address in environments.json, PW_GRPC_ADDRESS, or the project use block',
        });
    }
    const { target, tls: addressTls } = parseAddress(config.address);
    const tls = config.tls ?? addressTls;
    const defaultTimeout = config.timeout ?? DEFAULT_GRPC_TIMEOUT;
    const loaderOptions = { ...DEFAULT_LOADER_OPTIONS, ...config.loaderOptions } as ProtoLoader.Options;
    const reflectionEnabled = config.reflection ?? true;
    const clientMetadata: GrpcMetadataInput = { ...config.metadata };
    if (config.authToken) clientMetadata.authorization = `Bearer ${config.authToken}`;

    let driver: Promise<{ grpc: Grpc; loader: Loader }> | undefined;
    let channel: GrpcJs.Client | undefined;
    const fromProtos = new Map<string, ServiceDef>();
    const protoLoads: Promise<void>[] = [];
    const fromReflection = new Map<string, Promise<ServiceDef>>();
    let reflectionVersion: 'v1' | 'v1alpha' | undefined;

    const getDriver = () => (driver ??= loadDriver());

    const getChannel = async () => {
        const { grpc } = await getDriver();
        if (!channel) {
            const options: Record<string, string | number> = { ...config.channelOptions };
            const serverName = typeof tls === 'object' ? tls.serverName : undefined;
            if (serverName) {
                options['grpc.ssl_target_name_override'] = serverName;
                options['grpc.default_authority'] = serverName;
            }
            channel = new grpc.Client(target, credentialsFor(grpc, tls), options);
        }
        return channel;
    };

    const loadProtoFiles = async (files: string[], includeDirs: string[] | undefined) => {
        const { loader } = await getDriver();
        const key = JSON.stringify([files, includeDirs, config.loaderOptions]);
        let pending = protoCache.get(key);
        if (!pending) {
            pending = loader.load(files, { ...loaderOptions, includeDirs });
            protoCache.set(key, pending);
            pending.catch(() => protoCache.delete(key));
        }
        let def: ProtoLoader.PackageDefinition;
        try {
            def = await pending;
        } catch (error) {
            throw new FixtureOperationError('grpc', 'loadProtos', { files, includeDirs, reason: (error as Error).message }, error as Error);
        }
        for (const [name, svc] of servicesOf(def)) fromProtos.set(name, svc);
    };

    if (config.protoFiles?.length) {
        const load = loadProtoFiles(config.protoFiles, config.includeDirs);
        load.catch(() => undefined); // reported on the first call, not as an unhandled rejection
        protoLoads.push(load);
    }

    /** One reflection stream: sends `first`, follows up with the imports it lacks, resolves with every response. */
    const reflect = async (first: Record<string, string>, version: 'v1' | 'v1alpha'): Promise<ReflectionResponse[]> => {
        const { grpc, loader } = await getDriver();
        const def = loader.fromJSON(reflectionJson(version) as Parameters<Loader['fromJSON']>[0], { keepCase: false });
        const service = (def[`grpc.reflection.${version}.ServerReflection`] as unknown as ServiceDef).ServerReflectionInfo;
        const ch = await getChannel();
        const deadline = defaultTimeout > 0 ? Date.now() + defaultTimeout : Infinity;
        return new Promise((resolve, reject) => {
            const stream = ch.makeBidiStreamRequest(service.path, service.requestSerialize, service.responseDeserialize, toMetadata(grpc, clientMetadata), { deadline });
            const responses: ReflectionResponse[] = [];
            const seen = new Set<string>();
            const requested = new Set<string>();
            let pending = 1;
            const send = (req: Record<string, string>) => {
                pending++;
                stream.write(req);
            };
            stream.on('data', (res: ReflectionResponse) => {
                responses.push(res);
                // A response often carries the file's imports too: note every file first, then ask for the rest.
                const files = (res.fileDescriptorResponse?.fileDescriptorProto ?? []).map(descriptorNameAndDeps);
                for (const { name } of files) seen.add(name);
                for (const { dependencies } of files) {
                    for (const dep of dependencies) {
                        if (!seen.has(dep) && !requested.has(dep)) {
                            requested.add(dep);
                            send({ fileByFilename: dep });
                        }
                    }
                }
                if (--pending === 0) stream.end();
            });
            stream.on('error', reject);
            stream.on('end', () => resolve(responses));
            stream.write(first);
        });
    };

    /** Runs a reflection request, on v1 first and on v1alpha when the server only has that. */
    const reflectAny = async (first: Record<string, string>): Promise<ReflectionResponse[]> => {
        if (reflectionVersion) return reflect(first, reflectionVersion);
        try {
            const res = await reflect(first, 'v1');
            reflectionVersion = 'v1';
            return res;
        } catch (error) {
            if ((error as { code?: number }).code !== 12) throw error;
            const res = await reflect(first, 'v1alpha');
            reflectionVersion = 'v1alpha';
            return res;
        }
    };

    const reflectService = (name: string): Promise<ServiceDef> => {
        let pending = fromReflection.get(name);
        if (!pending) {
            pending = (async () => {
                const responses = await reflectAny({ fileContainingSymbol: name });
                const failed = responses.find((r) => r.errorResponse && r.originalRequest?.fileContainingSymbol);
                if (failed) throw new Error(`the server doesn't know ${name} (${failed.errorResponse!.errorMessage || `code ${failed.errorResponse!.errorCode}`})`);
                const files = new Map<string, Buffer>();
                for (const r of responses) {
                    for (const bytes of r.fileDescriptorResponse?.fileDescriptorProto ?? []) files.set(descriptorNameAndDeps(bytes).name, bytes);
                }
                const { loader } = await getDriver();
                const def = loader.loadFileDescriptorSetFromBuffer(fileDescriptorSet([...files.values()]), loaderOptions);
                const svc = servicesOf(def).get(name);
                if (!svc) throw new Error(`the server's descriptors for ${name} don't define it as a service`);
                return svc;
            })();
            fromReflection.set(name, pending);
            pending.catch(() => fromReflection.delete(name));
        }
        return pending;
    };

    const reflectionServices = async (): Promise<string[]> => {
        const responses = await reflectAny({ listServices: '' });
        return responses.flatMap((r) => r.listServicesResponse?.service.map((s) => s.name) ?? []);
    };

    const reflectionError = (error: unknown): FixtureOperationError =>
        new FixtureOperationError('grpc', 'reflection', { address: target, reason: reasonOf(error) }, error instanceof Error ? error : undefined);

    /** The service, from the proto files or else from reflection. */
    const findService = async (service: string): Promise<ServiceDef> => {
        await Promise.all(protoLoads);
        const local = fromProtos.get(service);
        if (local) return local;
        const known = [...fromProtos.keys()].sort();
        if (!reflectionEnabled) {
            throw new FixtureOperationError('grpc', 'call', {
                service,
                reason: `no proto file defines ${service} and reflection is off; services: ${known.join(', ') || 'none (set grpc.protoFiles)'}`,
            });
        }
        try {
            return await reflectService(service);
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code === 'number') {
                // The reflection call itself failed: the server is unreachable or has no reflection.
                const reason = code === 12
                    ? `the server doesn't offer server reflection, so ${service} can't be looked up: list its .proto files in grpc.protoFiles`
                    : code === 14
                        ? `can't reach ${target}: ${reasonOf(error)}${tls || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(reasonOf(error)) ? '' : '. If the server uses TLS, use a grpcs:// address or set grpc.tls'}`
                        : `looking up ${service} through server reflection failed: ${reasonOf(error)}`;
                throw new FixtureOperationError('grpc', 'reflection', { service, address: target, reason }, error as Error);
            }
            let names: string[] = known;
            try {
                names = [...new Set([...known, ...(await reflectionServices())])].sort();
            } catch {
                // keep the proto services only
            }
            throw new FixtureOperationError('grpc', 'reflection', {
                service,
                address: target,
                reason: `${reasonOf(error)}; known services: ${names.join(', ') || 'none'}`,
            }, error instanceof Error ? error : undefined);
        }
    };

    const findMethod = async (name: string, expected?: GrpcMethodInfo['kind']): Promise<{ def: MethodDef; info: GrpcMethodInfo }> => {
        const { service, method } = parseMethod(name);
        const svc = await findService(service);
        const def = svc[method] ?? Object.values(svc).find((m) => m.originalName === method || m.path.endsWith(`/${method}`));
        if (!def) {
            const available = Object.values(svc).map((m) => m.path.split('/').pop()).join(', ');
            throw new FixtureOperationError('grpc', 'call', { method: name, reason: `${service} has no method ${method}; it has ${available}` });
        }
        const info = methodInfo(def);
        if (expected && info.kind !== expected) {
            throw new FixtureOperationError('grpc', 'call', {
                method: name,
                reason: `${info.path} is a ${describeKind(info.kind)} method: use grpcClient.${info.kind === 'unary' ? 'call' : info.kind}()`,
            });
        }
        return { def, info };
    };

    const callOptions = (o: GrpcCallOptions | undefined): GrpcJs.CallOptions => {
        const timeout = o?.timeout ?? defaultTimeout;
        return timeout > 0 ? { deadline: Date.now() + timeout } : {};
    };

    const callMetadata = async (o: GrpcCallOptions | undefined): Promise<GrpcJs.Metadata> => {
        const { grpc } = await getDriver();
        const md = toMetadata(grpc, clientMetadata, o?.metadata);
        if (deps.bearer && md.get('authorization').length === 0) md.set('authorization', `Bearer ${await deps.bearer()}`);
        return md;
    };

    /** Runs the call; resolves once the status arrives. */
    const run = async <T>(name: string, request: unknown, o: GrpcServerStreamOptions | undefined, expected?: GrpcMethodInfo['kind']): Promise<GrpcResult<T>> => {
        const { def, info } = await findMethod(name, expected);
        const ch = await getChannel();
        const metadata = await callMetadata(o);
        const options = callOptions(o);
        const path = def.path;
        const ser = def.requestSerialize as (v: unknown) => Buffer;
        const de = def.responseDeserialize as (b: Buffer) => T;
        const requests = Array.isArray(request) ? request : [request ?? {}];

        return new Promise((resolve) => {
            let headers: Record<string, string> = {};
            let response: T | undefined;
            const messages: T[] = [];
            let cancelledByLimit = false;
            const finish = (status: GrpcJs.StatusObject) => {
                const code = cancelledByLimit && status.code === 1 ? 0 : status.code;
                resolve({
                    ok: code === 0,
                    code,
                    codeName: statusName(code),
                    details: code === 0 && cancelledByLimit ? '' : cleanDetails(status.details),
                    ...(info.responseStream ? { messages } : { response: code === 0 ? response : undefined }),
                    metadata: headers,
                    trailers: metadataToObject(status.metadata),
                });
            };
            const onMetadata = (md: GrpcJs.Metadata) => {
                headers = metadataToObject(md);
            };
            const ignore = () => {
                // the status event carries the failure
            };

            if (info.kind === 'unary' || info.kind === 'clientStream') {
                const callback = (_err: unknown, value?: T) => {
                    response = value;
                };
                const call = info.kind === 'unary'
                    ? ch.makeUnaryRequest(path, ser, de, requests[0], metadata, options, callback)
                    : ch.makeClientStreamRequest(path, ser, de, metadata, options, callback);
                call.on('metadata', onMetadata);
                call.on('status', finish);
                if (info.kind === 'clientStream') {
                    const writable = call as GrpcJs.ClientWritableStream<unknown>;
                    for (const r of requests) writable.write(r);
                    writable.end();
                }
                return;
            }

            const stream = info.kind === 'serverStream'
                ? ch.makeServerStreamRequest(path, ser, de, requests[0], metadata, options)
                : ch.makeBidiStreamRequest(path, ser, de, metadata, options);
            stream.on('metadata', onMetadata);
            stream.on('status', finish);
            stream.on('error', ignore);
            stream.on('data', (m: T) => {
                if (o?.limit !== undefined && messages.length >= o.limit) return;
                messages.push(m);
                if (o?.limit !== undefined && messages.length >= o.limit) {
                    cancelledByLimit = true;
                    stream.cancel();
                }
            });
            if (info.kind === 'bidiStream') {
                const duplex = stream as GrpcJs.ClientDuplexStream<unknown, T>;
                for (const r of requests) duplex.write(r);
                duplex.end();
            }
        });
    };

    const throwIfFailed = <T>(operation: 'call' | 'serverStream' | 'clientStream' | 'bidiStream', name: string, result: GrpcResult<T>) => {
        if (!result.ok) throw new GrpcError(operation, name, result.code, result.details, result.trailers, result.messages ?? []);
        return result;
    };

    return {
        address: target,

        async call<TRes>(method: string, request?: unknown, o?: GrpcCallOptions) {
            return throwIfFailed('call', method, await run<TRes>(method, request, o, 'unary')).response as TRes;
        },

        async invoke<TRes>(method: string, request?: unknown, o?: GrpcServerStreamOptions) {
            return run<TRes>(method, request, o);
        },

        async serverStream<TRes>(method: string, request?: unknown, o?: GrpcServerStreamOptions) {
            return throwIfFailed('serverStream', method, await run<TRes>(method, request, o, 'serverStream')).messages!;
        },

        async clientStream<TRes>(method: string, requests: unknown[], o?: GrpcCallOptions) {
            return throwIfFailed('clientStream', method, await run<TRes>(method, requests, o, 'clientStream')).response as TRes;
        },

        async bidiStream<TRes>(method: string, requests: unknown[], o?: GrpcCallOptions) {
            return throwIfFailed('bidiStream', method, await run<TRes>(method, requests, o, 'bidiStream')).messages!;
        },

        async services() {
            await Promise.all(protoLoads);
            const names = new Set(fromProtos.keys());
            if (reflectionEnabled) {
                try {
                    for (const n of await reflectionServices()) names.add(n);
                } catch (error) {
                    if (names.size === 0) throw reflectionError(error);
                }
            }
            return [...names].sort();
        },

        async methods(service) {
            return Object.values(await findService(service)).map(methodInfo);
        },

        async loadProtos(files, o) {
            const load = loadProtoFiles(Array.isArray(files) ? files : [files], o?.includeDirs ?? config.includeDirs);
            protoLoads.push(load.catch(() => undefined));
            await load;
        },

        setMetadata(key, value) {
            clientMetadata[key.toLowerCase()] = value;
        },

        setAuthToken(token) {
            clientMetadata.authorization = `Bearer ${token}`;
        },

        close() {
            channel?.close();
            channel = undefined;
        },
    };
}

function methodInfo(def: MethodDef): GrpcMethodInfo {
    const typeName = (t: { type?: { name?: string } } | undefined) => t?.type?.name ?? '?';
    const path = def.path.replace(/^\//, '');
    return {
        path,
        name: path.split('/').pop()!,
        requestType: typeName(def.requestType as never),
        responseType: typeName(def.responseType as never),
        requestStream: def.requestStream,
        responseStream: def.responseStream,
        kind: kindOf(def.requestStream, def.responseStream),
    };
}

function describeKind(kind: GrpcMethodInfo['kind']): string {
    return { unary: 'unary', serverStream: 'server-streaming', clientStream: 'client-streaming', bidiStream: 'bidirectional-streaming' }[kind];
}

function reasonOf(error: unknown): string {
    const e = error as { code?: number; details?: string; message?: string };
    if (typeof e?.code === 'number' && e.details !== undefined) return `${e.code} ${statusName(e.code)}: ${cleanDetails(e.details)}`;
    return e?.message ?? String(error);
}

/** grpc-js status text without its empty "Resolution note:" suffix. */
function cleanDetails(details: string): string {
    return details.replace(/\.?\s*Resolution note:\s*$/, '');
}

/** The gRPC config: the project option, else ConfigLoader (environments.json, .env, PW_GRPC_*). */
export async function resolveGrpcConfig(grpc: GrpcFixtureConfig | undefined): Promise<GrpcFixtureConfig> {
    if (grpc) return grpc;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().grpc ?? {};
    } catch {
        return {};
    }
}

/** Fixture definition for test.extend(). The channel is closed after the test. */
export const grpcFixture = {
    grpcClient: async (
        { grpc, authConfig, authRole, authTokens }: { grpc: GrpcFixtureConfig | undefined; authConfig: AuthConfig | undefined; authRole: string | undefined; authTokens: TokenManager },
        use: (client: GrpcClient) => Promise<void>,
    ) => {
        const config = await resolveGrpcConfig(grpc);
        // An explicit grpc.authToken wins over the auth helpers' token.
        const bearer = !config.authToken && authApplies(authConfig, 'grpc') ? bearerSource(authTokens, authConfig, authRole) : undefined;
        const client = createGrpcClient(config, { bearer });
        try {
            await use(client);
        } finally {
            client.close();
        }
    },
};
