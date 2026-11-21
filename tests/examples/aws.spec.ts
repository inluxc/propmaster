/**
 * AWS Fixtures (S3, SQS, SNS) — Example Tests
 *
 * Shows how to write and wait for S3 objects with `s3Client`, and send,
 * receive and listen for messages with `sqsClient`, plus the S3Steps and
 * SqsSteps classes. S3 tests write under the test's own prefix in the default
 * bucket; queues and topics get unique names. The fixtures delete it all
 * afterwards.
 *
 * Prerequisites:
 *   - An AWS emulator or test account: PW_AWS_ENDPOINT (Moto or LocalStack,
 *     e.g. http://localhost:4566), PW_AWS_CONTAINER=true, or `aws` in
 *     environments.json
 *   - PW_AWS_S3_BUCKET: the default bucket (created here if it's missing)
 *   - `docker compose -f compose.test.yaml up -d --wait moto` runs Moto locally
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from '../../src';
import { S3Steps, SqsSteps } from '../../src/steps';

test.describe('AWS Fixture Examples — S3', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test.beforeEach(async ({ s3Client }) => {
        await s3Client.createBucket(s3Client.bucket!, { keep: true });
    });

    test('[TC-AWS-001] write and read text, JSON and binary objects', { tag: ['@TC-AWS-001'] }, async ({ s3Client }) => {
        await test.step('Step 1: Write three objects under the test prefix', async () => {
            await s3Client.putObject(s3Client.key('notes.txt'), 'hello');
            await s3Client.putObject(s3Client.key('order.json'), { orderId: 'o-1', total: 42 }, { metadata: { source: 'checkout' } });
            await s3Client.putObject(s3Client.key('logo.bin'), Buffer.from([0, 1, 2, 255]), { contentType: 'application/octet-stream' });
        });

        await test.step('Step 2: Verify each body and its content type', async () => {
            const text = await s3Client.getObject(s3Client.key('notes.txt'));
            expect(text.text()).toBe('hello');
            expect(text.contentType).toBe('text/plain');

            const json = await s3Client.getObject(s3Client.key('order.json'));
            expect(json.json()).toEqual({ orderId: 'o-1', total: 42 });
            expect(json.contentType).toBe('application/json');
            expect(json.metadata).toEqual({ source: 'checkout' });

            const binary = await s3Client.getObject(s3Client.key('logo.bin'));
            expect([...binary.content]).toEqual([0, 1, 2, 255]);
            expect(binary.size).toBe(4);
        });
    });

    test('[TC-AWS-002] wait for an object the application writes later', { tag: ['@TC-AWS-002'] }, async ({ s3Client }) => {
        const s3 = new S3Steps(s3Client);
        const key = s3Client.key('exports/report.json');

        await test.step('Step 1: Start an export that writes its file after a second', async () => {
            // Stands in for the application: it writes the file on its own schedule.
            setTimeout(() => void s3Client.putObject(key, { rows: 3, status: 'done' }), 1000);
        });

        await s3.expectJsonObject('Verify the export file appears with its content', key, { status: 'done' });
        await s3.expectKeys('Verify it is the only file under the test prefix', [key]);
    });

    test('[TC-AWS-003] waiting for an object that never comes names the keys that are there', { tag: ['@TC-AWS-003'] }, async ({ s3Client }) => {
        await test.step('Step 1: Write a file next to the one the test waits for', async () => {
            await s3Client.putObject(s3Client.key('in/2026-11-20.csv'), 'a,b');
        });

        await test.step('Step 2: Verify the wait times out and lists the file that is there', async () => {
            await expect(s3Client.waitForObject(s3Client.key('in/2026-11-21.csv'), { timeout: 600 }))
                .rejects.toThrow(/didn't appear within 600 ms: 1 key\(s\) under \S+\/in\/: \S+\/in\/2026-11-20\.csv/);
        });
    });

    test('[TC-AWS-004] list, check and delete objects', { tag: ['@TC-AWS-004'] }, async ({ s3Client }) => {
        const s3 = new S3Steps(s3Client);
        const [a, b, c] = ['a.txt', 'b.txt', 'sub/c.txt'].map((name) => s3Client.key(name));

        await s3.putObject('Write the first file', a, 'A');
        await s3.putObject('Write the second file', b, 'B');
        await s3.putObject('Write a file in a sub-folder', c, 'C');

        await test.step('Step 1: Verify the listing and the object info', async () => {
            const listed = await s3Client.listObjects();
            expect(listed.map((o) => o.key)).toEqual([a, b, c]);
            expect(await s3Client.headObject(a)).toMatchObject({ key: a, size: 1, contentType: 'text/plain' });
            expect(await s3Client.headObject(s3Client.key('missing.txt'))).toBeNull();
        });

        await test.step('Step 2: Delete one file and a sub-folder', async () => {
            await s3Client.deleteObject(a);
            expect(await s3Client.deletePrefix(s3Client.key('sub/'))).toBe(1);
        });

        await s3.expectNoObject('Verify the deleted file is gone', a);
        await s3.expectKeys('Verify only the second file is left', [b]);
    });
});

test.describe('AWS Fixture Examples — SQS and SNS', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-AWS-005] send and receive queue messages with attributes', { tag: ['@TC-AWS-005'] }, async ({ sqsClient, testData }) => {
        const sqs = new SqsSteps(sqsClient);
        const queue = testData.unique('jobs');

        await test.step('Step 1: Create a queue and send three jobs', async () => {
            await sqsClient.createQueue(queue);
            for (const n of [1, 2, 3]) await sqsClient.send(queue, { job: n }, { attributes: { priority: n, source: 'tests' } });
        });

        const taken = await sqs.receiveExpectMessages('Receive two jobs', queue, { count: 2 });

        await test.step('Step 2: Verify the bodies and attributes', async () => {
            expect(taken.map((m) => m.json<{ job: number }>().job).sort()).toHaveLength(2);
            expect(taken[0].attributes.source).toBe('tests');
            expect(Number(taken[0].attributes.priority)).toBe(taken[0].json<{ job: number }>().job);
        });

        await sqs.expectQueueDepth('Verify one job is left', queue, 1);
    });

    test('[TC-AWS-006] purge empties a queue', { tag: ['@TC-AWS-006'] }, async ({ sqsClient, testData }) => {
        const sqs = new SqsSteps(sqsClient);
        const queue = testData.unique('backlog');

        await test.step('Step 1: Fill a queue with leftover messages', async () => {
            await sqsClient.createQueue(queue);
            for (const n of [1, 2, 3, 4]) await sqsClient.send(queue, `old ${n}`);
        });

        await sqs.expectQueueDepth('Verify the queue holds four messages', queue, 4);

        await test.step('Step 2: Purge the queue and verify nothing arrives', async () => {
            await sqsClient.purge(queue);
            expect(await sqsClient.receive(queue, { timeout: 1000 })).toEqual([]);
        });
    });

    test('[TC-AWS-007] a listener receives what is published to a topic', { tag: ['@TC-AWS-007'] }, async ({ sqsClient, testData }) => {
        const sqs = new SqsSteps(sqsClient);
        const topic = testData.unique('orders');
        const orderId = randomUUID();

        await test.step('Step 1: Create a topic', async () => {
            await sqsClient.createTopic(topic);
        });

        const listener = await sqs.listen('Listen on the topic', topic);

        await sqs.publish('Publish an order.created event', topic, { orderId, total: 42 }, {
            subject: 'order.created',
            attributes: { eventType: 'order.created' },
        });

        const event = await sqs.expectMessage('Wait for the event for this order', listener, (m) => m.json<{ orderId: string }>().orderId === orderId);

        await test.step('Step 2: Verify the body, subject and attributes', async () => {
            expect(event.json()).toEqual({ orderId, total: 42 });
            expect(event.subject).toBe('order.created');
            expect(event.attributes.eventType).toBe('order.created');
            expect(event.topicArn).toBe(listener.topicArn);
        });
    });

    test('[TC-AWS-008] a filter policy keeps other events out of the listener', { tag: ['@TC-AWS-008'] }, async ({ sqsClient, testData }) => {
        const sqs = new SqsSteps(sqsClient);
        const topic = testData.unique('notifications');
        let topicArn = '';

        await test.step('Step 1: Create a topic', async () => {
            topicArn = await sqsClient.createTopic(topic);
        });

        const listener = await sqs.listen('Listen for e-mail notifications only', topicArn, { filterPolicy: { channel: ['email'] } });

        await sqs.publish('Publish an SMS notification', topicArn, 'sms body', { attributes: { channel: 'sms' } });
        await sqs.publish('Publish an e-mail notification', topicArn, 'email body', { attributes: { channel: 'email' } });

        await sqs.expectMessage('Verify the e-mail notification arrives', listener, (m) => m.body === 'email body');
        await sqs.expectNoMessage('Verify the SMS notification does not', listener, (m) => m.body === 'sms body', 1000);
    });

    test('[TC-AWS-009] waiting for a topic message that never comes fails with what arrived', { tag: ['@TC-AWS-009'] }, async ({ sqsClient, testData }) => {
        const topic = testData.unique('audit');
        let listener!: Awaited<ReturnType<typeof sqsClient.listen>>;

        await test.step('Step 1: Listen on a topic and publish an unrelated event', async () => {
            await sqsClient.createTopic(topic);
            listener = await sqsClient.listen(topic);
            await sqsClient.publish(topic, 'user logged in', { subject: 'audit.login' });
            await listener.messages({ count: 1, timeout: 5000 });
        });

        await test.step('Step 2: Verify the wait times out and names the message that did arrive', async () => {
            await expect(listener.waitForMessage((m) => m.subject === 'audit.logout', { timeout: 500 }))
                .rejects.toThrow(/no matching message within 500 ms: 1 message\(s\) arrived, none matching: audit\.login: user logged in/);
        });
    });
});

// Run in order in one worker: the second test checks what the first left behind.
test.describe.serial('AWS Fixture Examples — cleanup', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    const suffix = randomUUID().slice(0, 8);
    const bucket = `cleanup-${suffix}`;
    const queue = `cleanup-q-${suffix}`;
    const topic = `cleanup-t-${suffix}`;
    const sharedKey = `shared/settings-${suffix}.json`;
    let testPrefix = '';

    test('[TC-AWS-010] create a bucket, a queue, a topic and objects', { tag: ['@TC-AWS-010'] }, async ({ s3Client, sqsClient }) => {
        await test.step('Step 1: Put a shared file in the default bucket that must survive the next test', async () => {
            await s3Client.createBucket(s3Client.bucket!, { keep: true });
            await s3Client.putObject(sharedKey, { theme: 'light' }, { keep: true });
        });

        await test.step('Step 2: Create everything through the clients', async () => {
            await s3Client.createBucket(bucket);
            await s3Client.putObject('report.csv', 'a,b', { bucket });
            await s3Client.putObject(s3Client.key('upload.txt'), 'x');
            await s3Client.putObject(sharedKey, { theme: 'dark' });
            await sqsClient.createQueue(queue);
            await sqsClient.send(queue, 'left behind');
            await sqsClient.createTopic(topic);
            testPrefix = s3Client.prefix;
        });

        await test.step('Step 3: Verify they exist during the test', async () => {
            expect(await s3Client.bucketExists(bucket)).toBe(true);
            expect(await s3Client.exists(s3Client.key('upload.txt'))).toBe(true);
            expect((await s3Client.getObject(sharedKey)).json()).toEqual({ theme: 'dark' });
            expect(await sqsClient.checkQueue(queue)).not.toBeNull();
        });
    });

    test('[TC-AWS-011] what the previous test created was removed, and the shared file put back', { tag: ['@TC-AWS-011'] }, async ({ s3Client, sqsClient }) => {
        await test.step('Step 1: Verify the bucket, the prefix and the queue are gone', async () => {
            expect(await s3Client.bucketExists(bucket)).toBe(false);
            expect(await s3Client.listObjects(testPrefix)).toEqual([]);
            expect(await sqsClient.checkQueue(queue)).toBeNull();
            await expect(sqsClient.topicArn(topic)).rejects.toThrow(/doesn't exist/);
        });

        await test.step('Step 2: Verify the shared file has its previous content', async () => {
            expect((await s3Client.getObject(sharedKey)).json()).toEqual({ theme: 'light' });
            await s3Client.deleteObject(sharedKey);
        });
    });
});
