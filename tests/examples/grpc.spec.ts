/**
 * gRPC Fixture — Example Tests
 *
 * Shows unary and streaming calls with `grpcClient`, status codes, metadata,
 * deadlines and TLS, plus the GrpcSteps class, against the grpcbin test
 * server. `hello.HelloService` comes from tests/examples/protos/hello.proto
 * (grpc.protoFiles); `grpcbin.GRPCBin` isn't in any proto file, so the client
 * looks it up through the server's reflection service.
 *
 * Prerequisites:
 *   - `docker compose -f compose.test.yaml up -d --wait grpcbin`
 *     (plaintext on 9000, TLS on 9001)
 *   - PW_GRPC_ADDRESS=localhost:9000, or `grpc` in environments.json
 */

import { test, expect, createGrpcClient, GrpcError } from '../../src';
import { GrpcSteps } from '../../src/steps';

/** grpcbin's TLS port, on the same host as the plaintext one. */
const TLS_PORT = 9001;

test.describe('gRPC Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-GRPC-001] unary call from a .proto file', { tag: ['@TC-GRPC-001'] }, async ({ grpcClient }) => {
        const grpc = new GrpcSteps(grpcClient);

        await grpc.expectResponse('Verify SayHello greets the caller', 'hello.HelloService/SayHello', { greeting: 'Propmaster' }, { reply: 'hello Propmaster' });

        await test.step('Step 1: Verify the method is the one the proto file describes', async () => {
            const [sayHello] = await grpcClient.methods('hello.HelloService');
            expect(sayHello).toMatchObject({ path: 'hello.HelloService/SayHello', kind: 'unary', requestType: 'HelloRequest', responseType: 'HelloResponse' });
        });
    });

    test('[TC-GRPC-002] a service found through server reflection', { tag: ['@TC-GRPC-002'] }, async ({ grpcClient }) => {
        await test.step('Step 1: Verify the server lists its services', async () => {
            expect(await grpcClient.services()).toEqual(expect.arrayContaining(['grpcbin.GRPCBin', 'hello.HelloService']));
        });

        await test.step('Step 2: Call a method no proto file defines; 64-bit ints and enums come back as strings', async () => {
            const echoed = await grpcClient.call('grpcbin.GRPCBin/DummyUnary', {
                f_string: 'order-1',
                f_int64: '9007199254740993',
                f_enum: 'ENUM_2',
                f_sub: { f_string: 'nested' },
                f_strings: ['a', 'b'],
            });
            expect(echoed).toMatchObject({
                f_string: 'order-1',
                f_int64: '9007199254740993',
                f_enum: 'ENUM_2',
                f_sub: { f_string: 'nested' },
                f_strings: ['a', 'b'],
                f_bool: false, // unset fields have their default value
            });
        });
    });

    test('[TC-GRPC-003] server, client and bidirectional streaming', { tag: ['@TC-GRPC-003'] }, async ({ grpcClient }) => {
        const grpc = new GrpcSteps(grpcClient);

        await grpc.serverStream('Verify LotsOfReplies streams ten replies', 'hello.HelloService/LotsOfReplies', { greeting: 'stream' }, { count: 10 });

        await test.step('Step 1: Stop a stream after the first two messages', async () => {
            const firstTwo = await grpcClient.serverStream('hello.HelloService/LotsOfReplies', { greeting: 'stream' }, { limit: 2 });
            expect(firstTwo).toEqual([{ reply: 'hello stream' }, { reply: 'hello stream' }]);
        });

        await test.step('Step 2: Send a stream of requests and get one response', async () => {
            const res = await grpcClient.clientStream('hello.HelloService/LotsOfGreetings', [{ greeting: 'Ana' }, { greeting: 'Bo' }]);
            expect(res).toEqual({ reply: 'hello Ana, Bo' });
        });

        await test.step('Step 3: Get a response per request', async () => {
            const replies = await grpcClient.bidiStream('hello.HelloService/BidiHello', [{ greeting: 'one' }, { greeting: 'two' }]);
            expect(replies).toEqual([{ reply: 'hello one' }, { reply: 'hello two' }]);
        });
    });

    test('[TC-GRPC-004] status codes from a failing call', { tag: ['@TC-GRPC-004'] }, async ({ grpcClient }) => {
        const grpc = new GrpcSteps(grpcClient);

        await grpc.expectStatus('Verify the server answers NOT_FOUND with its reason', 'grpcbin.GRPCBin/SpecificError',
            { code: 5, reason: 'order o-42 not found' }, 'NOT_FOUND', { details: 'order o-42 not found' });

        await test.step('Step 1: Verify call() throws a GrpcError with the code and the message', async () => {
            const error = await grpcClient.call('grpcbin.GRPCBin/SpecificError', { code: 7, reason: 'not your order' }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(GrpcError);
            expect(error).toMatchObject({ code: 7, codeName: 'PERMISSION_DENIED', statusDetails: 'not your order' });
            expect((error as Error).message).toContain('grpcbin.GRPCBin/SpecificError failed: 7 PERMISSION_DENIED: not your order');
        });
    });

    test('[TC-GRPC-005] metadata and deadlines', { tag: ['@TC-GRPC-005'] }, async ({ grpcClient }) => {
        await test.step('Step 1: Send metadata on every call and on one call; the server echoes what it got', async () => {
            grpcClient.setMetadata('x-tenant', 'acme');
            const res = await grpcClient.call<{ Metadata: { key: string; value: { values: string[] } }[] }>(
                'grpcbin.GRPCBin/HeadersUnary', {}, { metadata: { 'x-request-id': 'req-1' } });
            const received = Object.fromEntries(res.Metadata.map((m) => [m.key, m.value.values.join(',')]));
            expect(received).toMatchObject({ 'x-tenant': 'acme', 'x-request-id': 'req-1' });
        });

        await test.step('Step 2: Give one call its own deadline and read its status and headers', async () => {
            // Every call has a deadline (grpc.timeout, 10 s by default); past it, the status is DEADLINE_EXCEEDED.
            const result = await grpcClient.invoke('hello.HelloService/SayHello', { greeting: 'deadline' }, { timeout: 30_000 });
            expect(result).toMatchObject({ ok: true, codeName: 'OK', response: { reply: 'hello deadline' } });
            expect(result.metadata['content-type']).toBe('application/grpc');
        });
    });

    test('[TC-GRPC-006] TLS with a self-signed certificate', { tag: ['@TC-GRPC-006'] }, async ({ grpcClient }) => {
        const host = grpcClient.address.replace(/:\d+$/, '');

        await test.step('Step 1: Verify the certificate is refused by default', async () => {
            const strict = createGrpcClient({ address: `grpcs://${host}:${TLS_PORT}`, timeout: 5000 });
            try {
                await expect(strict.call('hello.HelloService/SayHello', { greeting: 'tls' })).rejects.toThrow(/certificate/);
            } finally {
                strict.close();
            }
        });

        await test.step('Step 2: Call over TLS when the test trusts any certificate', async () => {
            const tls = createGrpcClient({ address: `grpcs://${host}:${TLS_PORT}`, tls: { insecureSkipVerify: true } });
            try {
                expect(await tls.call('hello.HelloService/SayHello', { greeting: 'tls' })).toEqual({ reply: 'hello tls' });
            } finally {
                tls.close();
            }
        });
    });
});
