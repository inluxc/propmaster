/**
 * Fixture Registry — composes all fixture definitions into a single extended Playwright test object.
 *
 * This module is the central composition point for the framework's fixture architecture.
 * It uses Playwright's native `test.extend()` to combine all fixture definitions,
 * enabling tests to declaratively request any fixture by name.
 *
 * Configuration can be provided in two ways:
 *   1. Via project `use` block in playwright.config.ts (recommended)
 *   2. Via environment variables / ConfigLoader (fallback)
 *
 * Usage:
 *   import { test, expect } from '../src/fixtures.js';
 *
 *   test('my test', async ({ openApiClient, databaseClient }) => {
 *     // fixtures are automatically initialized and torn down
 *   });
 *
 * @requirements 1.1, 1.2, 1.3
 */

import { test as base } from '@playwright/test';
import type { Fixtures, TestInfo } from '@playwright/test';
import { dirname } from 'node:path';
import { describeEntry, quarantineEntryFor } from '../reporter/quarantine.js';
import type {
    OpenApiFixtureConfig,
    DatabaseFixtureConfig,
    KafkaFixtureConfig,
    AmqpFixtureConfig,
    AwsFixtureConfig,
    SearchFixtureConfig,
    GrpcFixtureConfig,
    RealtimeFixtureConfig,
    RedisFixtureConfig,
    MongoDbFixtureConfig,
    Neo4jFixtureConfig,
    CassandraFixtureConfig,
    ClickHouseFixtureConfig,
    OtpFixtureConfig,
    InboxFixtureConfig,
    AuthConfig,
    MockServerConfig,
    GraphQLFixtureConfig,
    AppiumFixtureConfig,
} from '../config/schema.js';
import { openApiFixture, type OpenApiClient } from './openapi.fixture.js';
import { databaseFixture, type DatabaseClient } from './database.fixture.js';
import { kafkaFixture, type KafkaClient } from './kafka.fixture.js';
import { amqpFixture, type AmqpClient } from './amqp.fixture.js';
import { s3Fixture, type S3Client } from './s3.fixture.js';
import { sqsFixture, type SqsClient } from './sqs.fixture.js';
import { dynamoDbFixture, type DynamoDbClient } from './dynamodb.fixture.js';
import { searchFixture, type SearchClient } from './search.fixture.js';
import { grpcFixture, type GrpcClient } from './grpc.fixture.js';
export type {
    RealtimeClient,
    WebSocketConnection,
    WebSocketMessage,
    SseConnection,
    SseEvent,
    MessageMatcher,
    RealtimeWaitOptions,
    SseWaitOptions,
    WebSocketConnectOptions,
    SseSubscribeOptions,
    CloseInfo,
} from './realtime.fixture.js';
import { realtimeFixture, type RealtimeClient } from './realtime.fixture.js';
import { redisFixture, type RedisClient } from './redis.fixture.js';
import { mongoDbFixture, type MongoDbClient } from './mongodb.fixture.js';
import { neo4jFixture, type Neo4jClient } from './neo4j.fixture.js';
import { cassandraFixture, type CassandraClient } from './cassandra.fixture.js';
import { clickHouseFixture, type ClickHouseClient } from './clickhouse.fixture.js';
import { otpFixture, type OtpClient } from './otp.fixture.js';
import { inboxFixture, type InboxClient } from './inbox.fixture.js';
import { mockServerFixture, type MockServer } from './mock-server.fixture.js';
import { graphqlFixture, type GraphQLClient } from './graphql.fixture.js';
import { ContainerManager } from '../containers/container-manager.js';
import { TokenManager, roleName } from '../auth/token-manager.js';
import { authStateFile } from '../auth/state-file.js';
import type { APIRequestContext } from '@playwright/test';
import { appiumFixture, type AppiumDriver, type GadsHubClient } from './appium.fixture.js';
import { CleanupRegistry } from '../test-data/registry.js';
import { TestData, newRunId, type FakerLike } from '../test-data/factory.js';
import { loadOptional } from './optional-package.js';

/**
 * Configuration options that can be passed via project `use` block.
 * These are fixture options with default values (undefined), meaning
 * they are optional and fall back to ConfigLoader when not provided.
 */
export interface ConfigOptions {
    openapi: OpenApiFixtureConfig | undefined;
    database: DatabaseFixtureConfig | undefined;
    kafka: KafkaFixtureConfig | undefined;
    amqp: AmqpFixtureConfig | undefined;
    aws: AwsFixtureConfig | undefined;
    search: SearchFixtureConfig | undefined;
    grpc: GrpcFixtureConfig | undefined;
    realtime: RealtimeFixtureConfig | undefined;
    redis: RedisFixtureConfig | undefined;
    mongodb: MongoDbFixtureConfig | undefined;
    neo4j: Neo4jFixtureConfig | undefined;
    cassandra: CassandraFixtureConfig | undefined;
    clickhouse: ClickHouseFixtureConfig | undefined;
    otp: OtpFixtureConfig | undefined;
    inbox: InboxFixtureConfig | undefined;
    auth: AuthConfig | undefined;
    mock: MockServerConfig | undefined;
    /** Role for this test: picks the API token's identity and the saved browser login state. */
    authRole: string | undefined;
    graphql: GraphQLFixtureConfig | undefined;
    appium: AppiumFixtureConfig | undefined;
    /**
     * Undo the data a test creates through the clients (default: true). Set it
     * to false for a project that seeds data meant to stay, e.g. a setup project.
     */
    autoCleanup: boolean;
}

/**
 * Combined fixture types for the extended test object.
 * Each property corresponds to a fixture name available in test functions.
 */
export interface FixtureTypes {
    openApiClient: OpenApiClient;
    databaseClient: DatabaseClient;
    kafkaClient: KafkaClient;
    /** RabbitMQ / AMQP 0-9-1: publish, listen on an exchange, consume, purge. */
    amqpClient: AmqpClient;
    /** S3: write, read, list and wait for objects under a per-test prefix. */
    s3Client: S3Client;
    /** SQS and SNS: send, receive, purge, publish to a topic, listen on a topic. */
    sqsClient: SqsClient;
    /** DynamoDB: put, get, update, query and scan plain objects; writes undone after the test. */
    dynamoDbClient: DynamoDbClient;
    /** Elasticsearch / OpenSearch: index, search, count and wait for documents under a per-test index prefix. */
    searchClient: SearchClient;
    redisConfig: RedisFixtureConfig;
    redisClient: RedisClient;
    mongoDbClient: MongoDbClient;
    neo4jConfig: Neo4jFixtureConfig;
    neo4jClient: Neo4jClient;
    /** Cassandra / ScyllaDB: parameterized CQL, rows as plain objects, inserts undone after the test. */
    cassandraClient: CassandraClient;
    /** ClickHouse: parameterized SQL over HTTP, 64-bit integers as numbers, inserts deleted after the test. */
    clickHouseClient: ClickHouseClient;
    otpConfig: OtpFixtureConfig;
    otpClient: OtpClient;
    inboxConfig: InboxFixtureConfig;
    inboxClient: InboxClient;
    mockConfig: MockServerConfig;
    /** WireMock client: stub third-party APIs and verify the calls your backend made. */
    mockServer: MockServer;
    /** The auth config, or undefined when none is set. */
    authConfig: AuthConfig | undefined;
    /** A valid access token for the test's role (fetched or refreshed as needed). */
    authToken: string;
    /** `{ Authorization: 'Bearer <token>' }` for the test's role. */
    authHeaders: Record<string, string>;
    /** An APIRequestContext that sends the role's bearer token, with the OpenAPI base URL (or baseURL). */
    authRequest: APIRequestContext;
    graphqlClient: GraphQLClient;
    /** gRPC: unary and streaming calls from .proto files or server reflection, with metadata and deadlines. */
    grpcClient: GrpcClient;
    /** WebSocket and SSE: connect, send, wait for a message, read what arrived. */
    realtimeClient: RealtimeClient;
    appiumConfig: AppiumFixtureConfig;
    appiumDriver: AppiumDriver;
    gadsHub: GadsHubClient;
    /** The test's cleanup stack; the client fixtures record their inserts in it. */
    dataCleanup: CleanupRegistry;
    /** Factories, unique values and custom cleanups for the test's data. */
    testData: TestData;
    /** Automatic: adds a `quarantined` annotation (owner, issue, since) to a test listed in quarantine.json. */
    quarantineAnnotation: void;
}

/**
 * Config option fixtures — these are declared as Playwright fixture options
 * with [value, { option: true }] so they can be set from the project `use` block.
 *
 * When a config option is provided via the project, it takes precedence.
 * When undefined (default), fixtures fall back to ConfigLoader / env vars.
 */
const configOptionFixtures = {
    openapi: [undefined as OpenApiFixtureConfig | undefined, { option: true }],
    database: [undefined as DatabaseFixtureConfig | undefined, { option: true }],
    kafka: [undefined as KafkaFixtureConfig | undefined, { option: true }],
    amqp: [undefined as AmqpFixtureConfig | undefined, { option: true }],
    aws: [undefined as AwsFixtureConfig | undefined, { option: true }],
    search: [undefined as SearchFixtureConfig | undefined, { option: true }],
    grpc: [undefined as GrpcFixtureConfig | undefined, { option: true }],
    realtime: [undefined as RealtimeFixtureConfig | undefined, { option: true }],
    redis: [undefined as RedisFixtureConfig | undefined, { option: true }],
    mongodb: [undefined as MongoDbFixtureConfig | undefined, { option: true }],
    neo4j: [undefined as Neo4jFixtureConfig | undefined, { option: true }],
    cassandra: [undefined as CassandraFixtureConfig | undefined, { option: true }],
    clickhouse: [undefined as ClickHouseFixtureConfig | undefined, { option: true }],
    otp: [undefined as OtpFixtureConfig | undefined, { option: true }],
    inbox: [undefined as InboxFixtureConfig | undefined, { option: true }],
    auth: [undefined as AuthConfig | undefined, { option: true }],
    mock: [undefined as MockServerConfig | undefined, { option: true }],
    authRole: [undefined as string | undefined, { option: true }],
    graphql: [undefined as GraphQLFixtureConfig | undefined, { option: true }],
    appium: [undefined as AppiumFixtureConfig | undefined, { option: true }],
    autoCleanup: [true, { option: true }],
};

/**
 * Worker-scoped Testcontainers manager. Cheap until a fixture asks for a
 * container (`container: true` in its config); it then starts that container
 * once per worker and stops everything it started when the worker exits.
 */
export interface WorkerFixtureTypes {
    stagehandContainers: ContainerManager;
    /** OAuth/OIDC tokens, cached per role for the worker. */
    authTokens: TokenManager;
}

const containerFixtures = {
    stagehandContainers: [
        async ({}, use: (manager: ContainerManager) => Promise<void>) => {
            const manager = new ContainerManager();
            await use(manager);
            await manager.stopAll();
        },
        { scope: 'worker' },
    ],
    authTokens: [
        async ({}, use: (manager: TokenManager) => Promise<void>) => {
            await use(new TokenManager());
        },
        { scope: 'worker' },
    ],
};

/**
 * The redisConfig fixture loads Redis configuration from the project config option
 * or falls back to ConfigLoader.
 */
const redisConfigFixture = {
    redisConfig: async (
        { redis, stagehandContainers }: { redis: RedisFixtureConfig | undefined; stagehandContainers: ContainerManager },
        use: (config: RedisFixtureConfig) => Promise<void>,
    ) => {
        if (redis) {
            await use(await stagehandContainers.redis(redis));
            return;
        }

        // Fallback: load from ConfigLoader
        const { ConfigLoader } = await import('../config/loader.js');
        const loader = new ConfigLoader();
        const frameworkConfig = loader.load();

        if (!frameworkConfig.redis) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('redis', 'connect', {
                reason: 'Redis configuration is missing. Provide redis config in environments.json, environment variables, or project use block.',
            });
        }

        await use(await stagehandContainers.redis(frameworkConfig.redis));
    },
};

/**
 * The neo4jConfig fixture loads Neo4j configuration from the project config option
 * or falls back to ConfigLoader.
 */
const neo4jConfigFixture = {
    neo4jConfig: async (
        { neo4j, stagehandContainers }: { neo4j: Neo4jFixtureConfig | undefined; stagehandContainers: ContainerManager },
        use: (config: Neo4jFixtureConfig) => Promise<void>,
    ) => {
        if (neo4j) {
            await use(await stagehandContainers.neo4j(neo4j));
            return;
        }

        // Fallback: load from ConfigLoader
        const { ConfigLoader } = await import('../config/loader.js');
        const loader = new ConfigLoader();
        const frameworkConfig = loader.load();

        if (!frameworkConfig.neo4j) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('neo4j', 'connect', {
                reason: 'Neo4j configuration is missing. Provide neo4j config in environments.json, environment variables, or project use block.',
            });
        }

        await use(await stagehandContainers.neo4j(frameworkConfig.neo4j));
    },
};

/**
 * The otpConfig fixture loads OTP configuration from the project config option
 * or falls back to ConfigLoader.
 */
const otpConfigFixture = {
    otpConfig: async (
        { otp }: { otp: OtpFixtureConfig | undefined },
        use: (config: OtpFixtureConfig) => Promise<void>,
    ) => {
        if (otp) {
            await use(otp);
            return;
        }

        // Fallback: load from ConfigLoader
        const { ConfigLoader } = await import('../config/loader.js');
        const loader = new ConfigLoader();
        const frameworkConfig = loader.load();

        // OTP config is optional — use empty config (no default secret) if not provided
        await use(frameworkConfig.otp ?? {});
    },
};

/**
 * The inboxConfig fixture loads the test mail server (Mailpit) configuration
 * from the project config option or ConfigLoader, and starts Mailpit in a
 * container when `container` is set.
 */
const inboxConfigFixture = {
    inboxConfig: async (
        { inbox, stagehandContainers }: { inbox: InboxFixtureConfig | undefined; stagehandContainers: ContainerManager },
        use: (config: InboxFixtureConfig) => Promise<void>,
    ) => {
        let config = inbox;
        if (!config) {
            const { ConfigLoader } = await import('../config/loader.js');
            config = new ConfigLoader().load().inbox;
        }
        const resolved = config ? await stagehandContainers.inbox(config) : undefined;
        if (!resolved?.url) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('inbox', 'connect', {
                reason: 'Inbox configuration is missing. Set PW_INBOX_URL (e.g. http://localhost:8025), PW_INBOX_CONTAINER=true, or inbox in environments.json or the project use block.',
            });
        }
        await use(resolved);
    },
};

/** Loads config, or returns undefined when there's none to load (no environments.json). */
async function tryLoadConfig() {
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load();
    } catch {
        return undefined;
    }
}

/**
 * Auth fixtures. `authConfig` resolves the auth section (project option or
 * ConfigLoader); `authToken`/`authHeaders`/`authRequest` give the test's role a
 * bearer token; `storageState` is overridden so `authRole` also picks that
 * role's saved browser login state.
 */
const authFixtures = {
    authConfig: async ({ auth }: { auth: AuthConfig | undefined }, use: (config: AuthConfig | undefined) => Promise<void>) => {
        await use(auth ?? (await tryLoadConfig())?.auth);
    },
    authToken: async (
        { authConfig, authRole, authTokens }: { authConfig: AuthConfig | undefined; authRole: string | undefined; authTokens: TokenManager },
        use: (token: string) => Promise<void>,
    ) => {
        if (!authConfig) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('auth', 'init', {
                reason: 'Auth configuration is missing. Set PW_AUTH_TOKEN_URL or PW_AUTH_ISSUER plus credentials, or auth in environments.json or the project use block.',
            });
        }
        await use(await authTokens.getToken(authConfig, authRole));
    },
    authHeaders: async ({ authToken }: { authToken: string }, use: (headers: Record<string, string>) => Promise<void>) => {
        await use({ Authorization: `Bearer ${authToken}` });
    },
    authRequest: async (
        { playwright, authHeaders, openapi, baseURL }: { playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }; authHeaders: Record<string, string>; openapi: OpenApiFixtureConfig | undefined; baseURL: string | undefined },
        use: (request: APIRequestContext) => Promise<void>,
    ) => {
        const base = openapi?.baseUrl ?? (await tryLoadConfig())?.openapi?.baseUrl ?? baseURL;
        const request = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: authHeaders });
        await use(request);
        await request.dispose();
    },
    storageState: async (
        { authRole, auth, storageState }: { authRole: string | undefined; auth: AuthConfig | undefined; storageState: unknown },
        use: (state: unknown) => Promise<void>,
    ) => {
        if (authRole === undefined) {
            await use(storageState);
            return;
        }
        const config = auth ?? (await tryLoadConfig())?.auth ?? {};
        // Always the role's file, even before it exists: API-only tests with a role
        // never open a browser, and Playwright resolves storageState for every test.
        // A browser test whose role wasn't logged in fails when its context is
        // created ("Error reading storage state from .auth/<role>.json").
        await use(authStateFile(roleName(config, authRole), config.stateDir));
    },
};

/**
 * The mockConfig fixture loads the WireMock configuration from the project
 * config option or ConfigLoader, and starts WireMock in a container when
 * `container` is set.
 */
const mockConfigFixture = {
    mockConfig: async (
        { mock, stagehandContainers }: { mock: MockServerConfig | undefined; stagehandContainers: ContainerManager },
        use: (config: MockServerConfig) => Promise<void>,
    ) => {
        const config = mock ?? (await tryLoadConfig())?.mock;
        const resolved = config ? await stagehandContainers.mock(config) : undefined;
        if (!resolved?.url) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('mockServer', 'connect', {
                reason: 'Mock server configuration is missing. Set PW_MOCK_URL (e.g. http://localhost:8089), PW_MOCK_CONTAINER=true, or mock in environments.json or the project use block.',
            });
        }
        await use(resolved);
    },
};

/**
 * Quarantine: a test listed in quarantine.json gets a `quarantined`
 * annotation, so every report shows who owns the fix. Whether its failure
 * fails the run is the Propmaster reporter's decision.
 */
const quarantineFixtures = {
    quarantineAnnotation: [
        async ({}, use: () => Promise<void>, testInfo: TestInfo) => {
            const root = testInfo.config.configFile ? dirname(testInfo.config.configFile) : testInfo.config.rootDir;
            const entry = quarantineEntryFor(root, testInfo.title, testInfo.tags);
            if (entry) testInfo.annotations.push({ type: 'quarantined', description: describeEntry(entry) });
            await use();
        },
        { auto: true },
    ],
};

/**
 * Test data: `dataCleanup` is the per-test undo stack the client fixtures
 * record their inserts in, run before they disconnect. `testData` adds
 * factories and unique values on top. Neither connects to anything.
 */
const testDataFixtures = {
    dataCleanup: async ({ autoCleanup }: { autoCleanup: boolean }, use: (registry: CleanupRegistry) => Promise<void>) => {
        const registry = new CleanupRegistry(autoCleanup);
        await use(registry);
        // Whatever no client fixture ran (testData.cleanup() in a test with no client)
        await registry.flush();
    },
    // `request` is a dependency only so that it outlives testData: Playwright
    // tears a fixture down before the fixtures it depends on, so the undo
    // stack below runs while `request` is open, and testData.cleanup() can
    // undo API calls whatever order the test lists its fixtures in. Creating
    // an APIRequestContext opens no connection.
    testData: async (
        { dataCleanup, request: _request }: { dataCleanup: CleanupRegistry; request: unknown },
        use: (data: TestData) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        let faker: FakerLike;
        let fakerError: Error | undefined;
        try {
            faker = (await loadOptional<{ faker: FakerLike }>('@faker-js/faker', 'testData (faker)')).faker;
        } catch (error) {
            fakerError = error as Error; // only thrown if the test reads testData.faker
        }
        await use(new TestData(dataCleanup, { runId: newRunId(testInfo.workerIndex), faker, fakerError }));
        // Run the stack here, not only in the client fixtures' teardown: a
        // client set up before `request` tears down after it. Whichever of
        // these flushes first runs everything; the later flushes are no-ops.
        await dataCleanup.flush();
    },
};

/**
 * The appiumConfig fixture loads Appium configuration from the project config option
 * or falls back to ConfigLoader.
 */
const appiumConfigFixture = {
    appiumConfig: async (
        { appium }: { appium: AppiumFixtureConfig | undefined },
        use: (config: AppiumFixtureConfig) => Promise<void>,
    ) => {
        if (appium) {
            await use(appium);
            return;
        }

        // Fallback: load from ConfigLoader
        const { ConfigLoader } = await import('../config/loader.js');
        const loader = new ConfigLoader();
        const frameworkConfig = loader.load();

        if (!frameworkConfig.appium) {
            const { FixtureInitError } = await import('../errors.js');
            throw new FixtureInitError('appium', 'init', {
                reason: 'Appium configuration is missing. Provide appium config in environments.json, PW_APPIUM_* environment variables, or project use block.',
            });
        }

        await use(frameworkConfig.appium);
    },
};

/**
 * All fixture definitions combined into a single object.
 *
 * Fixtures declare dependencies by listing other fixture names as parameters,
 * and Playwright's native fixture system handles dependency resolution:
 * - `redisClient` depends on `redisConfig`
 * - `neo4jClient` depends on `neo4jConfig`
 * - `appiumDriver` and `gadsHub` depend on `appiumConfig`
 *
 * Config options are declared with { option: true } so they can be set
 * from the project `use` block in playwright.config.ts.
 *
 * Note: We use a type assertion here because spreading fixture objects that mix
 * tuple-style definitions (e.g., [fn, { scope: 'test' }]) with plain function
 * definitions causes TypeScript to lose tuple type information. The runtime
 * behavior is correct — Playwright handles both formats natively.
 */
const allFixtures = {
    ...configOptionFixtures,
    ...containerFixtures,
    ...authFixtures,
    ...openApiFixture,
    ...databaseFixture,
    ...kafkaFixture,
    ...amqpFixture,
    ...s3Fixture,
    ...sqsFixture,
    ...dynamoDbFixture,
    ...searchFixture,
    ...grpcFixture,
    ...realtimeFixture,
    ...redisConfigFixture,
    ...redisFixture,
    ...mongoDbFixture,
    ...neo4jConfigFixture,
    ...neo4jFixture,
    ...cassandraFixture,
    ...clickHouseFixture,
    ...otpConfigFixture,
    ...otpFixture,
    ...inboxConfigFixture,
    ...inboxFixture,
    ...mockConfigFixture,
    ...mockServerFixture,
    ...graphqlFixture,
    ...appiumConfigFixture,
    ...appiumFixture,
    ...testDataFixtures,
    ...quarantineFixtures,
};

/**
 * Extended Playwright test object with all framework fixtures composed.
 */
export const test = base.extend<FixtureTypes & ConfigOptions, WorkerFixtureTypes>(
    allFixtures as unknown as Fixtures<FixtureTypes & ConfigOptions, WorkerFixtureTypes>,
);

export { expect } from '@playwright/test';

// Re-export fixture client types for consumer convenience
export type { OpenApiClient, AxiosResponseLike, ContractCallOption } from './openapi.fixture.js';
export type { DatabaseClient } from './database.fixture.js';
export type { KafkaClient } from './kafka.fixture.js';
export type {
    AmqpClient,
    AmqpListener,
    AmqpMessage,
    AmqpBody,
    AmqpPublishOptions,
    AmqpConsumeOptions,
    AmqpWaitOptions,
    AmqpListenOptions,
    AmqpQueueInfo,
} from './amqp.fixture.js';
export type { S3Client, S3Object, S3ObjectInfo, S3ObjectSummary, S3PutOptions, S3WaitOptions, S3BucketOption } from './s3.fixture.js';
export type {
    SqsClient,
    SqsMessage,
    SqsSendOptions,
    SqsReceiveOptions,
    SqsQueueInfo,
    SqsCreateQueueOptions,
    SnsListener,
    SnsMessage,
    SnsPublishOptions,
    SnsListenOptions,
    SnsWaitOptions,
    AwsMessageAttributes,
} from './sqs.fixture.js';
export type {
    DynamoDbClient,
    DynamoItem,
    DynamoKey,
    DynamoComparison,
    DynamoConditions,
    DynamoExpression,
    DynamoPutOptions,
    DynamoUpdateOptions,
    DynamoDeleteOptions,
    DynamoGetOptions,
    DynamoQueryOptions,
    DynamoScanOptions,
    DynamoWaitOptions,
    DynamoWaitForItemOptions,
    DynamoWaitForQueryOptions,
    DynamoTableDefinition,
    DynamoKeyDefinition,
    DynamoKeyType,
    DynamoTableKey,
} from './dynamodb.fixture.js';
export type {
    CassandraClient,
    CassandraRow,
    CqlParams,
    CqlOptions,
    CassandraInsertOptions,
    CassandraWaitOptions,
    CassandraWaitForRowOptions,
    CassandraKeyspaceOptions,
    CassandraPrimaryKey,
} from './cassandra.fixture.js';
export type {
    ClickHouseClient,
    ClickHouseRow,
    ClickHouseParams,
    ClickHouseQueryOptions,
    ClickHouseInsertOptions,
    ClickHouseWaitOptions,
    ClickHouseWaitForRowOptions,
    ClickHouseColumn,
} from './clickhouse.fixture.js';
export type { AwsBody } from './aws.js';
export type {
    SearchClient,
    SearchQuery,
    SearchOptions,
    SearchResult,
    SearchHit,
    SearchWaitOptions,
    IndexOptions,
    IndexManyOptions,
    IndexResult,
    CreateIndexOptions,
    SearchEngineInfo,
    SearchRequestOptions,
    Refresh,
} from './search.fixture.js';
export type {
    GrpcClient,
    GrpcCallOptions,
    GrpcServerStreamOptions,
    GrpcResult,
    GrpcMethodInfo,
    GrpcMetadataInput,
    GrpcStatusName,
} from './grpc.fixture.js';
export type { InboxClient, InboxMessage, InboxProvider, MessageQuery, WaitOptions, SendOptions } from './inbox.fixture.js';
export type { MockServer, RequestMatch, StubResponse, RecordedRequest, Stub } from './mock-server.fixture.js';
export type { RedisClient } from './redis.fixture.js';
export type { MongoDbClient } from './mongodb.fixture.js';
export type { Neo4jClient, Neo4jTransaction, Neo4jWriteResult, CypherParams } from './neo4j.fixture.js';
export type { OtpClient } from './otp.fixture.js';
export type { InsertOptions } from './database.fixture.js';
export type { GraphQLClient } from './graphql.fixture.js';
export type {
    AppiumDriver,
    GadsHubClient,
    GadsDeviceInfo,
    GadsDeviceCriteria,
    GadsGridStatus,
    GadsSessionInfo,
} from './appium.fixture.js';
