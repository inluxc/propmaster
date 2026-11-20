/**
 * Mock Server Step Class
 *
 * Reusable steps for stubbing third-party APIs (WireMock) and checking the
 * calls the application made. Each method runs inside `test.step()`.
 */

import { test, expect } from '../index.js';
import type { MockServer, RecordedRequest, RequestMatch, Stub, StubResponse } from '../fixtures/mock-server.fixture.js';

export type { MockServer, RecordedRequest } from '../fixtures/mock-server.fixture.js';

export class MockServerSteps {
    constructor(private mockServer: MockServer) {}

    /** Stubs a third-party endpoint for the rest of the test. */
    async stub(description: string, match: RequestMatch, response: StubResponse): Promise<Stub> {
        let stub!: Stub;
        await test.step(`Step: ${description}`, async () => {
            stub = await this.mockServer.stub(match, response);
            expect(stub.id).toBeTruthy();
        });
        return stub;
    }

    /** Stubs a series of responses, e.g. two failures then a success, to test retries. */
    async stubSequence(description: string, match: RequestMatch, responses: StubResponse[]): Promise<Stub> {
        let stub!: Stub;
        await test.step(`Step: ${description}`, async () => {
            stub = await this.mockServer.stubSequence(match, responses);
        });
        return stub;
    }

    /** Checks the application made the call (`times`, or at least once). */
    async verifyCalled(description: string, match: RequestMatch, times?: number): Promise<RecordedRequest[]> {
        let found: RecordedRequest[] = [];
        await test.step(`Step: ${description}`, async () => {
            found = await this.mockServer.verify(match, times === undefined ? {} : { times });
        });
        return found;
    }

    /** Checks the application did not make the call. */
    async verifyNotCalled(description: string, match: RequestMatch): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.mockServer.verify(match, { times: 0 });
        });
    }
}
