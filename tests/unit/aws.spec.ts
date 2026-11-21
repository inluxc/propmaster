/**
 * Unit tests for the AWS fixtures: client options, bodies, the S3 test
 * prefix, SQS/SNS message attributes and envelopes, PW_AWS_* variables and the
 * Moto container spec. The service behaviour itself is covered by
 * tests/examples/aws.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { awsClientOptions, encodeAwsBody, isNotFound } from '../../src/fixtures/aws';
import { createS3Client, parentPrefix, s3TestPrefix } from '../../src/fixtures/s3.fixture';
import { fromMessageAttributes, parseSnsEnvelope, snsDeliveryPolicy, toMessageAttributes } from '../../src/fixtures/sqs.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { ContainerManager, DEFAULT_IMAGES, motoSpec } from '../../src/containers/container-manager';
import { FixtureInitError, FixtureOperationError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _s3 = AssertHasKey<FixtureTypes, 's3Client'>;
type _sqs = AssertHasKey<FixtureTypes, 'sqsClient'>;

test.describe('aws — client options', () => {
    test('an endpoint defaults to us-east-1, test credentials and path-style URLs', () => {
        expect(awsClientOptions({ endpoint: 'http://localhost:5000' }, {})).toEqual({
            region: 'us-east-1',
            endpoint: 'http://localhost:5000',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            forcePathStyle: true,
        });
    });

    test('without an endpoint the standard chain supplies the credentials', () => {
        expect(awsClientOptions({}, { AWS_REGION: 'eu-west-1' })).toEqual({ region: 'eu-west-1', forcePathStyle: false });
        expect(awsClientOptions({}, { AWS_DEFAULT_REGION: 'eu-central-1' }).region).toBe('eu-central-1');
        expect(awsClientOptions({ profile: 'tests' }, { AWS_REGION: 'eu-west-1' })).toMatchObject({ profile: 'tests' });
    });

    test('the config wins over the environment, and static credentials are passed on', () => {
        const options = awsClientOptions({ region: 'ap-south-1', accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't', forcePathStyle: true }, { AWS_REGION: 'eu-west-1' });
        expect(options).toEqual({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' }, forcePathStyle: true });
    });

    test('a profile with an endpoint is used instead of the test credentials', () => {
        expect(awsClientOptions({ endpoint: 'http://ls:4566', profile: 'localstack' }, {}).credentials).toBeUndefined();
    });

    test('no region says what to set; half a key pair is refused', () => {
        expect(() => awsClientOptions({}, {})).toThrow(FixtureInitError);
        expect(() => awsClientOptions({}, {})).toThrow(/PW_AWS_REGION/);
        expect(() => awsClientOptions({ region: 'eu-west-1', accessKeyId: 'AKIA' }, {})).toThrow(/both accessKeyId and secretAccessKey/);
    });

    test('recognises "doesn\'t exist" errors', () => {
        expect(isNotFound({ name: 'NoSuchKey' })).toBe(true);
        expect(isNotFound({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe(true);
        expect(isNotFound({ name: 'QueueDoesNotExist' })).toBe(true);
        expect(isNotFound({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
        expect(isNotFound(null)).toBe(false);
    });
});

test.describe('aws — bodies', () => {
    test('strings as text/plain, objects as JSON, binary as it is', () => {
        expect(encodeAwsBody('hi')).toEqual({ content: Buffer.from('hi'), contentType: 'text/plain' });
        expect(encodeAwsBody({ a: 1 })).toEqual({ content: Buffer.from('{"a":1}'), contentType: 'application/json' });
        expect(encodeAwsBody(Buffer.from([1]))).toEqual({ content: Buffer.from([1]), contentType: undefined });
        expect(encodeAwsBody(new Uint8Array([2]))).toEqual({ content: Buffer.from([2]), contentType: undefined });
        expect(encodeAwsBody('<a/>', 'application/xml').contentType).toBe('application/xml');
        expect(() => encodeAwsBody(undefined as never)).toThrow(/undefined/);
    });
});

test.describe('aws — S3', () => {
    test('the per-test prefix is the root plus the run ID', () => {
        expect(s3TestPrefix(undefined, 't0-abc')).toBe('propmaster-tests/t0-abc/');
        expect(s3TestPrefix('ci/run-7', 't1-def')).toBe('ci/run-7/t1-def/');
        expect(s3TestPrefix('ci/', 't1-def')).toBe('ci/t1-def/');
        expect(s3TestPrefix('', 't1-def')).toBe('t1-def/');
    });

    test('the parent prefix of a key', () => {
        expect(parentPrefix('a/b/c.txt')).toBe('a/b/');
        expect(parentPrefix('c.txt')).toBe('');
    });

    test('key() puts a name under the prefix; a call without a bucket says what to set', async () => {
        const client = await createS3Client({ endpoint: 'http://127.0.0.1:1' }, { runId: 't9-0000' });
        expect(client.prefix).toBe('propmaster-tests/t9-0000/');
        expect(client.key('/out/a.json')).toBe('propmaster-tests/t9-0000/out/a.json');
        await expect(client.putObject('k', 'v')).rejects.toThrow(FixtureOperationError);
        await expect(client.putObject('k', 'v')).rejects.toThrow(/PW_AWS_S3_BUCKET/);
        await expect(client.deletePrefix('', { bucket: 'b' })).rejects.toThrow(/empty prefix/);
        client.close();
    });
});

test.describe('aws — SQS and SNS', () => {
    test('message attributes go out typed and come back as strings', () => {
        expect(toMessageAttributes({ source: 'tests', priority: 2, blob: Buffer.from('x') })).toEqual({
            source: { DataType: 'String', StringValue: 'tests' },
            priority: { DataType: 'Number', StringValue: '2' },
            blob: { DataType: 'Binary', BinaryValue: Buffer.from('x') },
        });
        expect(toMessageAttributes(undefined)).toBeUndefined();
        expect(fromMessageAttributes({ a: { StringValue: '1' }, b: { BinaryValue: Buffer.from('x') }, c: { Type: 'String', Value: 'v' } }))
            .toEqual({ a: '1', b: 'eA==', c: 'v' });
    });

    test('an SNS envelope becomes the message, subject and attributes', () => {
        const body = JSON.stringify({
            Type: 'Notification',
            MessageId: 'm-1',
            TopicArn: 'arn:aws:sns:us-east-1:000000000000:orders',
            Subject: 'order.created',
            Message: '{"orderId":"o-1"}',
            Timestamp: '2026-11-21T10:00:00.000Z',
            MessageAttributes: { eventType: { Type: 'String', Value: 'order.created' } },
        });
        const m = parseSnsEnvelope(body, 'arn:fallback');
        expect(m).toMatchObject({ body: '{"orderId":"o-1"}', subject: 'order.created', messageId: 'm-1', topicArn: 'arn:aws:sns:us-east-1:000000000000:orders', attributes: { eventType: 'order.created' } });
        expect(m.json()).toEqual({ orderId: 'o-1' });
    });

    test('a raw (non-envelope) body is kept as the message; json() errors name the topic', () => {
        const m = parseSnsEnvelope('plain text', 'arn:aws:sns:us-east-1:0:t');
        expect(m.body).toBe('plain text');
        expect(m.topicArn).toBe('arn:aws:sns:us-east-1:0:t');
        expect(() => m.json()).toThrow(FixtureOperationError);
        expect(() => m.json()).toThrow(/arn:aws:sns:us-east-1:0:t.*isn't JSON.*plain text/);
    });

    test('the delivery policy lets only that topic send to the queue', () => {
        const policy = JSON.parse(snsDeliveryPolicy('arn:aws:sqs:us-east-1:0:q', 'arn:aws:sns:us-east-1:0:t'));
        expect(policy.Statement[0]).toMatchObject({
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: 'arn:aws:sqs:us-east-1:0:q',
            Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:sns:us-east-1:0:t' } },
        });
    });
});

test.describe('aws — configuration', () => {
    let dir: string;
    const saved = { ...process.env };

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-aws-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { aws: { region: 'eu-west-1', s3: { bucket: 'from-file', prefix: 'p/' } } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_AWS_* variables override environments.json', () => {
        Object.assign(process.env, {
            PW_AWS_REGION: 'us-east-1',
            PW_AWS_ENDPOINT: 'http://localhost:5000',
            PW_AWS_ACCESS_KEY_ID: 'AKIA',
            PW_AWS_SECRET_ACCESS_KEY: 's',
            PW_AWS_SESSION_TOKEN: 't',
            PW_AWS_PROFILE: 'tests',
            PW_AWS_FORCE_PATH_STYLE: 'true',
            PW_AWS_S3_BUCKET: 'from-env',
            PW_AWS_TIMEOUT: '2500',
            PW_AWS_CONTAINER: 'true',
        });
        expect(new ConfigLoader(dir).load('local').aws).toEqual({
            region: 'us-east-1',
            endpoint: 'http://localhost:5000',
            accessKeyId: 'AKIA',
            secretAccessKey: 's',
            sessionToken: 't',
            profile: 'tests',
            forcePathStyle: true,
            s3: { bucket: 'from-env', prefix: 'p/' },
            timeout: 2500,
            container: true,
        });
    });

    test('environments.json alone is enough', () => {
        expect(new ConfigLoader(dir).load('local').aws).toEqual({ region: 'eu-west-1', s3: { bucket: 'from-file', prefix: 'p/' } });
    });
});

test.describe('aws — Moto container', () => {
    test('uses a pinned Moto image with a health check on its API', () => {
        const spec = motoSpec({});
        expect(DEFAULT_IMAGES.moto).toMatch(/^motoserver\/moto:\d+\.\d+\.\d+$/);
        expect(spec.image).toBe(DEFAULT_IMAGES.moto);
        expect(spec.port).toBe(5000);
        expect(spec.healthCheck).toContain('/moto-api/');
        expect(motoSpec({ image: 'motoserver/moto:latest', startupTimeout: 90 })).toMatchObject({ image: 'motoserver/moto:latest', startupTimeoutMs: 90_000 });
    });

    test('the manager returns the config unchanged when container is off', async () => {
        const m = new ContainerManager();
        const config = { endpoint: 'http://ls:4566', container: false };
        expect(await m.aws(config)).toBe(config);
        await m.stopAll();
    });
});
