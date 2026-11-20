/**
 * Example: OAuth/OIDC access tokens for API calls, against a real OAuth server
 * (mock-oauth2-server in CI): PW_AUTH_ISSUER=http://localhost:8080/default
 *
 * A small local API echoes the Authorization header it receives, to show that
 * openApiClient and graphqlClient send the role's token on their own.
 */

import * as http from 'node:http';
import { test, expect } from '../../src';

const ISSUER = process.env.PW_AUTH_ISSUER ?? '';
const ECHO_PORT = 47_811;
const ECHO = `http://127.0.0.1:${ECHO_PORT}`;

const OPENAPI_SPEC = {
    openapi: '3.0.0',
    info: { title: 'echo', version: '1' },
    servers: [{ url: ECHO }],
    paths: { '/whoami': { get: { operationId: 'whoami', responses: { 200: { description: 'ok' } } } } },
};

/** sub claim of a JWT (not verified; the OAuth server's userinfo endpoint does that). */
const subject = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub as string;

test.describe('Auth — OAuth tokens', () => {
    test.skip(!process.env.CI || !ISSUER, 'Skipped: needs an OAuth server (PW_AUTH_ISSUER)');

    test.use({
        auth: {
            issuer: ISSUER,
            clientId: 'propmaster-tests',
            clientSecret: 'not-a-real-secret',
            defaultRole: 'service',
            roles: {
                service: {}, // client credentials
                admin: { username: 'admin@example.test', password: 'admin-pw' }, // password grant
            },
        },
        openapi: { specPath: `${ECHO}/openapi.json`, baseUrl: ECHO },
        graphql: { endpoint: `${ECHO}/graphql` },
    });

    let server: http.Server;
    test.beforeAll(async () => {
        server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/openapi.json') return res.end(JSON.stringify(OPENAPI_SPEC));
            const authorization = req.headers.authorization ?? null;
            if (req.url === '/graphql') return res.end(JSON.stringify({ data: { authorization } }));
            res.end(JSON.stringify({ authorization }));
        });
        await new Promise<void>((r) => server.listen(ECHO_PORT, '127.0.0.1', r));
    });
    test.afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
    });

    test('[TC-AUTH-004] the OAuth server accepts the default role token', { tag: ['@TC-AUTH-004'] }, async ({ authToken, authRequest }) => {
        await test.step('Step 1: Verify a client-credentials token was issued to the client', async () => {
            expect(subject(authToken)).toBe('propmaster-tests');
        });
        await test.step('Step 2: Call the userinfo endpoint with authRequest', async () => {
            const res = await authRequest.get(`${ISSUER}/userinfo`);
            expect(res.status()).toBe(200);
            expect((await res.json()).sub).toBe('propmaster-tests');
        });
    });

    test.describe('as admin', () => {
        test.use({ authRole: 'admin' });

        test('[TC-AUTH-005] a role gets its own token (password grant)', { tag: ['@TC-AUTH-005'] }, async ({ authToken, authHeaders }) => {
            await test.step('Step 1: Verify the token belongs to the admin user', async () => {
                expect(subject(authToken)).toBe('admin@example.test');
                expect(authHeaders).toEqual({ Authorization: `Bearer ${authToken}` });
            });
        });
    });

    test('[TC-AUTH-006] OpenAPI and GraphQL clients send the token automatically', { tag: ['@TC-AUTH-006'] }, async ({ openApiClient, graphqlClient, authToken }) => {
        await test.step('Step 1: Call the REST API through openApiClient', async () => {
            const res = await (openApiClient.client as any).whoami();
            expect(res.data.authorization).toBe(`Bearer ${authToken}`);
        });
        await test.step('Step 2: Call the GraphQL API through graphqlClient', async () => {
            const data = await graphqlClient.query<{ authorization: string }>('{ authorization }');
            expect(data.authorization).toBe(`Bearer ${authToken}`);
        });
        await test.step('Step 3: Verify a header set on the call wins', async () => {
            const res = await (openApiClient.client as any).whoami(null, null, { headers: { Authorization: 'Bearer my-own' } });
            expect(res.data.authorization).toBe('Bearer my-own');
        });
    });
});
