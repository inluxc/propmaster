/**
 * Main entry point for the Playwright Framework Template.
 *
 * Re-exports the extended test object, fixture client types, configuration types,
 * error classes, and secrets interfaces for consumer use.
 *
 * Usage:
 *   import { test, expect } from './src';
 *   import type { OpenApiClient, FrameworkConfig } from './src';
 *
 * @requirements 1.1, 1.2
 */

// Extended Playwright test object and expect
export { test, expect } from './fixtures/index.js';

// Fixture client types
export type {
    OpenApiClient,
    AxiosResponseLike,
    ContractCallOption,
    DatabaseClient,
    KafkaClient,
    AmqpClient,
    AmqpListener,
    AmqpMessage,
    AmqpBody,
    AmqpPublishOptions,
    AmqpConsumeOptions,
    AmqpWaitOptions,
    AmqpListenOptions,
    AmqpQueueInfo,
    S3Client,
    S3Object,
    S3ObjectInfo,
    S3ObjectSummary,
    S3PutOptions,
    S3WaitOptions,
    S3BucketOption,
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
    AwsBody,
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
    CassandraClient,
    CassandraRow,
    CqlParams,
    CqlOptions,
    CassandraInsertOptions,
    CassandraWaitOptions,
    CassandraWaitForRowOptions,
    CassandraKeyspaceOptions,
    CassandraPrimaryKey,
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
    GrpcClient,
    GrpcCallOptions,
    GrpcServerStreamOptions,
    GrpcResult,
    GrpcMethodInfo,
    GrpcMetadataInput,
    GrpcStatusName,
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
    RedisClient,
    MongoDbClient,
    Neo4jClient,
    Neo4jTransaction,
    Neo4jWriteResult,
    InsertOptions,
    CypherParams,
    OtpClient,
    InboxClient,
    InboxMessage,
    InboxProvider,
    MockServer,
    RequestMatch,
    StubResponse,
    RecordedRequest,
    GraphQLClient,
    AppiumDriver,
    GadsHubClient,
    GadsDeviceInfo,
    GadsDeviceCriteria,
    GadsGridStatus,
    GadsSessionInfo,
    FixtureTypes,
    ConfigOptions,
    WorkerFixtureTypes,
} from './fixtures/index.js';

// Configuration types and loaders
export type {
    FrameworkConfig,
    ContainerOptions,
    ContainerSetting,
    OpenApiFixtureConfig,
    DatabaseFixtureConfig,
    MongoDbFixtureConfig,
    Neo4jFixtureConfig,
    KafkaFixtureConfig,
    AmqpFixtureConfig,
    AwsFixtureConfig,
    SearchFixtureConfig,
    GrpcFixtureConfig,
    GrpcTlsConfig,
    RealtimeFixtureConfig,
    RedisFixtureConfig,
    OtpFixtureConfig,
    InboxFixtureConfig,
    AuthConfig,
    AuthRoleConfig,
    MockServerConfig,
    GraphQLFixtureConfig,
    AppiumFixtureConfig,
    GadsPresetConfig,
    SecretsConfig,
    EnvironmentsFile,
} from './config/index.js';
export { ConfigLoader } from './config/index.js';
export { MailpitProvider } from './fixtures/inbox.fixture.js';
export { WireMockAdmin } from './fixtures/mock-server.fixture.js';
export { TokenManager, resolveRole, type ResolvedRole, type TokenSet } from './auth/token-manager.js';
export { authStateFile } from './auth/state-file.js';
export { setupAuth, saveAuthState, authCredentials, hasFreshAuthState, type SetupAuthOptions } from './auth/setup.js';
export { ContainerManager, DEFAULT_IMAGES } from './containers/container-manager.js';
export { TestData, defineFactory, CleanupRegistry, type Factory, type FactoryContext, type Overrides, type KeepOption } from './test-data/index.js';
export { EnvLoader } from './config/index.js';

// AMQP client outside the fixture (e.g. a global setup that declares exchanges)
export { createAmqpClient } from './fixtures/amqp.fixture.js';

// AWS clients outside the fixtures (e.g. a global setup that creates buckets and queues)
export { createS3Client } from './fixtures/s3.fixture.js';
export { createSqsClient } from './fixtures/sqs.fixture.js';
export { createDynamoDbClient } from './fixtures/dynamodb.fixture.js';

// Cassandra / ScyllaDB client outside the fixture (e.g. a global setup that creates the schema)
export { createCassandraClient } from './fixtures/cassandra.fixture.js';

// Search client outside the fixture (e.g. a global setup that creates index templates)
export { createSearchClient } from './fixtures/search.fixture.js';

// gRPC client outside the fixture, and its error type (code, codeName, details, trailers)
export { createGrpcClient, GrpcError } from './fixtures/grpc.fixture.js';

// Realtime (WebSocket / SSE) client outside the fixture, its connection error (status, body), and the SSE parser
export { createRealtimeClient, RealtimeError, SseParser } from './fixtures/realtime.fixture.js';

// Appium/GADS helpers for use outside the fixture (e.g. worker-scoped sessions)
export { startAppiumSession, createGadsHubClient, gadsSessionInfo } from './fixtures/appium.fixture.js';

// Error types
export {
    FrameworkError,
    ConfigurationError,
    FixtureInitError,
    FixtureOperationError,
    SecretsError,
    DependencyError,
    MissingPackageError,
    ContractError,
} from './errors.js';
export type { ContractViolation } from './errors.js';

// Contract checks (OpenAPI request/response validation)
export { ContractValidator, assertContract } from './openapi/contract.js';
export type { ContractMode, ContractOperation, ContractResult } from './openapi/contract.js';

// Secrets interfaces
export type { SecretsProvider } from './secrets/index.js';
export { SecretsManager } from './secrets/index.js';
export {
    AwsSecretsProvider,
    GitLabSecretsProvider,
    VaultSecretsProvider,
    OpenBaoSecretsProvider,
    VaultCompatibleProvider,
    AzureSecretsProvider,
    EnvFileSecretsProvider,
    createProvider,
    createDefaultProviders,
} from './secrets/index.js';
export type {
    AwsProviderOptions,
    GitLabProviderOptions,
    VaultProviderOptions,
    OpenBaoProviderOptions,
    VaultCompatibleOptions,
    VaultAuthMethod,
    AzureProviderOptions,
    EnvFileProviderOptions,
    ProviderRegistryOptions,
} from './secrets/index.js';
