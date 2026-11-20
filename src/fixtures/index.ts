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
import type { Fixtures } from '@playwright/test';
import type {
    OpenApiFixtureConfig,
    DatabaseFixtureConfig,
    KafkaFixtureConfig,
    RedisFixtureConfig,
    MongoDbFixtureConfig,
    Neo4jFixtureConfig,
    OtpFixtureConfig,
    InboxFixtureConfig,
    GraphQLFixtureConfig,
    AppiumFixtureConfig,
} from '../config/schema.js';
import { openApiFixture, type OpenApiClient } from './openapi.fixture.js';
import { databaseFixture, type DatabaseClient } from './database.fixture.js';
import { kafkaFixture, type KafkaClient } from './kafka.fixture.js';
import { redisFixture, type RedisClient } from './redis.fixture.js';
import { mongoDbFixture, type MongoDbClient } from './mongodb.fixture.js';
import { neo4jFixture, type Neo4jClient } from './neo4j.fixture.js';
import { otpFixture, type OtpClient } from './otp.fixture.js';
import { inboxFixture, type InboxClient } from './inbox.fixture.js';
import { graphqlFixture, type GraphQLClient } from './graphql.fixture.js';
import { ContainerManager } from '../containers/container-manager.js';
import { appiumFixture, type AppiumDriver, type GadsHubClient } from './appium.fixture.js';

/**
 * Configuration options that can be passed via project `use` block.
 * These are fixture options with default values (undefined), meaning
 * they are optional and fall back to ConfigLoader when not provided.
 */
export interface ConfigOptions {
    openapi: OpenApiFixtureConfig | undefined;
    database: DatabaseFixtureConfig | undefined;
    kafka: KafkaFixtureConfig | undefined;
    redis: RedisFixtureConfig | undefined;
    mongodb: MongoDbFixtureConfig | undefined;
    neo4j: Neo4jFixtureConfig | undefined;
    otp: OtpFixtureConfig | undefined;
    inbox: InboxFixtureConfig | undefined;
    graphql: GraphQLFixtureConfig | undefined;
    appium: AppiumFixtureConfig | undefined;
}

/**
 * Combined fixture types for the extended test object.
 * Each property corresponds to a fixture name available in test functions.
 */
export interface FixtureTypes {
    openApiClient: OpenApiClient;
    databaseClient: DatabaseClient;
    kafkaClient: KafkaClient;
    redisConfig: RedisFixtureConfig;
    redisClient: RedisClient;
    mongoDbClient: MongoDbClient;
    neo4jConfig: Neo4jFixtureConfig;
    neo4jClient: Neo4jClient;
    otpConfig: OtpFixtureConfig;
    otpClient: OtpClient;
    inboxConfig: InboxFixtureConfig;
    inboxClient: InboxClient;
    graphqlClient: GraphQLClient;
    appiumConfig: AppiumFixtureConfig;
    appiumDriver: AppiumDriver;
    gadsHub: GadsHubClient;
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
    redis: [undefined as RedisFixtureConfig | undefined, { option: true }],
    mongodb: [undefined as MongoDbFixtureConfig | undefined, { option: true }],
    neo4j: [undefined as Neo4jFixtureConfig | undefined, { option: true }],
    otp: [undefined as OtpFixtureConfig | undefined, { option: true }],
    inbox: [undefined as InboxFixtureConfig | undefined, { option: true }],
    graphql: [undefined as GraphQLFixtureConfig | undefined, { option: true }],
    appium: [undefined as AppiumFixtureConfig | undefined, { option: true }],
};

/**
 * Worker-scoped Testcontainers manager. Cheap until a fixture asks for a
 * container (`container: true` in its config); it then starts that container
 * once per worker and stops everything it started when the worker exits.
 */
export interface WorkerFixtureTypes {
    stagehandContainers: ContainerManager;
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
    ...openApiFixture,
    ...databaseFixture,
    ...kafkaFixture,
    ...redisConfigFixture,
    ...redisFixture,
    ...mongoDbFixture,
    ...neo4jConfigFixture,
    ...neo4jFixture,
    ...otpConfigFixture,
    ...otpFixture,
    ...inboxConfigFixture,
    ...inboxFixture,
    ...graphqlFixture,
    ...appiumConfigFixture,
    ...appiumFixture,
};

/**
 * Extended Playwright test object with all framework fixtures composed.
 */
export const test = base.extend<FixtureTypes & ConfigOptions, WorkerFixtureTypes>(
    allFixtures as unknown as Fixtures<FixtureTypes & ConfigOptions, WorkerFixtureTypes>,
);

export { expect } from '@playwright/test';

// Re-export fixture client types for consumer convenience
export type { OpenApiClient } from './openapi.fixture.js';
export type { DatabaseClient } from './database.fixture.js';
export type { KafkaClient } from './kafka.fixture.js';
export type { InboxClient, InboxMessage, InboxProvider, MessageQuery, WaitOptions, SendOptions } from './inbox.fixture.js';
export type { RedisClient } from './redis.fixture.js';
export type { MongoDbClient } from './mongodb.fixture.js';
export type { Neo4jClient, Neo4jTransaction, Neo4jWriteResult, CypherParams } from './neo4j.fixture.js';
export type { OtpClient } from './otp.fixture.js';
export type { GraphQLClient } from './graphql.fixture.js';
export type {
    AppiumDriver,
    GadsHubClient,
    GadsDeviceInfo,
    GadsDeviceCriteria,
    GadsGridStatus,
    GadsSessionInfo,
} from './appium.fixture.js';
