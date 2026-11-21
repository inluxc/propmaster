/**
 * AWS Step Classes
 *
 * Reusable steps for S3 (`S3Steps`) and SQS/SNS (`SqsSteps`). Each method runs
 * inside `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type { S3BucketOption, S3Client, S3Object, S3PutOptions, S3WaitOptions } from '../fixtures/s3.fixture.js';
import type {
    SnsListener,
    SnsListenOptions,
    SnsMessage,
    SnsPublishOptions,
    SnsWaitOptions,
    SqsClient,
    SqsMessage,
    SqsReceiveOptions,
    SqsSendOptions,
} from '../fixtures/sqs.fixture.js';
import type { AwsBody } from '../fixtures/aws.js';

export type { S3Client, S3Object } from '../fixtures/s3.fixture.js';
export type { SqsClient, SqsMessage, SnsListener, SnsMessage } from '../fixtures/sqs.fixture.js';

export class S3Steps {
    constructor(private s3Client: S3Client) {}

    /** Writes an object (undone after the test). */
    async putObject(description: string, key: string, body: AwsBody, options?: S3PutOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.s3Client.putObject(key, body, options);
        });
    }

    /** Waits until the object exists and returns it. */
    async expectObject(description: string, key: string, options?: S3WaitOptions): Promise<S3Object> {
        let object!: S3Object;
        await test.step(`Step: ${description}`, async () => {
            object = await this.s3Client.waitForObject(key, options);
        });
        return object;
    }

    /** Waits for the object and checks its JSON body contains `expected` (toMatchObject). */
    async expectJsonObject(description: string, key: string, expected: Record<string, unknown> | unknown[], options?: S3WaitOptions): Promise<S3Object> {
        let object!: S3Object;
        await test.step(`Step: ${description}`, async () => {
            object = await this.s3Client.waitForObject(key, options);
            expect(object.json(), `JSON body of s3://${object.bucket}/${key}`).toMatchObject(expected);
        });
        return object;
    }

    /** Checks that the object doesn't exist. */
    async expectNoObject(description: string, key: string, options?: S3BucketOption): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            expect(await this.s3Client.exists(key, options), `s3 key "${key}" exists`).toBe(false);
        });
    }

    /** Checks the keys under a prefix (default: the test's prefix), sorted. */
    async expectKeys(description: string, keys: string[], prefix?: string, options?: S3BucketOption): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const listed = (await this.s3Client.listObjects(prefix, options)).map((o) => o.key);
            expect(listed).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
        });
    }
}

export class SqsSteps {
    constructor(private sqsClient: SqsClient) {}

    /** Sends a message to a queue; returns its message ID. */
    async send(description: string, queue: string, body: AwsBody, options?: SqsSendOptions): Promise<string> {
        let id = '';
        await test.step(`Step: ${description}`, async () => {
            id = await this.sqsClient.send(queue, body, options);
        });
        return id;
    }

    /** Receives `count` messages (default 1) and checks they all arrived. */
    async receiveExpectMessages(description: string, queue: string, options?: SqsReceiveOptions): Promise<SqsMessage[]> {
        let messages: SqsMessage[] = [];
        await test.step(`Step: ${description}`, async () => {
            messages = await this.sqsClient.receive(queue, options);
            expect(messages.length, `messages received from queue "${queue}"`).toBe(options?.count ?? 1);
        });
        return messages;
    }

    /** Waits until a queue holds `count` visible messages (default timeout 10000 ms). */
    async expectQueueDepth(description: string, queue: string, count: number, timeout = 10_000): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await expect
                .poll(async () => (await this.sqsClient.checkQueue(queue))?.messages ?? null, { message: `messages in queue "${queue}"`, timeout })
                .toBe(count);
        });
    }

    /** Publishes to an SNS topic; returns the message ID. */
    async publish(description: string, topic: string, body: AwsBody, options?: SnsPublishOptions): Promise<string> {
        let id = '';
        await test.step(`Step: ${description}`, async () => {
            id = await this.sqsClient.publish(topic, body, options);
        });
        return id;
    }

    /** Subscribes a temporary queue to a topic. Call it before the action that publishes. */
    async listen(description: string, topic: string, options?: SnsListenOptions): Promise<SnsListener> {
        let listener!: SnsListener;
        await test.step(`Step: ${description}`, async () => {
            listener = await this.sqsClient.listen(topic, options);
        });
        return listener;
    }

    /**
     * Waits for a topic message matching `predicate`. Parallel tests share
     * topics, so match on something unique to this test.
     */
    async expectMessage(description: string, listener: SnsListener, predicate?: (message: SnsMessage) => boolean, options?: SnsWaitOptions): Promise<SnsMessage> {
        let message!: SnsMessage;
        await test.step(`Step: ${description}`, async () => {
            message = await listener.waitForMessage(predicate, options);
        });
        return message;
    }

    /** Checks that no topic message matching `predicate` arrives within `timeout` ms (default 2000). */
    async expectNoMessage(description: string, listener: SnsListener, predicate: (message: SnsMessage) => boolean = () => true, timeout = 2000): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await listener.messages({ count: Number.MAX_SAFE_INTEGER, timeout });
            const unexpected = listener.received.filter(predicate);
            expect(unexpected.map((m) => `${m.subject ? `${m.subject}: ` : ''}${m.body}`)).toEqual([]);
        });
    }
}
