/**
 * gRPC Step Class
 *
 * Reusable steps for gRPC services (`GrpcSteps`). Each method runs inside
 * `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type { GrpcCallOptions, GrpcClient, GrpcResult, GrpcServerStreamOptions, GrpcStatusName } from '../fixtures/grpc.fixture.js';

export type { GrpcClient, GrpcResult, GrpcStatusName } from '../fixtures/grpc.fixture.js';

export class GrpcSteps {
    constructor(private grpcClient: GrpcClient) {}

    /** Calls a unary method and returns the response (fails the step on a non-OK status). */
    async call<TRes = any>(description: string, method: string, request?: Record<string, unknown>, options?: GrpcCallOptions): Promise<TRes> {
        let response!: TRes;
        await test.step(`Step: ${description}`, async () => {
            response = await this.grpcClient.call<TRes>(method, request, options);
        });
        return response;
    }

    /** Calls a unary method and checks the response contains `expected` (toMatchObject). */
    async expectResponse<TRes = any>(description: string, method: string, request: Record<string, unknown> | undefined, expected: Record<string, unknown>, options?: GrpcCallOptions): Promise<TRes> {
        let response!: TRes;
        await test.step(`Step: ${description}`, async () => {
            response = await this.grpcClient.call<TRes>(method, request, options);
            expect(response as Record<string, unknown>, `response of ${method}`).toMatchObject(expected);
        });
        return response;
    }

    /** Calls any method and checks it ends with `status` (e.g. `NOT_FOUND`), optionally with a message matching `details`. */
    async expectStatus<TRes = any>(
        description: string,
        method: string,
        request: Record<string, unknown> | Record<string, unknown>[] | undefined,
        status: GrpcStatusName,
        options?: GrpcServerStreamOptions & { details?: string | RegExp },
    ): Promise<GrpcResult<TRes>> {
        let result!: GrpcResult<TRes>;
        await test.step(`Step: ${description}`, async () => {
            result = await this.grpcClient.invoke<TRes>(method, request, options);
            expect(result.codeName, `status of ${method}${result.details ? ` (${result.details})` : ''}`).toBe(status);
            if (options?.details !== undefined) expect(result.details).toMatch(options.details);
        });
        return result;
    }

    /** Calls a server-streaming method and returns the messages; `count` checks how many arrived. */
    async serverStream<TRes = any>(description: string, method: string, request?: Record<string, unknown>, options?: GrpcServerStreamOptions & { count?: number }): Promise<TRes[]> {
        let messages!: TRes[];
        await test.step(`Step: ${description}`, async () => {
            messages = await this.grpcClient.serverStream<TRes>(method, request, options);
            if (options?.count !== undefined) expect(messages, `messages from ${method}`).toHaveLength(options.count);
        });
        return messages;
    }

    /** Sends `requests` on a client-streaming method and returns the response. */
    async clientStream<TRes = any>(description: string, method: string, requests: Record<string, unknown>[], options?: GrpcCallOptions): Promise<TRes> {
        let response!: TRes;
        await test.step(`Step: ${description}`, async () => {
            response = await this.grpcClient.clientStream<TRes>(method, requests, options);
        });
        return response;
    }

    /** Sends `requests` on a bidirectional method and returns every response. */
    async bidiStream<TRes = any>(description: string, method: string, requests: Record<string, unknown>[], options?: GrpcCallOptions): Promise<TRes[]> {
        let messages!: TRes[];
        await test.step(`Step: ${description}`, async () => {
            messages = await this.grpcClient.bidiStream<TRes>(method, requests, options);
        });
        return messages;
    }
}
