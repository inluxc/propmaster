/**
 * Unit tests for the Kafka drivers (kafkajs and Confluent's
 * @confluentinc/kafka-javascript) and the kafkaClient built on them, with
 * stand-in modules that record every call. The real libraries run against
 * a broker in tests/examples/kafka.spec.ts, on each driver (CI runs both).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { kafkaDriverOf, kafkaFromModule, type KafkaDriverName, type KafkaRawMessage } from '../../src/fixtures/kafka-driver';
import { createKafkaClient } from '../../src/fixtures/kafka.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { FixtureInitError, FixtureOperationError } from '../../src/errors';

type Call = [string, ...unknown[]];

/** A stand-in for either library: records calls, serves `messages` to consumers, lists `topics`. */
function fakeModule(driver: KafkaDriverName, options: { topics?: string[]; messages?: KafkaRawMessage[]; failConnect?: boolean; failSend?: boolean } = {}) {
    const calls: Call[] = [];
    const consumer = (config: unknown) => {
        calls.push(['consumer', config]);
        return {
            connect: async () => void calls.push(['consumer.connect']),
            disconnect: async () => void calls.push(['consumer.disconnect']),
            subscribe: async (s: unknown) => void calls.push(['subscribe', s]),
            run: async (r: { eachMessage: (p: { topic: string; partition: number; message: KafkaRawMessage }) => Promise<void>; autoCommit?: boolean }) => {
                calls.push(['run', { autoCommit: r.autoCommit }]);
                for (const message of options.messages ?? []) await r.eachMessage({ topic: 't', partition: 0, message });
            },
            stop: async () => {
                if (driver === 'confluent') throw new Error('Not implemented');
                calls.push(['consumer.stop']);
            },
            seek: (s: unknown) => void calls.push(['seek', s]),
            commitOffsets: async (o: unknown) => void calls.push(['commit', o]),
        };
    };
    const client = (config: unknown) => {
        calls.push(['Kafka', config]);
        return {
            producer: () => ({
                connect: async () => {
                    if (options.failConnect) throw new Error('connect ECONNREFUSED 127.0.0.1:9092');
                },
                disconnect: async () => void calls.push(['producer.disconnect']),
                send: async (r: unknown) => {
                    if (options.failSend) throw new Error('This server does not host this topic-partition');
                    calls.push(['send', r]);
                },
            }),
            admin: () => ({
                connect: async () => undefined,
                disconnect: async () => void calls.push(['admin.disconnect']),
                listTopics: async () => options.topics ?? ['t'],
                fetchTopicOffsets: async () => [],
                deleteGroups: async () => undefined,
            }),
            consumer,
        };
    };
    const logLevel = { NOTHING: 0, WARN: 2 };
    const Kafka = function (this: unknown, config: unknown) {
        return client(config);
    } as unknown as new (c: unknown) => ReturnType<typeof client>;
    const mod = driver === 'confluent' ? { KafkaJS: { Kafka, logLevel } } : { Kafka, logLevel };
    return { mod, calls };
}

const msg = (offset: number, value: string, key: string | null = null): KafkaRawMessage => ({
    key: key === null ? null : Buffer.from(key), value: Buffer.from(value), offset: String(offset), timestamp: '0',
});

const config = { brokers: ['localhost:9092'], sasl: { mechanism: 'plain' as const, username: 'u', password: 'p' } };

test.describe('kafka drivers — choosing one', () => {
    test('kafkajs by default; driver or PW_KAFKA_DRIVER picks Confluent; anything else is refused', () => {
        expect(kafkaDriverOf({}, {})).toBe('kafkajs');
        expect(kafkaDriverOf({}, { PW_KAFKA_DRIVER: 'confluent' })).toBe('confluent');
        expect(kafkaDriverOf({ driver: 'kafkajs' }, { PW_KAFKA_DRIVER: 'confluent' })).toBe('kafkajs');
        expect(() => kafkaDriverOf({ driver: 'rdkafka' as never }, {})).toThrow('unknown Kafka driver "rdkafka"; use kafkajs or confluent');
    });

    test('PW_KAFKA_DRIVER reaches the loaded config', () => {
        const saved = { ...process.env };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-kafka-'));
        try {
            fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { kafka: { brokers: ['k:9092'] } } } }));
            for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
            process.env.PW_KAFKA_DRIVER = 'confluent';
            expect(new ConfigLoader(dir).load('local').kafka).toEqual({ brokers: ['k:9092'], driver: 'confluent' });
        } finally {
            process.env = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test.describe('kafka drivers — options', () => {
    test('kafkajs: options at the top level; fromBeginning on subscribe, autoCommit on run, a short fetch wait', async () => {
        const { mod, calls } = fakeModule('kafkajs');
        const kafka = kafkaFromModule('kafkajs', mod, config, { clientId: 'c' });
        const consumer = kafka.consumer({ groupId: 'g', fromBeginning: true, autoCommit: false });
        await consumer.subscribe({ topic: 't' });
        await consumer.run({ eachMessage: async () => undefined });
        expect(calls).toEqual([
            ['Kafka', { clientId: 'c', brokers: ['localhost:9092'], ssl: false, sasl: config.sasl, logLevel: 2 }],
            ['consumer', { groupId: 'g', maxWaitTimeInMs: 250 }],
            ['subscribe', { topic: 't', fromBeginning: true }],
            ['run', { autoCommit: false }],
        ]);
    });

    test('Confluent: options in the kafkaJS block, consumer options at creation, topics as a list, no stop()', async () => {
        const { mod, calls } = fakeModule('confluent');
        const kafka = kafkaFromModule('confluent', mod, config, { clientId: 'c', log: 'nothing' });
        const consumer = kafka.consumer({ groupId: 'g', fromBeginning: true, autoCommit: false });
        await consumer.subscribe({ topic: 't' });
        await consumer.run({ eachMessage: async () => undefined });
        await expect(consumer.stop()).resolves.toBeUndefined();
        expect(kafka.driver).toBe('confluent');
        expect(calls).toEqual([
            ['Kafka', { kafkaJS: { clientId: 'c', brokers: ['localhost:9092'], ssl: false, sasl: config.sasl, logLevel: 0 } }],
            ['consumer', { kafkaJS: { groupId: 'g', fromBeginning: true, autoCommit: false } }],
            ['subscribe', { topics: ['t'] }],
            ['run', { autoCommit: undefined }],
        ]);
    });
});

for (const driver of ['kafkajs', 'confluent'] as const) {
    test.describe(`kafkaClient on ${driver}`, () => {
        test('consume stops at count, returns plain messages, and commits only what it returned', async () => {
            const { mod, calls } = fakeModule(driver, { messages: [msg(0, 'a', 'k'), msg(1, 'b'), msg(2, 'c')] });
            const client = await createKafkaClient(kafkaFromModule(driver, mod, config, { clientId: 'c' }), config, 'group-1');
            const got = await client.consume('t', { count: 2, fromBeginning: true, timeout: 1000 });
            expect(got).toEqual([
                { key: 'k', value: 'a', topic: 't', partition: 0, offset: '0' },
                { key: null, value: 'b', topic: 't', partition: 0, offset: '1' },
            ]);
            expect(calls).toContainEqual(['commit', [{ topic: 't', partition: 0, offset: '2' }]]);
            expect(calls.at(-1)).toEqual(['consumer.disconnect']);
            expect(client.driver).toBe(driver);
        });

        test('a topic that does not exist returns [] at once, without a consumer', async () => {
            const { mod, calls } = fakeModule(driver, { topics: ['other'] });
            const client = await createKafkaClient(kafkaFromModule(driver, mod, config, { clientId: 'c' }), config, 'g');
            const started = Date.now();
            expect(await client.consume('missing', { timeout: 10_000 })).toEqual([]);
            expect(Date.now() - started).toBeLessThan(1000);
            expect(calls.some(([name]) => name === 'consumer')).toBe(false);
        });

        test('nothing arriving returns [] after the timeout, and commits nothing', async () => {
            const { mod, calls } = fakeModule(driver);
            const client = await createKafkaClient(kafkaFromModule(driver, mod, config, { clientId: 'c' }), config, 'g');
            expect(await client.consume('t', { timeout: 50 })).toEqual([]);
            expect(calls.some(([name]) => name === 'commit')).toBe(false);
        });

        test('a refused connection is a FixtureInitError naming the brokers and driver; a failed send a FixtureOperationError', async () => {
            const refused = fakeModule(driver, { failConnect: true });
            const error = await createKafkaClient(kafkaFromModule(driver, refused.mod, config, { clientId: 'c' }), config, 'g').catch((e: unknown) => e);
            expect(error).toBeInstanceOf(FixtureInitError);
            expect((error as Error).message).toContain('localhost:9092');
            expect((error as Error).message).toContain(driver);

            const failing = fakeModule(driver, { failSend: true });
            const client = await createKafkaClient(kafkaFromModule(driver, failing.mod, config, { clientId: 'c' }), config, 'g');
            await expect(client.produce('t', [{ value: 'x' }])).rejects.toBeInstanceOf(FixtureOperationError);
            await expect(client.produce('t', [{ value: 'x' }])).rejects.toThrow(/topic="t"/);
        });

        test('disconnect closes the producer and the admin client', async () => {
            const { mod, calls } = fakeModule(driver);
            const client = await createKafkaClient(kafkaFromModule(driver, mod, config, { clientId: 'c' }), config, 'g');
            await client.disconnect();
            expect(calls).toEqual(expect.arrayContaining([['producer.disconnect'], ['admin.disconnect']]));
        });
    });
}
