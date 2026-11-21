/**
 * Shared AWS settings for the S3 and SQS/SNS fixtures: one config turns into
 * the client options every AWS SDK v3 client takes, and resolves the same
 * way for both fixtures.
 */

import type { AwsFixtureConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';

export const DEFAULT_AWS_TIMEOUT = 10_000;
export const DEFAULT_S3_PREFIX = 'propmaster-tests/';

/** The options every AWS SDK v3 client constructor takes. */
export interface AwsClientOptions {
    region: string;
    endpoint?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    profile?: string;
    forcePathStyle?: boolean;
}

/**
 * Client options for a config. With an `endpoint` (an emulator) the region
 * defaults to us-east-1 and the credentials to `test`/`test`, so a test run
 * never picks up real credentials from the machine by accident. Without one,
 * the standard AWS chain supplies whatever the config leaves out.
 */
export function awsClientOptions(config: AwsFixtureConfig, env: NodeJS.ProcessEnv = process.env): AwsClientOptions {
    const region = config.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? (config.endpoint ? 'us-east-1' : undefined);
    if (!region) {
        throw new FixtureInitError('aws', 'connect', {
            reason: 'AWS configuration has no region: set PW_AWS_REGION (or AWS_REGION), PW_AWS_ENDPOINT for an emulator, PW_AWS_CONTAINER=true, or aws in environments.json or the project use block.',
        });
    }
    const options: AwsClientOptions = { region };
    if (config.endpoint) options.endpoint = config.endpoint;
    if (config.accessKeyId || config.secretAccessKey) {
        if (!config.accessKeyId || !config.secretAccessKey) {
            throw new FixtureInitError('aws', 'connect', { reason: 'set both accessKeyId and secretAccessKey (PW_AWS_ACCESS_KEY_ID, PW_AWS_SECRET_ACCESS_KEY), or neither to use the standard AWS chain.' });
        }
        options.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}) };
    } else if (config.endpoint && !config.profile) {
        options.credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
    }
    if (config.profile) options.profile = config.profile;
    options.forcePathStyle = config.forcePathStyle ?? Boolean(config.endpoint);
    return options;
}

/** The AWS config: the project option, else ConfigLoader (environments.json, .env, PW_AWS_*), else the standard chain alone. */
export async function resolveAwsConfig(aws: AwsFixtureConfig | undefined): Promise<AwsFixtureConfig> {
    if (aws) return aws;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().aws ?? {};
    } catch {
        // no environments.json: rely on AWS_REGION and the standard chain
        return {};
    }
}

export const reasonOf = (error: unknown): string => {
    if (!(error instanceof Error)) return String(error);
    const e = error as Error & { Code?: string; $metadata?: { httpStatusCode?: number } };
    const code = e.Code ?? (e.name !== 'Error' ? e.name : undefined);
    return code && !e.message.includes(code) ? `${code}: ${e.message}` : e.message;
};

/** True when an SDK error is a "doesn't exist" (404, NoSuchKey, NoSuchBucket, NonExistentQueue, NotFound). */
export function isNotFound(error: unknown): boolean {
    const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
    if (!e) return false;
    return e.$metadata?.httpStatusCode === 404
        || /^(NoSuchKey|NoSuchBucket|NotFound|NonExistentQueue|AWS\.SimpleQueueService\.NonExistentQueue|QueueDoesNotExist)$/.test(e.name ?? e.Code ?? '');
}

/** A body for S3 or SQS: a string or Buffer as is, anything else as JSON. */
export type AwsBody = string | Buffer | Uint8Array | Record<string, unknown> | unknown[] | number | boolean | null;

/** Encodes a body and the content type it implies. */
export function encodeAwsBody(body: AwsBody, contentType?: string): { content: Buffer; contentType?: string } {
    if (Buffer.isBuffer(body)) return { content: body, contentType };
    if (body instanceof Uint8Array) return { content: Buffer.from(body), contentType };
    if (typeof body === 'string') return { content: Buffer.from(body, 'utf8'), contentType: contentType ?? 'text/plain' };
    if (body === undefined) throw new TypeError('body is undefined');
    return { content: Buffer.from(JSON.stringify(body), 'utf8'), contentType: contentType ?? 'application/json' };
}

/** `JSON.parse` that names what it was parsing when it fails. */
export function parseJson<T>(text: string, fixture: string, details: Record<string, unknown>): T {
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new FixtureOperationError(fixture, 'json', {
            ...details,
            reason: `the body isn't JSON (${(error as Error).message}): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`,
        });
    }
}

/** Waits `ms` milliseconds. */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
