/**
 * SQS and SNS fixture.
 *
 * `sqsClient` sends and receives SQS messages and checks what an application
 * published to an SNS topic:
 *
 * - `send()` / `receive()` / `purge()` / `checkQueue()` for queues.
 * - `publish()` to a topic, by ARN or name.
 * - `listen(topic)` subscribes a temporary SQS queue to the topic. The
 *   application's own subscribers still get their copies; the test reads its
 *   copy from the listener. The queue and subscription go when the test ends.
 * - Queues and topics made with `createQueue()` / `createTopic()` are deleted
 *   afterwards.
 *
 * Uses @aws-sdk/client-sqs and @aws-sdk/client-sns (SNS only when used),
 * optional peer dependencies loaded on first use.
 */

import { randomBytes } from 'node:crypto';
import type { MessageAttributeValue as SqsAttributeValue, SQSClient } from '@aws-sdk/client-sqs';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { AwsFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { loadOptional } from './optional-package.js';
import {
    awsClientOptions,
    DEFAULT_AWS_TIMEOUT,
    encodeAwsBody,
    isNotFound,
    parseJson,
    reasonOf,
    resolveAwsConfig,
    sleep,
    type AwsBody,
} from './aws.js';

type SqsSdk = typeof import('@aws-sdk/client-sqs');
type SnsSdk = typeof import('@aws-sdk/client-sns');

/** Message attributes: a string, a number, or a Buffer (binary). */
export type AwsMessageAttributes = Record<string, string | number | Buffer>;

export interface SqsSendOptions {
    /** Seconds before the message becomes visible (0–900). */
    delaySeconds?: number;
    attributes?: AwsMessageAttributes;
    /** FIFO queues: the message group (default: `default`). */
    groupId?: string;
    /** FIFO queues without content-based deduplication. */
    deduplicationId?: string;
}

export interface SqsReceiveOptions {
    /** Stop after this many messages (default: 1). */
    count?: number;
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
    /** Seconds a received message stays hidden from other consumers (default: the queue's). */
    visibilityTimeout?: number;
    /** Delete each message once received (default: true), as a consumer that processed it would. */
    delete?: boolean;
}

/** A message received from a queue. */
export interface SqsMessage {
    body: string;
    /** The body parsed as JSON; throws when it isn't JSON. */
    json<T = unknown>(): T;
    messageId: string;
    receiptHandle: string;
    /** Message attributes, as strings (binary ones base64). */
    attributes: Record<string, string>;
    /** System attributes: SentTimestamp, ApproximateReceiveCount, MessageGroupId, ... */
    systemAttributes: Record<string, string>;
}

/** A message published to an SNS topic, as a listener received it. */
export interface SnsMessage {
    /** The published message. */
    body: string;
    json<T = unknown>(): T;
    subject?: string;
    messageId: string;
    topicArn: string;
    /** Message attributes, as strings. */
    attributes: Record<string, string>;
    timestamp?: string;
}

export interface SqsQueueInfo {
    url: string;
    arn?: string;
    /** Messages ready to be received (approximate, as SQS reports it). */
    messages: number;
    /** Received but not yet deleted. */
    inFlight: number;
    /** Not yet visible (delayed). */
    delayed: number;
}

export interface SqsCreateQueueOptions extends KeepOption {
    /** Queue attributes, e.g. `{ VisibilityTimeout: '5', ContentBasedDeduplication: 'true' }`. A `.fifo` name sets FifoQueue. */
    attributes?: Record<string, string>;
}

export interface SnsPublishOptions {
    subject?: string;
    attributes?: AwsMessageAttributes;
    /** FIFO topics. */
    groupId?: string;
    deduplicationId?: string;
}

export interface SnsListenOptions {
    /** A subscription filter policy, e.g. `{ eventType: ['order.created'] }`. */
    filterPolicy?: Record<string, unknown>;
    /** Match the filter policy on message attributes (default) or on the message body. */
    filterPolicyScope?: 'MessageAttributes' | 'MessageBody';
}

export interface SnsWaitOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
}

/** A temporary queue subscribed to a topic. Deleted, with its subscription, when the test ends (or on `close()`). */
export interface SnsListener {
    readonly topicArn: string;
    readonly queueUrl: string;
    readonly subscriptionArn: string;
    /** Every message received so far, oldest first. */
    readonly received: readonly SnsMessage[];
    /** Waits until `count` messages (default 1) have arrived, or the timeout; returns what arrived. */
    messages(options?: { count?: number; timeout?: number }): Promise<SnsMessage[]>;
    /** The first message (received so far, or still to come) matching `predicate`. Throws on timeout, listing what arrived. */
    waitForMessage(predicate?: (message: SnsMessage) => boolean, options?: SnsWaitOptions): Promise<SnsMessage>;
    close(): Promise<void>;
}

export interface SqsClient {
    /** The URL of a queue, from its name (a URL is returned as is). */
    queueUrl(queue: string): Promise<string>;
    /** Sends a message; returns its message ID. A string is sent as is, anything else as JSON. */
    send(queue: string, body: AwsBody, options?: SqsSendOptions): Promise<string>;
    /** Receives up to `count` messages (default 1), deleting them unless `{ delete: false }`. Returns what arrived before the timeout. */
    receive(queue: string, options?: SqsReceiveOptions): Promise<SqsMessage[]>;
    /** Removes every message from a queue. On AWS, once per queue every 60 seconds. */
    purge(queue: string): Promise<void>;
    /** Message counts of a queue, or null when it doesn't exist. */
    checkQueue(queue: string): Promise<SqsQueueInfo | null>;
    /** Creates a queue; returns its URL. Deleted after the test unless `{ keep: true }` or it already existed. */
    createQueue(name: string, options?: SqsCreateQueueOptions): Promise<string>;
    /** Creates an SNS topic; returns its ARN. Deleted after the test unless `{ keep: true }` or it already existed. */
    createTopic(name: string, options?: KeepOption & { attributes?: Record<string, string> }): Promise<string>;
    /** The ARN of a topic, from its name (an ARN is returned as is). */
    topicArn(topic: string): Promise<string>;
    /** Publishes to an SNS topic (ARN or name); returns the message ID. */
    publish(topic: string, body: AwsBody, options?: SnsPublishOptions): Promise<string>;
    /** Subscribes a temporary queue to a topic (ARN or name). Only messages published after it resolves are received. */
    listen(topic: string, options?: SnsListenOptions): Promise<SnsListener>;
    /** The AWS SDK clients, for anything else (`sns` is created on first use). */
    readonly sdk: { sqs: SQSClient; sns(): Promise<SNSClient> };
    close(): Promise<void>;
}

/** SQS/SNS message attributes from plain values. */
export function toMessageAttributes(attributes: AwsMessageAttributes | undefined): Record<string, SqsAttributeValue> | undefined {
    if (!attributes) return undefined;
    return Object.fromEntries(Object.entries(attributes).map(([name, value]) => [
        name,
        Buffer.isBuffer(value)
            ? { DataType: 'Binary', BinaryValue: value }
            : typeof value === 'number'
                ? { DataType: 'Number', StringValue: String(value) }
                : { DataType: 'String', StringValue: value },
    ]));
}

/** Message attributes as strings (binary ones base64). */
export function fromMessageAttributes(attributes: Record<string, { StringValue?: string; BinaryValue?: Uint8Array; Value?: string; Type?: string }> | undefined): Record<string, string> {
    return Object.fromEntries(Object.entries(attributes ?? {}).map(([name, a]) => [
        name,
        a.StringValue ?? a.Value ?? (a.BinaryValue ? Buffer.from(a.BinaryValue).toString('base64') : ''),
    ]));
}

/** Turns an SNS notification delivered to SQS (the JSON envelope) into an SnsMessage. */
export function parseSnsEnvelope(body: string, topicArn: string): SnsMessage {
    let envelope: { Type?: string; MessageId?: string; TopicArn?: string; Subject?: string; Message?: string; Timestamp?: string; MessageAttributes?: Record<string, { Type?: string; Value?: string }> };
    try {
        envelope = JSON.parse(body);
    } catch {
        envelope = {};
    }
    const message = typeof envelope.Message === 'string' ? envelope.Message : body;
    return {
        body: message,
        json: <T>() => parseJson<T>(message, 'sns', { topicArn }),
        subject: envelope.Subject ?? undefined,
        messageId: envelope.MessageId ?? '',
        topicArn: envelope.TopicArn ?? topicArn,
        attributes: fromMessageAttributes(envelope.MessageAttributes),
        timestamp: envelope.Timestamp,
    };
}

/** The queue policy that lets an SNS topic deliver to a queue. */
export function snsDeliveryPolicy(queueArn: string, topicArn: string): string {
    return JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: queueArn,
            Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
        }],
    });
}

function describeArrived(messages: readonly { body: string; subject?: string }[]): string {
    if (messages.length === 0) return 'no messages arrived';
    const shown = messages.slice(-5).map((m) => `${m.subject ? `${m.subject}: ` : ''}${m.body.length > 120 ? `${m.body.slice(0, 120)}…` : m.body}`);
    return `${messages.length} message(s) arrived, none matching${messages.length > 5 ? ' (last 5)' : ''}: ${shown.join(' | ')}`;
}

/** Builds the client. `registry` records the undo for created queues and topics; without one nothing is cleaned up. */
export async function createSqsClient(config: AwsFixtureConfig, registry?: CleanupRegistry): Promise<SqsClient> {
    const sdkOptions = awsClientOptions(config);
    const sqsSdk = await loadOptional<SqsSdk>('@aws-sdk/client-sqs', 'sqsClient');
    const sqs = new sqsSdk.SQSClient(sdkOptions);
    let sns: Promise<{ lib: SnsSdk; client: SNSClient }> | undefined;
    const snsClient = () => (sns ??= loadOptional<SnsSdk>('@aws-sdk/client-sns', 'sqsClient (SNS)').then((lib) => ({ lib, client: new lib.SNSClient(sdkOptions) })));
    const timeoutDefault = config.timeout ?? DEFAULT_AWS_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;

    const fail = (fixture: 'sqs' | 'sns', operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        throw new FixtureOperationError(fixture, operation, { ...details, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
    };

    const urls = new Map<string, string>();
    const resolveUrl = async (queue: string): Promise<string> => {
        if (/^https?:\/\//.test(queue)) return queue;
        const known = urls.get(queue);
        if (known) return known;
        const { QueueUrl } = await sqs.send(new sqsSdk.GetQueueUrlCommand({ QueueName: queue }));
        urls.set(queue, QueueUrl!);
        return QueueUrl!;
    };
    const urlOr = async (fixture: 'sqs' | 'sns', operation: FixtureOperationError['operation'], queue: string) => {
        try {
            return await resolveUrl(queue);
        } catch (error) {
            const reason = isNotFound(error) ? `queue "${queue}" doesn't exist (${reasonOf(error)})` : reasonOf(error);
            return fail(fixture, operation, { queue }, new Error(reason));
        }
    };

    /** One receive call, long-polling for at most `waitMs` (whole seconds; 0 is a short poll). */
    const receiveOnce = async (url: string, max: number, waitMs: number, visibilityTimeout?: number) => {
        const r = await sqs.send(new sqsSdk.ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
            WaitTimeSeconds: Math.min(Math.floor(waitMs / 1000), 20),
            VisibilityTimeout: visibilityTimeout,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['All'],
        }));
        return r.Messages ?? [];
    };
    const deleteMessage = (url: string, receiptHandle: string) =>
        sqs.send(new sqsSdk.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }));

    /** Polls `url` until `done()` or the deadline, handing each message to `take`. */
    const pollUntil = async (url: string, deadline: number, done: () => boolean, take: (m: Awaited<ReturnType<typeof receiveOnce>>[number]) => Promise<void>, max: () => number, visibilityTimeout?: number) => {
        while (!done()) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const batch = await receiveOnce(url, max(), remaining, visibilityTimeout);
            for (const m of batch) await take(m);
            if (batch.length === 0 && remaining < 1000) await sleep(Math.min(100, remaining));
        }
    };

    const listeners = new Set<SnsListener>();

    const resolveTopicArn = async (topic: string): Promise<string> => {
        if (topic.startsWith('arn:')) return topic;
        const { lib, client } = await snsClient();
        let token: string | undefined;
        do {
            const page = await client.send(new lib.ListTopicsCommand({ NextToken: token }));
            const hit = page.Topics?.find((t) => t.TopicArn?.endsWith(`:${topic}`));
            if (hit?.TopicArn) return hit.TopicArn;
            token = page.NextToken;
        } while (token);
        throw new Error(`topic "${topic}" doesn't exist`);
    };

    const client: SqsClient = {
        sdk: { sqs, sns: async () => (await snsClient()).client },
        queueUrl: (queue) => urlOr('sqs', 'send', queue),

        async send(queue, body, o) {
            const url = await urlOr('sqs', 'send', queue);
            try {
                const { content } = encodeAwsBody(body);
                const fifo = url.endsWith('.fifo');
                const r = await sqs.send(new sqsSdk.SendMessageCommand({
                    QueueUrl: url,
                    MessageBody: content.toString('utf8'),
                    DelaySeconds: o?.delaySeconds,
                    MessageAttributes: toMessageAttributes(o?.attributes),
                    MessageGroupId: o?.groupId ?? (fifo ? 'default' : undefined),
                    MessageDeduplicationId: o?.deduplicationId,
                }));
                return r.MessageId ?? '';
            } catch (error) {
                return fail('sqs', 'send', { queue }, error);
            }
        },

        async receive(queue, o) {
            const url = await urlOr('sqs', 'receive', queue);
            const count = o?.count ?? 1;
            const out: SqsMessage[] = [];
            try {
                await pollUntil(url, Date.now() + (o?.timeout ?? timeoutDefault), () => out.length >= count, async (m) => {
                    if (out.length >= count) return; // extras become visible again after the visibility timeout
                    const body = m.Body ?? '';
                    out.push({
                        body,
                        json: <T>() => parseJson<T>(body, 'sqs', { queue, messageId: m.MessageId }),
                        messageId: m.MessageId ?? '',
                        receiptHandle: m.ReceiptHandle ?? '',
                        attributes: fromMessageAttributes(m.MessageAttributes),
                        systemAttributes: (m.Attributes ?? {}) as Record<string, string>,
                    });
                    if (o?.delete !== false && m.ReceiptHandle) await deleteMessage(url, m.ReceiptHandle);
                }, () => count - out.length, o?.visibilityTimeout);
            } catch (error) {
                return fail('sqs', 'receive', { queue }, error);
            }
            return out;
        },

        async purge(queue) {
            const url = await urlOr('sqs', 'purge', queue);
            try {
                await sqs.send(new sqsSdk.PurgeQueueCommand({ QueueUrl: url }));
            } catch (error) {
                return fail('sqs', 'purge', { queue }, error);
            }
        },

        async checkQueue(queue) {
            let url: string;
            try {
                url = await resolveUrl(queue);
                const { Attributes: a = {} } = await sqs.send(new sqsSdk.GetQueueAttributesCommand({
                    QueueUrl: url,
                    AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
                }));
                return {
                    url,
                    arn: a.QueueArn,
                    messages: Number(a.ApproximateNumberOfMessages ?? 0),
                    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
                    delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
                };
            } catch (error) {
                if (isNotFound(error)) {
                    urls.delete(queue);
                    return null;
                }
                return fail('sqs', 'checkQueue', { queue }, error);
            }
        },

        async createQueue(name, o) {
            const existed = (await client.checkQueue(name)) !== null;
            try {
                const attributes = { ...(name.endsWith('.fifo') ? { FifoQueue: 'true' } : {}), ...o?.attributes };
                const { QueueUrl } = await sqs.send(new sqsSdk.CreateQueueCommand({ QueueName: name, Attributes: attributes }));
                const url = QueueUrl!;
                urls.set(name, url);
                if (!existed && track(o)) {
                    registry!.add(`sqs queue ${name}`, async () => {
                        urls.delete(name);
                        await sqs.send(new sqsSdk.DeleteQueueCommand({ QueueUrl: url }));
                    });
                }
                return url;
            } catch (error) {
                return fail('sqs', 'createQueue', { queue: name }, error);
            }
        },

        async topicArn(topic) {
            try {
                return await resolveTopicArn(topic);
            } catch (error) {
                return fail('sns', 'publish', { topic }, error);
            }
        },

        async createTopic(name, o) {
            try {
                const { lib, client: snsc } = await snsClient();
                const existed = await resolveTopicArn(name).then(() => true, () => false);
                const attributes = { ...(name.endsWith('.fifo') ? { FifoTopic: 'true' } : {}), ...o?.attributes };
                const { TopicArn } = await snsc.send(new lib.CreateTopicCommand({ Name: name, Attributes: attributes }));
                if (!existed && track(o)) {
                    registry!.add(`sns topic ${name}`, async () => {
                        await snsc.send(new lib.DeleteTopicCommand({ TopicArn }));
                    });
                }
                return TopicArn!;
            } catch (error) {
                return fail('sns', 'createTopic', { topic: name }, error);
            }
        },

        async publish(topic, body, o) {
            try {
                const arn = await resolveTopicArn(topic);
                const { lib, client: snsc } = await snsClient();
                const { content } = encodeAwsBody(body);
                const r = await snsc.send(new lib.PublishCommand({
                    TopicArn: arn,
                    Message: content.toString('utf8'),
                    Subject: o?.subject,
                    MessageAttributes: toMessageAttributes(o?.attributes),
                    MessageGroupId: o?.groupId ?? (arn.endsWith('.fifo') ? 'default' : undefined),
                    MessageDeduplicationId: o?.deduplicationId,
                }));
                return r.MessageId ?? '';
            } catch (error) {
                return fail('sns', 'publish', { topic }, error);
            }
        },

        async listen(topic, o) {
            let topicArn: string;
            let queueUrl: string | undefined;
            let subscriptionArn: string | undefined;
            const { lib, client: snsc } = await snsClient().catch((error) => fail('sns', 'listen', { topic }, error));
            const teardown = async () => {
                if (subscriptionArn) await snsc.send(new lib.UnsubscribeCommand({ SubscriptionArn: subscriptionArn })).catch(() => {});
                if (queueUrl) await sqs.send(new sqsSdk.DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
            };
            try {
                topicArn = await resolveTopicArn(topic);
                const fifo = topicArn.endsWith('.fifo');
                const name = `propmaster-listen-${randomBytes(6).toString('hex')}${fifo ? '.fifo' : ''}`;
                ({ QueueUrl: queueUrl } = await sqs.send(new sqsSdk.CreateQueueCommand({
                    QueueName: name,
                    Attributes: { ...(fifo ? { FifoQueue: 'true' } : {}), MessageRetentionPeriod: '3600' },
                })));
                const { Attributes } = await sqs.send(new sqsSdk.GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
                const queueArn = Attributes!.QueueArn!;
                await sqs.send(new sqsSdk.SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: snsDeliveryPolicy(queueArn, topicArn) } }));
                const subscribeAttributes: Record<string, string> = {};
                if (o?.filterPolicy) subscribeAttributes.FilterPolicy = JSON.stringify(o.filterPolicy);
                if (o?.filterPolicyScope) subscribeAttributes.FilterPolicyScope = o.filterPolicyScope;
                ({ SubscriptionArn: subscriptionArn } = await snsc.send(new lib.SubscribeCommand({
                    TopicArn: topicArn,
                    Protocol: 'sqs',
                    Endpoint: queueArn,
                    ReturnSubscriptionArn: true,
                    Attributes: Object.keys(subscribeAttributes).length ? subscribeAttributes : undefined,
                })));
            } catch (error) {
                await teardown();
                return fail('sns', 'listen', { topic }, error);
            }

            const url = queueUrl!;
            const received: SnsMessage[] = [];
            let closed = false;
            const poll = (deadline: number, done: () => boolean) => pollUntil(url, deadline, done, async (m) => {
                received.push(parseSnsEnvelope(m.Body ?? '', topicArn));
                if (m.ReceiptHandle) await deleteMessage(url, m.ReceiptHandle);
            }, () => 10);

            const listener: SnsListener = {
                topicArn,
                queueUrl: url,
                subscriptionArn: subscriptionArn ?? '',
                get received() {
                    return received;
                },
                async messages(opts) {
                    const count = opts?.count ?? 1;
                    try {
                        await poll(Date.now() + (opts?.timeout ?? timeoutDefault), () => received.length >= count);
                    } catch (error) {
                        return fail('sns', 'waitForMessage', { topic: topicArn }, error);
                    }
                    return received.slice(0, Math.max(count, 0));
                },
                async waitForMessage(predicate = () => true, opts) {
                    const timeout = opts?.timeout ?? timeoutDefault;
                    let found: SnsMessage | undefined;
                    const done = () => (found = received.find((m) => predicate(m))) !== undefined;
                    try {
                        await poll(Date.now() + timeout, done);
                    } catch (error) {
                        return fail('sns', 'waitForMessage', { topic: topicArn }, error);
                    }
                    if (done() && found) return found;
                    return fail('sns', 'waitForMessage', { topic: topicArn, timeout }, new Error(`no matching message within ${timeout} ms: ${describeArrived(received)}`));
                },
                async close() {
                    if (closed) return;
                    closed = true;
                    listeners.delete(listener);
                    await teardown();
                },
            };
            listeners.add(listener);
            return listener;
        },

        async close() {
            for (const listener of [...listeners]) await listener.close();
            sqs.destroy();
            if (sns) (await sns.catch(() => undefined))?.client.destroy();
        },
    };
    return client;
}

/**
 * Fixture definition for test.extend(). Created queues and topics are deleted,
 * then the listeners' queues and subscriptions, then the SDK clients go.
 */
export const sqsFixture = {
    sqsClient: async (
        { aws, stagehandContainers, dataCleanup }: { aws: AwsFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: SqsClient) => Promise<void>,
    ) => {
        const config = await stagehandContainers.aws(await resolveAwsConfig(aws));
        let client: SqsClient;
        try {
            client = await createSqsClient(config, dataCleanup);
        } catch (error) {
            if (error instanceof FixtureInitError || (error as Error).name === 'MissingPackageError') throw error;
            throw new FixtureInitError('sqs', 'connect', { reason: reasonOf(error) }, error instanceof Error ? error : undefined);
        }
        let cleanupError: unknown;
        try {
            await use(client);
            await dataCleanup.flush();
        } catch (error) {
            cleanupError = error;
        }
        await client.close();
        if (cleanupError) throw cleanupError;
    },
};
