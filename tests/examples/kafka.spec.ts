/**
 * Kafka Fixture — Example Test
 *
 * Demonstrates how to use the Kafka client fixture to produce and consume
 * messages. Uses the KafkaSteps class for reusable step sequences.
 * The fixture handles producer/consumer lifecycle and teardown automatically.
 *
 * Prerequisites:
 *   - Kafka brokers configured via PW_KAFKA_BROKERS or environments.json
 *   - Kafka cluster running and accessible
 *
 * @requirements 7.3, 1.6
 */

import { test, expect } from '../../src';
import { KafkaSteps } from '../../src/steps';

test.describe('Kafka Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-KFK-001] produce messages to a topic', { tag: ['@TC-KFK-001'] }, async ({ kafkaClient }) => {
        const kafka = new KafkaSteps(kafkaClient);

        await kafka.produce('Produce two messages with keys to test-events topic', 'test-events', [
            { key: 'user-1', value: JSON.stringify({ event: 'login', userId: '1' }) },
            { key: 'user-2', value: JSON.stringify({ event: 'signup', userId: '2' }) },
        ]);
    });

    test('[TC-KFK-002] consume messages from a topic', { tag: ['@TC-KFK-002'] }, async ({ kafkaClient }) => {
        const kafka = new KafkaSteps(kafkaClient);
        const topic = 'test-notifications';

        await kafka.produce('Produce messages to the topic', topic, [
            { key: 'alert-1', value: 'System maintenance scheduled' },
            { key: 'alert-2', value: 'New feature released' },
        ]);

        await kafka.consumeExpectMessages(
            'Consume messages with timeout and fromBeginning options',
            topic,
            { timeout: 10000, count: 2, fromBeginning: true },
        );
    });

    test('[TC-KFK-003] consume returns empty array on timeout', { tag: ['@TC-KFK-003'] }, async ({ kafkaClient }) => {
        const kafka = new KafkaSteps(kafkaClient);

        await kafka.consumeExpectEmpty('Consume from an empty topic with short timeout', 'empty-topic', 2000);
    });

    test('[TC-KFK-004] a second consume goes on where the first stopped', { tag: ['@TC-KFK-004'] }, async ({ kafkaClient, testData }) => {
        const topic = testData.unique('orders');

        await test.step('Step 1: Produce three messages to a new topic', async () => {
            await kafkaClient.produce(topic, ['a', 'b', 'c'].map((value) => ({ key: null, value })));
        });

        await test.step('Step 2: Consume two from the beginning, then the rest', async () => {
            const first = await kafkaClient.consume(topic, { fromBeginning: true, count: 2, timeout: 15_000 });
            expect(first.map((m) => m.value)).toEqual(['a', 'b']);
            // The test's consumer group committed what it read, so this starts at c
            const rest = await kafkaClient.consume(topic, { fromBeginning: true, count: 1, timeout: 15_000 });
            expect(rest.map((m) => m.value)).toEqual(['c']);
        });
    });

    test('[TC-KFK-005] without fromBeginning only new messages arrive', { tag: ['@TC-KFK-005'] }, async ({ kafkaClient, testData }) => {
        const topic = testData.unique('events');

        await test.step('Step 1: Produce a message before consuming', async () => {
            await kafkaClient.produce(topic, [{ key: 'old', value: 'before' }]);
        });

        await test.step('Step 2: Produce another once the consumer is listening, and receive only that one', async () => {
            // The consumer joins its group within a few seconds; produce after that
            setTimeout(() => void kafkaClient.produce(topic, [{ key: 'new', value: 'after' }]), 6000);
            const messages = await kafkaClient.consume(topic, { count: 1, timeout: 20_000 });
            expect(messages.map((m) => [m.key, m.value])).toEqual([['new', 'after']]);
            expect(['kafkajs', 'confluent']).toContain(kafkaClient.driver);
        });
    });
});
