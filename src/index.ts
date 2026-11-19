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
    DatabaseClient,
    KafkaClient,
    RedisClient,
    MongoDbClient,
    Neo4jClient,
    Neo4jTransaction,
    Neo4jWriteResult,
    CypherParams,
    MobilewrightScreen,
    MobilewrightDevice,
    OtpClient,
    GraphQLClient,
    GadsDevice,
    GadsHubClient,
    GadsDeviceInfo,
    GadsDeviceCriteria,
    GadsGridStatus,
    GadsLocatorStrategy,
    FixtureTypes,
    ConfigOptions,
} from './fixtures/index.js';

// Configuration types and loaders
export type {
    FrameworkConfig,
    OpenApiFixtureConfig,
    DatabaseFixtureConfig,
    MongoDbFixtureConfig,
    Neo4jFixtureConfig,
    KafkaFixtureConfig,
    RedisFixtureConfig,
    MobilewrightFixtureConfig,
    OtpFixtureConfig,
    GraphQLFixtureConfig,
    GadsFixtureConfig,
    SecretsConfig,
    EnvironmentsFile,
} from './config/index.js';
export { ConfigLoader } from './config/index.js';
export { EnvLoader } from './config/index.js';

// GADS helpers for use outside the fixture (e.g. worker-scoped sessions)
export { createGadsHubClient, startGadsSession } from './fixtures/gads.fixture.js';

// Error types
export {
    FrameworkError,
    ConfigurationError,
    FixtureInitError,
    FixtureOperationError,
    SecretsError,
    DependencyError,
} from './errors.js';

// Secrets interfaces
export type { SecretsProvider } from './secrets/index.js';
export { SecretsManager } from './secrets/index.js';
