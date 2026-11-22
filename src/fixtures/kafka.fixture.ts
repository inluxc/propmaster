/**
 * Kafka integration fixture for Playwright tests.
 *
 * Provides a KafkaClient with produce() and consume() methods,
 * managing producer and consumer lifecycle per test with unique
 * consumer group IDs for message isolation.
 *
 * Runs on kafkajs (the default) or, with `driver: 'confluent'` /
 * PW_KAFKA_DRIVER=confluent, on Confluent's @confluentinc/kafka-javascript
 * (librdkafka). Both behave the same here; see kafka-driver.ts.
 */

import { parseContainerEnv, type ContainerManager } from '../containers/container-manager.js';
import { KafkaFixtureConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import { createKafka, kafkaDriverOf, type KafkaAdminLike, type KafkaConsumerLike, type KafkaLike, type KafkaProducerLike } from './kafka-driver.js';

/**
 * A single Kafka message with metadata.
 */
export interface KafkaMessage {
    key: string | null;
    value: string | Buffer;
    topic: string;
    partition: number;
    offset: string;
}

/**
 * Options for consuming messages from a topic.
 */
export interface ConsumeOptions {
    /** Maximum time to wait for messages in ms (default: 30000). */
    timeout?: number;
    /** Maximum number of messages to consume. */
    count?: number;
    /** Whether to consume from the beginning of the topic. */
    fromBeginning?: boolean;
}

/**
 * Client interface exposed to tests for Kafka interactions.
 */
export interface KafkaClient {
    produce(topic: string, messages: Array<{ key?: string | null; value: string | Buffer }>): Promise<void>;
    consume(topic: string, options?: ConsumeOptions): Promise<KafkaMessage[]>;
    disconnect(): Promise<void>;
    /** The library underneath: `kafkajs` or `confluent`. */
    readonly driver: KafkaLike['driver'];
}

/**
 * Generates a unique consumer group ID for test isolation.
 */
export function generateGroupId(testId: string): string {
    return `test-${testId}-${Date.now()}`;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Builds the client on a connection. Connects the producer and an admin
 * client (for topic lookups); each consume() call connects a consumer in the
 * test's group, so committed offsets carry over from one call to the next.
 */
export async function createKafkaClient(kafka: KafkaLike, config: KafkaFixtureConfig, groupId: string): Promise<KafkaClient> {
    const disconnectTimeout = config.disconnectTimeout ?? 5000;
    const brokerAddress = config.brokers.join(',');
    const producer: KafkaProducerLike = kafka.producer();
    const admin: KafkaAdminLike = kafka.admin();
    const consumers = new Set<KafkaConsumerLike>();

    try {
        await producer.connect();
        await admin.connect();
    } catch (error) {
        await Promise.allSettled([producer.disconnect(), admin.disconnect()]);
        throw new FixtureInitError('kafka', 'connect', { brokerAddress, driver: kafka.driver, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
    }

    const closeConsumer = async (consumer: KafkaConsumerLike) => {
        consumers.delete(consumer);
        await consumer.stop().catch(() => undefined);
        await consumer.disconnect().catch(() => undefined);
    };

    return {
        driver: kafka.driver,

        /**
         * Produce messages to a Kafka topic.
         * Throws FixtureOperationError with topic on failure.
         */
        async produce(topic, messages) {
            try {
                await producer.send({ topic, messages: messages.map((msg) => ({ key: msg.key ?? null, value: msg.value })) });
            } catch (error) {
                throw new FixtureOperationError('kafka', 'produce', { topic, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
            }
        },

        /**
         * Consume messages from a Kafka topic.
         * Returns an empty array if the topic doesn't exist or the timeout expires with no messages received.
         */
        async consume(topic, options) {
            const timeout = options?.timeout ?? 30000;
            const maxCount = options?.count;
            const messages: KafkaMessage[] = [];

            // A topic that doesn't exist has no messages: return at once instead of waiting out the timeout.
            const topics = await admin.listTopics().catch(() => undefined);
            if (topics && !topics.includes(topic)) return [];

            // Offsets are committed by hand, for the messages returned only: both libraries fetch
            // ahead, and an auto-commit would also cover messages read after `count` was reached.
            const consumer = kafka.consumer({ groupId, fromBeginning: options?.fromBeginning ?? false, autoCommit: false });
            consumers.add(consumer);
            try {
                await consumer.connect();
                await consumer.subscribe({ topic });
            } catch (error) {
                await closeConsumer(consumer);
                if (!topics) return []; // metadata unavailable: same as an unknown topic
                throw new FixtureOperationError('kafka', 'consume', { topic, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
            }

            await new Promise<void>((resolve) => {
                let resolved = false;
                const finish = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeoutHandle);
                    resolve();
                };
                const timeoutHandle = setTimeout(finish, timeout);
                consumer.run({
                    eachMessage: async ({ topic: msgTopic, partition, message }) => {
                        if (resolved || (maxCount !== undefined && messages.length >= maxCount)) return;
                        messages.push({
                            key: message.key ? message.key.toString() : null,
                            value: message.value ? message.value.toString() : '',
                            topic: msgTopic,
                            partition,
                            offset: message.offset,
                        });
                        if (maxCount !== undefined && messages.length >= maxCount) finish();
                    },
                }).catch(finish);
            });
            // Commit what was returned, so the next consume() in this test goes on from there.
            const next = new Map<number, number>();
            for (const m of messages) next.set(m.partition, Math.max(next.get(m.partition) ?? 0, Number(m.offset) + 1));
            if (next.size) {
                await consumer.commitOffsets([...next].map(([partition, offset]) => ({ topic, partition, offset: String(offset) }))).catch(() => undefined);
            }
            await closeConsumer(consumer);
            return maxCount !== undefined ? messages.slice(0, maxCount) : messages;
        },

        /**
         * Disconnect producer, admin and any consumer still open, within the disconnect timeout.
         */
        async disconnect() {
            await withTimeout(async () => {
                await Promise.allSettled([...consumers].map(closeConsumer));
                await Promise.allSettled([producer.disconnect(), admin.disconnect()]);
            }, disconnectTimeout);
        },
    };
}

/** Runs `work`, giving up (without failing) after `timeout` ms. */
async function withTimeout(work: () => Promise<void>, timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work(), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout); })]);
    clearTimeout(timer);
}

/**
 * Kafka fixture definition for use with Playwright's test.extend().
 *
 * Lifecycle:
 * 1. Setup: connect the producer and an admin client on the configured driver
 * 2. Provide KafkaClient to test via `use()`; consume() connects a consumer in the test's own group
 * 3. Teardown: disconnect everything (within 5s, then give up)
 */
export const kafkaFixture = {
    kafkaClient: async (
        { kafka: kafkaConfig, stagehandContainers }: { kafka: KafkaFixtureConfig | undefined; stagehandContainers: ContainerManager },
        use: (client: KafkaClient) => Promise<void>,
        testInfo: { testId: string }
    ) => {
        // Use config from project `use` block if provided, otherwise fall back to env vars
        // With `container` set, start (or reuse) this worker's Kafka broker.
        const config = await stagehandContainers.kafka(kafkaConfig ?? getKafkaConfig());
        let kafka: KafkaLike;
        try {
            kafka = await createKafka(config, { clientId: config.clientId ?? 'playwright-test' });
        } catch (error) {
            if ((error as Error).name === 'MissingPackageError') throw error;
            throw new FixtureInitError('kafka', 'connect', { brokerAddress: config.brokers.join(','), reason: reasonOf(error) }, error instanceof Error ? error : undefined);
        }
        const client = await createKafkaClient(kafka, config, generateGroupId(testInfo.testId));
        try {
            await use(client);
        } finally {
            await client.disconnect();
        }
    },
};

/**
 * Reads Kafka configuration from environment variables or returns defaults.
 */
function getKafkaConfig(): KafkaFixtureConfig {
    const brokersEnv = process.env.PW_KAFKA_BROKERS;
    const brokers = brokersEnv ? brokersEnv.split(',').map((b) => b.trim()) : ['localhost:9092'];

    const config: KafkaFixtureConfig = {
        brokers,
        clientId: process.env.PW_KAFKA_CLIENT_ID ?? 'playwright-test',
        ssl: process.env.PW_KAFKA_SSL === 'true',
        disconnectTimeout: process.env.PW_KAFKA_DISCONNECT_TIMEOUT
            ? parseInt(process.env.PW_KAFKA_DISCONNECT_TIMEOUT, 10)
            : 5000,
        container: process.env.PW_KAFKA_CONTAINER ? parseContainerEnv(process.env.PW_KAFKA_CONTAINER) : undefined,
        ...(process.env.PW_KAFKA_DRIVER ? { driver: kafkaDriverOf({}, process.env) } : {}),
    };

    return config;
}
