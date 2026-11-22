/**
 * Unit tests for the gRPC fixture: address and method names, metadata, the
 * descriptor wire format, PW_GRPC_* variables, and calls against an
 * in-process grpc-js server (proto files, server reflection, every call
 * kind, status errors, deadlines, metadata and bearer tokens). A real
 * server (grpcbin) is covered by tests/examples/grpc.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import {
    GrpcError,
    createGrpcClient,
    descriptorNameAndDeps,
    fileDescriptorSet,
    metadataToObject,
    parseAddress,
    parseMethod,
    readPem,
    statusName,
} from '../../src/fixtures/grpc.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { FixtureInitError, FixtureOperationError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _grpc = AssertHasKey<FixtureTypes, 'grpcClient'>;

test.describe('grpc — names and helpers', () => {
    test('addresses: host:port, or a scheme that says whether to use TLS', () => {
        expect(parseAddress('localhost:50051')).toEqual({ target: 'localhost:50051' });
        expect(parseAddress('grpcs://api.example.com:443')).toEqual({ target: 'api.example.com:443', tls: true });
        expect(parseAddress('grpc://localhost:9000/')).toEqual({ target: 'localhost:9000', tls: false });
        expect(parseAddress('https://h:1')).toEqual({ target: 'h:1', tls: true });
        expect(parseAddress('dns:///svc.internal:50051')).toEqual({ target: 'dns:///svc.internal:50051' });
    });

    test('method names: Service/Method, a leading slash, or dots only', () => {
        expect(parseMethod('shop.v1.Shop/GetItem')).toEqual({ service: 'shop.v1.Shop', method: 'GetItem' });
        expect(parseMethod('/shop.v1.Shop/GetItem')).toEqual({ service: 'shop.v1.Shop', method: 'GetItem' });
        expect(parseMethod('shop.v1.Shop.GetItem')).toEqual({ service: 'shop.v1.Shop', method: 'GetItem' });
        expect(() => parseMethod('GetItem')).toThrow(/use package\.Service\/Method/);
        expect(() => parseMethod('shop.Shop/')).toThrow(/isn't a method name/);
    });

    test('status names by code', () => {
        expect(statusName(0)).toBe('OK');
        expect(statusName(5)).toBe('NOT_FOUND');
        expect(statusName(16)).toBe('UNAUTHENTICATED');
        expect(statusName(99)).toBe('UNKNOWN');
    });

    test('PEM values are the text itself or a file', () => {
        const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
        expect(readPem(pem).toString()).toBe(pem);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-grpc-')), 'ca.pem');
        fs.writeFileSync(file, pem);
        expect(readPem(file).toString()).toBe(pem);
    });

    test('metadata becomes a plain object: repeated keys joined, binary as base64', () => {
        const md = new grpc.Metadata();
        md.add('x-a', '1');
        md.add('x-a', '2');
        md.add('trace-bin', Buffer.from('hi'));
        expect(metadataToObject(md)).toEqual({ 'x-a': '1, 2', 'trace-bin': Buffer.from('hi').toString('base64') });
        expect(metadataToObject(undefined)).toEqual({});
    });

    test('descriptor bytes: name and imports read back from a FileDescriptorProto', () => {
        // name = "a/b.proto" (field 1), package = "x" (field 2), dependencies (field 3), syntax (field 12)
        const str = (field: number, s: string) => Buffer.concat([Buffer.from([(field << 3) | 2, s.length]), Buffer.from(s)]);
        const bytes = Buffer.concat([str(1, 'a/b.proto'), str(2, 'x'), str(3, 'c.proto'), str(3, 'google/protobuf/empty.proto'), str(12, 'proto3')]);
        expect(descriptorNameAndDeps(bytes)).toEqual({ name: 'a/b.proto', dependencies: ['c.proto', 'google/protobuf/empty.proto'] });
        const set = fileDescriptorSet([bytes, Buffer.from([0x0a, 0x01, 0x41])]);
        expect([...set.subarray(0, 2)]).toEqual([0x0a, bytes.length]);
        expect(set.length).toBe(2 + bytes.length + 2 + 3);
    });

    test('no address says what to set', () => {
        expect(() => createGrpcClient({})).toThrow(FixtureInitError);
        expect(() => createGrpcClient({})).toThrow(/PW_GRPC_ADDRESS/);
    });
});

// ─── An in-process server ───────────────────────────────────────────────────

const MONEY_PROTO = `syntax = "proto3";
package common;
message Money { string currency = 1; int64 cents = 2; }
`;

const SHOP_PROTO = `syntax = "proto3";
package shop.v1;
import "common/money.proto";

service Shop {
    rpc GetItem(GetItemRequest) returns (Item);
    rpc ListItems(ListItemsRequest) returns (stream Item);
    rpc AddItems(stream Item) returns (Summary);
    rpc Chat(stream ChatMessage) returns (stream ChatMessage);
    rpc Slow(GetItemRequest) returns (Item);
    rpc WhoAmI(GetItemRequest) returns (Caller);
}

enum Kind { KIND_UNSPECIFIED = 0; BOOK = 1; GAME = 2; }

message GetItemRequest { string id = 1; }
message ListItemsRequest { int32 count = 1; int32 fail_after = 2; }
message Item { string id = 1; string title = 2; Kind kind = 3; common.Money price = 4; int64 stock = 5; }
message Summary { int32 count = 1; int64 total_cents = 2; }
message ChatMessage { string text = 1; }
message Caller { string authorization = 1; string tenant = 2; string trace = 3; }
`;

interface Server {
    address: string;
    protoDir: string;
    shopProto: string;
    stop(): Promise<void>;
}

async function startServer(options: { reflection: boolean }): Promise<Server> {
    const protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-grpc-proto-'));
    fs.mkdirSync(path.join(protoDir, 'common'));
    fs.writeFileSync(path.join(protoDir, 'common', 'money.proto'), MONEY_PROTO);
    const shopProto = path.join(protoDir, 'shop.proto');
    fs.writeFileSync(shopProto, SHOP_PROTO);

    const def = protoLoader.loadSync(shopProto, { includeDirs: [protoDir], keepCase: true, longs: String, enums: String, defaults: true });
    const pkg = grpc.loadPackageDefinition(def) as any;
    const server = new grpc.Server();
    const items: Record<string, unknown> = { 'b-1': { id: 'b-1', title: 'Dune', kind: 'BOOK', price: { currency: 'EUR', cents: 1299 }, stock: '9007199254740993' } };

    server.addService(pkg.shop.v1.Shop.service, {
        GetItem(call: any, callback: any) {
            const item = items[call.request.id];
            if (item) return callback(null, item);
            const trailers = new grpc.Metadata();
            trailers.set('x-item-id', call.request.id);
            callback({ code: grpc.status.NOT_FOUND, details: `no item ${call.request.id}`, metadata: trailers });
        },
        ListItems(call: any) {
            const { count, fail_after } = call.request;
            for (let i = 1; i <= count; i++) {
                if (fail_after && i > fail_after) return call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'stock service down' });
                call.write({ id: `i-${i}`, title: `Item ${i}` });
            }
            call.end();
        },
        AddItems(call: any, callback: any) {
            let count = 0;
            let total = 0;
            call.on('data', (item: any) => {
                count++;
                total += Number(item.price?.cents ?? 0);
            });
            call.on('end', () => callback(null, { count, total_cents: String(total) }));
        },
        Chat(call: any) {
            call.on('data', (m: any) => call.write({ text: `echo: ${m.text}` }));
            call.on('end', () => call.end());
        },
        Slow(_call: any, callback: any) {
            setTimeout(() => callback(null, { id: 'late' }), 2000);
        },
        WhoAmI(call: any, callback: any) {
            const md = call.metadata as grpc.Metadata;
            const header = new grpc.Metadata();
            header.set('x-served-by', 'unit');
            call.sendMetadata(header);
            const trace = md.get('trace-bin')[0];
            callback(null, {
                authorization: String(md.get('authorization')[0] ?? ''),
                tenant: md.get('x-tenant').map(String).join(','),
                trace: Buffer.isBuffer(trace) ? trace.toString() : '',
            });
        },
    });
    if (options.reflection) new ReflectionService(def).addToServer(server);

    const port = await new Promise<number>((resolve, reject) =>
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    return {
        address: `127.0.0.1:${port}`,
        protoDir,
        shopProto,
        stop: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
    };
}

test.describe('grpc — calls', () => {
    test.describe.configure({ mode: 'serial' });
    let server: Server;
    let plain: Server;

    test.beforeAll(async () => {
        server = await startServer({ reflection: true });
        plain = await startServer({ reflection: false });
    });
    test.afterAll(async () => {
        await server?.stop();
        await plain?.stop();
    });

    const viaReflection = (extra = {}) => createGrpcClient({ address: server.address, ...extra });
    const viaProtos = (extra = {}) => createGrpcClient({ address: plain.address, protoFiles: [plain.shopProto], includeDirs: [plain.protoDir], reflection: false, ...extra });

    test('reflection alone: imports are followed, fields keep their names, int64 and enums are strings', async () => {
        const client = viaReflection();
        try {
            expect(await client.call('shop.v1.Shop/GetItem', { id: 'b-1' })).toEqual({
                id: 'b-1', title: 'Dune', kind: 'BOOK', price: { currency: 'EUR', cents: '1299' }, stock: '9007199254740993',
            });
            expect(await client.services()).toEqual(['shop.v1.Shop']);
            const methods = await client.methods('shop.v1.Shop');
            expect(methods.map((m) => `${m.name}:${m.kind}`)).toEqual([
                'GetItem:unary', 'ListItems:serverStream', 'AddItems:clientStream', 'Chat:bidiStream', 'Slow:unary', 'WhoAmI:unary',
            ]);
            expect(methods[0]).toMatchObject({ path: 'shop.v1.Shop/GetItem', requestType: 'GetItemRequest', responseType: 'Item' });
        } finally {
            client.close();
        }
    });

    test('proto files: the same calls with reflection off', async () => {
        const client = viaProtos();
        try {
            expect(await client.call('shop.v1.Shop.GetItem', { id: 'b-1' })).toMatchObject({ title: 'Dune' });
            expect(await client.services()).toEqual(['shop.v1.Shop']);
            await expect(client.call('other.Svc/X')).rejects.toThrow(/no proto file defines other\.Svc and reflection is off; services: shop\.v1\.Shop/);
        } finally {
            client.close();
        }
    });

    test('a server without reflection says to list proto files', async () => {
        const client = createGrpcClient({ address: plain.address });
        try {
            await expect(client.call('shop.v1.Shop/GetItem', { id: 'b-1' })).rejects.toThrow(/doesn't offer server reflection, so shop\.v1\.Shop can't be looked up: list its \.proto files in grpc\.protoFiles/);
            await client.loadProtos(plain.shopProto, { includeDirs: [plain.protoDir] });
            expect(await client.call('shop.v1.Shop/GetItem', { id: 'b-1' })).toMatchObject({ id: 'b-1' });
        } finally {
            client.close();
        }
    });

    test('a non-OK status: call() throws GrpcError, invoke() returns it', async () => {
        const client = viaReflection();
        try {
            const error = await client.call('shop.v1.Shop/GetItem', { id: 'nope' }).catch((e) => e);
            expect(error).toBeInstanceOf(GrpcError);
            expect(error).toBeInstanceOf(FixtureOperationError);
            expect(error).toMatchObject({ code: 5, codeName: 'NOT_FOUND', statusDetails: 'no item nope', method: 'shop.v1.Shop/GetItem' });
            expect(error.trailers['x-item-id']).toBe('nope');
            expect(error.message).toBe('gRPC shop.v1.Shop/GetItem failed: 5 NOT_FOUND: no item nope (trailers: {"x-item-id":"nope"})');

            const result = await client.invoke('shop.v1.Shop/GetItem', { id: 'nope' });
            expect(result).toMatchObject({ ok: false, code: 5, codeName: 'NOT_FOUND', details: 'no item nope', response: undefined });
            expect(result.trailers['x-item-id']).toBe('nope');
            expect(await client.invoke('shop.v1.Shop/GetItem', { id: 'b-1' })).toMatchObject({ ok: true, code: 0, codeName: 'OK', response: { id: 'b-1' } });
        } finally {
            client.close();
        }
    });

    test('server streaming: every message, a limit, and the messages before a failure', async () => {
        const client = viaReflection();
        try {
            const all = await client.serverStream<{ id: string }>('shop.v1.Shop/ListItems', { count: 5 });
            expect(all.map((m) => m.id)).toEqual(['i-1', 'i-2', 'i-3', 'i-4', 'i-5']);
            expect(await client.serverStream('shop.v1.Shop/ListItems', { count: 50 }, { limit: 3 })).toHaveLength(3);
            expect(await client.invoke('shop.v1.Shop/ListItems', { count: 50 }, { limit: 2 })).toMatchObject({ ok: true, codeName: 'OK', messages: [{ id: 'i-1' }, { id: 'i-2' }] });

            const error = await client.serverStream('shop.v1.Shop/ListItems', { count: 5, fail_after: 2 }).catch((e) => e);
            expect(error).toBeInstanceOf(GrpcError);
            expect(error.codeName).toBe('UNAVAILABLE');
            expect(error.messages).toHaveLength(2);
            expect(error.message).toMatch(/^gRPC shop\.v1\.Shop\/ListItems failed after 2 message\(s\): 14 UNAVAILABLE: stock service down/);
        } finally {
            client.close();
        }
    });

    test('client and bidirectional streaming', async () => {
        const client = viaProtos();
        try {
            const summary = await client.clientStream('shop.v1.Shop/AddItems', [
                { id: 'a', price: { currency: 'EUR', cents: 100 } },
                { id: 'b', price: { currency: 'EUR', cents: 250 } },
            ]);
            expect(summary).toEqual({ count: 2, total_cents: '350' });
            expect(await client.bidiStream('shop.v1.Shop/Chat', [{ text: 'hi' }, { text: 'bye' }])).toEqual([{ text: 'echo: hi' }, { text: 'echo: bye' }]);
        } finally {
            client.close();
        }
    });

    test('deadlines: the default timeout, a per-call one, and none', async () => {
        const client = viaReflection({ timeout: 300 });
        try {
            await expect(client.call('shop.v1.Shop/Slow', {})).rejects.toMatchObject({ codeName: 'DEADLINE_EXCEEDED' });
            await expect(client.call('shop.v1.Shop/Slow', {}, { timeout: 100 })).rejects.toThrow(/4 DEADLINE_EXCEEDED/);
            expect(await client.call('shop.v1.Shop/Slow', {}, { timeout: 0 })).toMatchObject({ id: 'late' });
        } finally {
            client.close();
        }
    });

    test('metadata: config, setMetadata, per call (which wins), binary keys, and response headers', async () => {
        const client = viaReflection({ metadata: { 'X-Tenant': 'from-config' }, authToken: 'config-token' });
        try {
            expect(await client.call('shop.v1.Shop/WhoAmI', {})).toEqual({ authorization: 'Bearer config-token', tenant: 'from-config', trace: '' });
            client.setMetadata('x-tenant', 'acme');
            client.setAuthToken('later-token');
            const result = await client.invoke('shop.v1.Shop/WhoAmI', {}, { metadata: { 'trace-bin': 'abc', 'x-tenant': ['t1', 't2'] } });
            // grpc-js sends repeated values as one header, joined with ", "
            expect(result.response).toEqual({ authorization: 'Bearer later-token', tenant: 't1, t2', trace: 'abc' });
            expect(result.metadata['x-served-by']).toBe('unit');
        } finally {
            client.close();
        }
    });

    test('a bearer source (the auth helpers) is used unless the call sets authorization', async () => {
        let fetched = 0;
        const client = createGrpcClient({ address: server.address }, { bearer: async () => `role-token-${++fetched}` });
        try {
            expect((await client.call('shop.v1.Shop/WhoAmI', {})).authorization).toBe('Bearer role-token-1');
            expect((await client.call('shop.v1.Shop/WhoAmI', {})).authorization).toBe('Bearer role-token-2');
            expect((await client.call('shop.v1.Shop/WhoAmI', {}, { metadata: { authorization: 'Bearer bad' } })).authorization).toBe('Bearer bad');
        } finally {
            client.close();
        }
    });

    test('readable errors: unknown method, unknown service, wrong call kind, unreachable server', async () => {
        const client = viaReflection();
        try {
            await expect(client.call('shop.v1.Shop/Nope')).rejects.toThrow(/shop\.v1\.Shop has no method Nope; it has GetItem, ListItems, AddItems, Chat, Slow, WhoAmI/);
            await expect(client.call('shop.v2.Shop/GetItem')).rejects.toThrow(/the server doesn't know shop\.v2\.Shop .*known services: .*shop\.v1\.Shop/);
            await expect(client.call('shop.v1.Shop/ListItems', { count: 1 })).rejects.toThrow(/is a server-streaming method: use grpcClient\.serverStream\(\)/);
            await expect(client.serverStream('shop.v1.Shop/GetItem', { id: 'b-1' })).rejects.toThrow(/is a unary method: use grpcClient\.call\(\)/);
        } finally {
            client.close();
        }
        const closed = await startServer({ reflection: true });
        const address = closed.address;
        await closed.stop();
        const dead = createGrpcClient({ address, timeout: 2000 });
        try {
            await expect(dead.call('shop.v1.Shop/GetItem')).rejects.toThrow(new RegExp(`can't reach ${address.replace(/\./g, '\\.')}: 14 UNAVAILABLE: .*ECONNREFUSED`));
        } finally {
            dead.close();
        }
    });

    test('a missing proto file fails the first call, naming the file', async () => {
        const client = createGrpcClient({ address: plain.address, protoFiles: ['no/such.proto'], reflection: false });
        try {
            await expect(client.call('shop.v1.Shop/GetItem')).rejects.toThrow(/loadProtos failed: files=\["no\/such\.proto"\].*ENOENT/);
        } finally {
            client.close();
        }
    });
});

test.describe('grpc — configuration', () => {
    let dir: string;
    const saved = { ...process.env };

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-grpc-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { grpc: { address: 'localhost:9000', protoFiles: ['a.proto'] } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_GRPC_* variables override environments.json', () => {
        Object.assign(process.env, {
            PW_GRPC_ADDRESS: 'grpcs://api.example.com:443',
            PW_GRPC_PROTO_FILES: 'protos/a.proto, protos/b.proto',
            PW_GRPC_INCLUDE_DIRS: 'protos,vendor',
            PW_GRPC_REFLECTION: 'false',
            PW_GRPC_AUTH_TOKEN: 'tok',
            PW_GRPC_TIMEOUT: '2500',
            PW_GRPC_TLS_CA: 'certs/ca.pem',
            PW_GRPC_TLS_SERVER_NAME: 'api.internal',
        });
        expect(new ConfigLoader(dir).load('local').grpc).toEqual({
            address: 'grpcs://api.example.com:443',
            protoFiles: ['protos/a.proto', 'protos/b.proto'],
            includeDirs: ['protos', 'vendor'],
            reflection: false,
            authToken: 'tok',
            timeout: 2500,
            tls: { ca: 'certs/ca.pem', serverName: 'api.internal' },
        });
    });

    test('PW_GRPC_TLS turns TLS on or off; the TLS file variables imply it', () => {
        process.env.PW_GRPC_TLS = 'true';
        expect(new ConfigLoader(dir).load('local').grpc?.tls).toBe(true);
        process.env.PW_GRPC_TLS_SKIP_VERIFY = 'true';
        expect(new ConfigLoader(dir).load('local').grpc?.tls).toEqual({ insecureSkipVerify: true });
    });

    test('environments.json alone is enough', () => {
        expect(new ConfigLoader(dir).load('local').grpc).toEqual({ address: 'localhost:9000', protoFiles: ['a.proto'] });
    });
});
