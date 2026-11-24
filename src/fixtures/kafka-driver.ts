/**
 * Kafka drivers: kafkajs (the default) or Confluent's
 * @confluentinc/kafka-javascript (librdkafka), behind one small kafkajs-style
 * interface. `kafkaClient` and the MCP server's Kafka tools use only this, so
 * both behave the same on either library.
 *
 * The differences this hides:
 * - Confluent takes its kafkajs-style options in a `kafkaJS` block, and
 *   rejects them at the top level.
 * - `fromBeginning` and `autoCommit` are consumer options there, not
 *   `subscribe()` / `run()` options. So `consumer()` takes them here, for
 *   both drivers.
 *
 * Neither library is imported at load time; both are optional peer
 * dependencies loaded on first use.
 */

import type { KafkaFixtureConfig } from '../config/schema.js';
import { loadOptional } from './optional-package.js';

export type KafkaDriverName = 'kafkajs' | 'confluent';

export const KAFKA_DRIVERS: readonly KafkaDriverName[] = ['kafkajs', 'confluent'];

export interface KafkaRawMessage {
    key: Buffer | null;
    value: Buffer | null;
    offset: string;
    timestamp: string;
    headers?: Record<string, unknown>;
}

export interface KafkaProducerLike {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(record: { topic: string; messages: Array<{ key: string | Buffer | null; value: string | Buffer | null }> }): Promise<unknown>;
}

export interface KafkaConsumerLike {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribe(subscription: { topic: string }): Promise<void>;
    run(config: { eachMessage: (payload: { topic: string; partition: number; message: KafkaRawMessage }) => Promise<void> }): Promise<void>;
    stop(): Promise<void>;
    seek(target: { topic: string; partition: number; offset: string }): void;
    /** Commits these offsets (each the next offset to read) for the consumer's group. */
    commitOffsets(offsets: Array<{ topic: string; partition: number; offset: string }>): Promise<void>;
}

export interface KafkaAdminLike {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    listTopics(): Promise<string[]>;
    fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; high: string; low: string }>>;
    deleteGroups(groupIds: string[]): Promise<unknown>;
}

export interface KafkaConsumerOptions {
    groupId: string;
    /** Where a group with no committed offset starts: the oldest message (true) or new ones only (false, the default). */
    fromBeginning?: boolean;
    /** Commit offsets as messages are read (default true). */
    autoCommit?: boolean;
}

/** One Kafka connection, the same shape on either driver. */
export interface KafkaLike {
    readonly driver: KafkaDriverName;
    producer(): KafkaProducerLike;
    consumer(options: KafkaConsumerOptions): KafkaConsumerLike;
    admin(): KafkaAdminLike;
}

export interface KafkaConnectOptions {
    clientId: string;
    /** `warn` for tests (the default), `nothing` for the MCP server. */
    log?: 'warn' | 'nothing';
}

/** The driver a config asks for: `driver`, else PW_KAFKA_DRIVER, else kafkajs. Throws for an unknown name. */
export function kafkaDriverOf(config: Pick<KafkaFixtureConfig, 'driver'>, env: NodeJS.ProcessEnv = process.env): KafkaDriverName {
    const name = config.driver ?? (env.PW_KAFKA_DRIVER as KafkaDriverName | undefined) ?? 'kafkajs';
    if (!KAFKA_DRIVERS.includes(name)) throw new Error(`unknown Kafka driver "${String(name)}"; use ${KAFKA_DRIVERS.join(' or ')}`);
    return name;
}

/** The kafkajs-style connection options both drivers take (Confluent inside its `kafkaJS` block). */
export function kafkaJsOptions(config: KafkaFixtureConfig, clientId: string, logLevel: number): Record<string, unknown> {
    return {
        clientId,
        brokers: config.brokers,
        ssl: config.ssl ?? false,
        ...(config.sasl ? { sasl: config.sasl } : {}),
        logLevel,
    };
}

// ─── kafkajs ────────────────────────────────────────────────────────────────

type KafkaJsModule = typeof import('kafkajs');

function kafkajsDriver(mod: KafkaJsModule, config: KafkaFixtureConfig, options: KafkaConnectOptions): KafkaLike {
    const level = options.log === 'nothing' ? mod.logLevel.NOTHING : mod.logLevel.WARN;
    const kafka = new mod.Kafka(kafkaJsOptions(config, options.clientId, level) as never);
    return {
        driver: 'kafkajs',
        producer: () => kafka.producer() as unknown as KafkaProducerLike,
        admin: () => kafka.admin() as unknown as KafkaAdminLike,
        consumer({ groupId, fromBeginning = false, autoCommit = true }) {
            // A short fetch wait: stop() waits for the fetch in flight, 5 s with the default.
            const consumer = kafka.consumer({ groupId, maxWaitTimeInMs: 250 });
            return {
                connect: () => consumer.connect(),
                disconnect: () => consumer.disconnect(),
                stop: () => consumer.stop(),
                seek: (target) => consumer.seek(target),
                commitOffsets: (offsets) => consumer.commitOffsets(offsets),
                subscribe: ({ topic }) => consumer.subscribe({ topic, fromBeginning }),
                run: ({ eachMessage }) => consumer.run({ autoCommit, eachMessage: eachMessage as never }),
            };
        },
    };
}

// ─── Confluent (@confluentinc/kafka-javascript) ─────────────────────────────

/** The parts of @confluentinc/kafka-javascript used here (its KafkaJS-compatible API). */
interface ConfluentModule {
    KafkaJS: {
        Kafka: new (config: { kafkaJS: Record<string, unknown> }) => {
            producer(config?: { kafkaJS?: Record<string, unknown> }): KafkaProducerLike;
            consumer(config: { kafkaJS: Record<string, unknown> }): {
                connect(): Promise<void>;
                disconnect(): Promise<void>;
                subscribe(subscription: { topics: string[] }): Promise<void>;
                run(config: { eachMessage: (payload: { topic: string; partition: number; message: KafkaRawMessage }) => Promise<void> }): Promise<void>;
                stop(): Promise<void>;
                seek(target: { topic: string; partition: number; offset: string }): void;
                commitOffsets(offsets: Array<{ topic: string; partition: number; offset: string }>): Promise<void>;
            };
            admin(): KafkaAdminLike;
        };
        logLevel: { NOTHING: number; WARN: number };
    };
}

function confluentDriver(mod: ConfluentModule, config: KafkaFixtureConfig, options: KafkaConnectOptions): KafkaLike {
    const { KafkaJS } = mod;
    const level = options.log === 'nothing' ? KafkaJS.logLevel.NOTHING : KafkaJS.logLevel.WARN;
    const kafka = new KafkaJS.Kafka({ kafkaJS: kafkaJsOptions(config, options.clientId, level) });
    return {
        driver: 'confluent',
        producer: () => kafka.producer(),
        admin: () => kafka.admin(),
        consumer({ groupId, fromBeginning = false, autoCommit = true }) {
            const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning, autoCommit } });
            return {
                connect: () => consumer.connect(),
                disconnect: () => consumer.disconnect(),
                // Confluent's stop() throws "Not implemented": disconnect() ends the consumer instead.
                stop: async () => undefined,
                seek: (target) => consumer.seek(target),
                commitOffsets: (offsets) => consumer.commitOffsets(offsets),
                subscribe: ({ topic }) => consumer.subscribe({ topics: [topic] }),
                run: ({ eachMessage }) => consumer.run({ eachMessage }),
            };
        },
    };
}

/**
 * Confluent's client on Bun: its native binding is downloaded for Node.js,
 * and Confluent publishes none for Bun's ABI, so loading it fails with a
 * NODE_MODULE_VERSION mismatch. That error, said with what to do instead.
 */
export function confluentOnBunError(error: unknown, bun: string | null = (process.versions as Record<string, string | undefined>).bun ?? null): Error | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (!bun || !/NODE_MODULE_VERSION|different Node\.js ABI/.test(message)) return undefined;
    return new Error(
        `Confluent's Kafka client doesn't load on Bun ${bun}: its native binding is built for Node.js, and Confluent publishes none for Bun. ` +
            'Use the kafkajs driver (driver: \'kafkajs\', the default), or run these tests on Node.js (`bunx playwright test`, without --bun).',
        { cause: error },
    );
}

/** A Kafka connection on the configured driver. Loads the driver's package on first use. */
export async function createKafka(config: KafkaFixtureConfig, options: KafkaConnectOptions): Promise<KafkaLike> {
    const driver = kafkaDriverOf(config);
    if (driver === 'confluent') {
        let mod: ConfluentModule & { default?: ConfluentModule };
        try {
            mod = await loadOptional<ConfluentModule & { default?: ConfluentModule }>('@confluentinc/kafka-javascript', 'kafkaClient (confluent)');
        } catch (error) {
            throw confluentOnBunError(error) ?? error;
        }
        return confluentDriver(mod.default ?? mod, config, options);
    }
    const mod = await loadOptional<KafkaJsModule & { default?: KafkaJsModule }>('kafkajs', 'kafkaClient');
    return kafkajsDriver(mod.default ?? mod, config, options);
}

/** For unit tests: a driver over a stand-in module. */
export function kafkaFromModule(driver: KafkaDriverName, mod: unknown, config: KafkaFixtureConfig, options: KafkaConnectOptions): KafkaLike {
    return driver === 'confluent' ? confluentDriver(mod as ConfluentModule, config, options) : kafkajsDriver(mod as KafkaJsModule, config, options);
}
