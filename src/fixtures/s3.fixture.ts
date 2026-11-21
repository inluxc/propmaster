/**
 * S3 fixture.
 *
 * `s3Client` writes, reads and waits for objects, against an emulator (Moto,
 * LocalStack) or a real test account:
 *
 * - Every test gets its own key prefix (`s3Client.prefix`, from `key(name)`).
 *   Hand it to the application so the files a test causes are its own;
 *   everything under it is deleted when the test ends.
 * - `putObject()` outside the prefix is undone too: a new key is deleted, an
 *   overwritten one gets its previous content back.
 * - `waitForObject()` polls until the application has written a key, and
 *   fails with the keys that are there instead.
 * - Buckets made with `createBucket()` are emptied and deleted afterwards.
 *
 * Uses @aws-sdk/client-s3, an optional peer dependency loaded on first use.
 */

import type { S3Client as SdkS3Client } from '@aws-sdk/client-s3';
import type { AwsFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { newRunId } from '../test-data/factory.js';
import { loadOptional } from './optional-package.js';
import {
    awsClientOptions,
    DEFAULT_AWS_TIMEOUT,
    DEFAULT_S3_PREFIX,
    encodeAwsBody,
    isNotFound,
    parseJson,
    reasonOf,
    resolveAwsConfig,
    sleep,
    type AwsBody,
} from './aws.js';

type S3Sdk = typeof import('@aws-sdk/client-s3');

export interface S3BucketOption {
    /** Bucket (default: the config's `s3.bucket`). */
    bucket?: string;
}

export interface S3PutOptions extends S3BucketOption, KeepOption {
    /** Default: `application/json` for an object body, `text/plain` for a string, none for a Buffer. */
    contentType?: string;
    metadata?: Record<string, string>;
    cacheControl?: string;
    contentEncoding?: string;
}

export interface S3WaitOptions extends S3BucketOption {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
}

/** An object read from S3. */
export interface S3Object {
    bucket: string;
    key: string;
    /** The raw body. */
    content: Buffer;
    /** The body decoded as UTF-8. */
    text(): string;
    /** The body parsed as JSON; throws when it isn't JSON. */
    json<T = unknown>(): T;
    contentType?: string;
    metadata: Record<string, string>;
    etag?: string;
    lastModified?: Date;
    size: number;
}

/** A key in a listing. */
export interface S3ObjectSummary {
    key: string;
    size: number;
    lastModified?: Date;
    etag?: string;
}

/** What `headObject()` returns for a key that exists. */
export interface S3ObjectInfo {
    key: string;
    size: number;
    contentType?: string;
    metadata: Record<string, string>;
    etag?: string;
    lastModified?: Date;
}

export interface S3Client {
    /** This test's key prefix, e.g. `propmaster-tests/t0-9f2a1c0b/`. Everything under it is deleted after the test. */
    readonly prefix: string;
    /** The config's default bucket, if any. */
    readonly bucket: string | undefined;
    /** `prefix + name`: a key of this test's own. */
    key(name: string): string;
    /** Writes an object. Undone after the test (deleted, or the previous content put back) unless `{ keep: true }`. */
    putObject(key: string, body: AwsBody, options?: S3PutOptions): Promise<void>;
    /** Reads an object; throws when it doesn't exist. */
    getObject(key: string, options?: S3BucketOption): Promise<S3Object>;
    /** Size, type and metadata of an object, or null when it doesn't exist. */
    headObject(key: string, options?: S3BucketOption): Promise<S3ObjectInfo | null>;
    /** True when the object exists. */
    exists(key: string, options?: S3BucketOption): Promise<boolean>;
    /** Every key under a prefix (default: this test's prefix), sorted. */
    listObjects(prefix?: string, options?: S3BucketOption): Promise<S3ObjectSummary[]>;
    /** Polls until the object exists, then reads it. Throws on timeout, listing the keys that are there. */
    waitForObject(key: string, options?: S3WaitOptions): Promise<S3Object>;
    /** Deletes an object (not undone). */
    deleteObject(key: string, options?: S3BucketOption): Promise<void>;
    /** Deletes every object under a prefix; returns how many. */
    deletePrefix(prefix: string, options?: S3BucketOption): Promise<number>;
    /** Creates a bucket. Emptied and deleted after the test unless `{ keep: true }` or it already existed. */
    createBucket(bucket: string, options?: KeepOption): Promise<void>;
    /** True when the bucket exists and is reachable. */
    bucketExists(bucket: string): Promise<boolean>;
    /** The AWS SDK client, for anything else. */
    readonly sdk: SdkS3Client;
    close(): void;
}

export interface CreateS3ClientOptions {
    /** Undo stack for writes and buckets; without one nothing is cleaned up. */
    registry?: CleanupRegistry;
    /** Run ID in the per-test prefix (default: a new one). */
    runId?: string;
}

/** The per-test prefix: the root (default `propmaster-tests/`) plus the run ID. */
export function s3TestPrefix(root: string | undefined, runId: string): string {
    const base = root ?? DEFAULT_S3_PREFIX;
    return `${base === '' || base.endsWith('/') ? base : `${base}/`}${runId}/`;
}

/** The "directory" of a key, for listing what's near a key that didn't show up. */
export function parentPrefix(key: string): string {
    const i = key.lastIndexOf('/');
    return i < 0 ? '' : key.slice(0, i + 1);
}

function toS3Object(bucket: string, key: string, content: Buffer, info: Omit<S3ObjectInfo, 'key' | 'size'>): S3Object {
    return {
        bucket,
        key,
        content,
        text: () => content.toString('utf8'),
        json: <T>() => parseJson<T>(content.toString('utf8'), 's3', { bucket, key }),
        ...info,
        size: content.length,
    };
}

/** Builds the client. */
export async function createS3Client(config: AwsFixtureConfig, options: CreateS3ClientOptions = {}): Promise<S3Client> {
    const { registry } = options;
    const sdkOptions = awsClientOptions(config);
    const s3 = await loadOptional<S3Sdk>('@aws-sdk/client-s3', 's3Client');
    const sdk = new s3.S3Client(sdkOptions);
    const defaultBucket = config.s3?.bucket;
    const prefix = s3TestPrefix(config.s3?.prefix, options.runId ?? newRunId());
    const timeoutDefault = config.timeout ?? DEFAULT_AWS_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;

    const fail = (operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        throw new FixtureOperationError('s3', operation, { ...details, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
    };
    const bucketOf = (operation: FixtureOperationError['operation'], o?: S3BucketOption): string => {
        const bucket = o?.bucket ?? defaultBucket;
        if (!bucket) fail(operation, {}, new Error('no bucket: pass { bucket } or set PW_AWS_S3_BUCKET (aws.s3.bucket)'));
        return bucket!;
    };

    // Every bucket the test used gets the prefix emptied once, after the test.
    const prefixCleaned = new Set<string>();
    const touch = (bucket: string) => {
        if (prefixCleaned.has(bucket) || !track()) return;
        prefixCleaned.add(bucket);
        registry!.add(`s3 ${bucket}/${prefix}*`, () => client.deletePrefix(prefix, { bucket }).catch((error) => {
            if (!isNotFound(error) && !/NoSuchBucket/.test(reasonOf(error))) throw error;
        }));
    };

    const list = async (bucket: string, listPrefix: string): Promise<S3ObjectSummary[]> => {
        const out: S3ObjectSummary[] = [];
        let token: string | undefined;
        do {
            const page = await sdk.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: listPrefix, ContinuationToken: token }));
            for (const o of page.Contents ?? []) {
                if (o.Key !== undefined) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified, etag: o.ETag });
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        return out.sort((a, b) => a.key.localeCompare(b.key));
    };

    const head = async (bucket: string, key: string): Promise<S3ObjectInfo | null> => {
        try {
            const r = await sdk.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
            return { key, size: r.ContentLength ?? 0, contentType: r.ContentType, metadata: r.Metadata ?? {}, etag: r.ETag, lastModified: r.LastModified };
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    };

    const get = async (bucket: string, key: string): Promise<S3Object> => {
        const r = await sdk.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
        const content = Buffer.from(r.Body ? await r.Body.transformToByteArray() : new Uint8Array());
        return toS3Object(bucket, key, content, { contentType: r.ContentType, metadata: r.Metadata ?? {}, etag: r.ETag, lastModified: r.LastModified });
    };

    const put = (bucket: string, key: string, content: Buffer, o: Omit<S3PutOptions, 'bucket' | 'keep'>) =>
        sdk.send(new s3.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: content,
            ContentType: o.contentType,
            Metadata: o.metadata,
            CacheControl: o.cacheControl,
            ContentEncoding: o.contentEncoding,
        }));

    const client: S3Client = {
        prefix,
        bucket: defaultBucket,
        sdk,
        key: (name) => `${prefix}${name.replace(/^\/+/, '')}`,

        async putObject(key, body, o) {
            const bucket = bucketOf('putObject', o);
            const details = { bucket, key };
            let encoded: ReturnType<typeof encodeAwsBody>;
            try {
                encoded = encodeAwsBody(body, o?.contentType);
            } catch (error) {
                return fail('putObject', details, error);
            }
            const underPrefix = key.startsWith(prefix);
            try {
                if (underPrefix) touch(bucket);
                // Outside the test's prefix, remember what was there so it can be put back.
                const previous = !underPrefix && track(o) && (await head(bucket, key)) ? await get(bucket, key) : undefined;
                await put(bucket, key, encoded.content, { ...o, contentType: encoded.contentType });
                if (!underPrefix && track(o)) {
                    registry!.add(previous ? `s3 restore ${bucket}/${key}` : `s3 ${bucket}/${key}`, async () => {
                        if (previous) {
                            await put(bucket, key, previous.content, { contentType: previous.contentType, metadata: previous.metadata });
                        } else {
                            await sdk.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
                        }
                    });
                }
            } catch (error) {
                return fail('putObject', details, error);
            }
        },

        async getObject(key, o) {
            const bucket = bucketOf('getObject', o);
            try {
                return await get(bucket, key);
            } catch (error) {
                const reason = isNotFound(error) ? `s3://${bucket}/${key} doesn't exist (${reasonOf(error)})` : reasonOf(error);
                return fail('getObject', { bucket, key }, new Error(reason));
            }
        },

        async headObject(key, o) {
            const bucket = bucketOf('headObject', o);
            try {
                return await head(bucket, key);
            } catch (error) {
                return fail('headObject', { bucket, key }, error);
            }
        },

        async exists(key, o) {
            return (await client.headObject(key, o)) !== null;
        },

        async listObjects(listPrefix = prefix, o) {
            const bucket = bucketOf('listObjects', o);
            try {
                return await list(bucket, listPrefix);
            } catch (error) {
                return fail('listObjects', { bucket, prefix: listPrefix }, error);
            }
        },

        async waitForObject(key, o) {
            const bucket = bucketOf('waitForObject', o);
            if (key.startsWith(prefix)) touch(bucket);
            const timeout = o?.timeout ?? timeoutDefault;
            const deadline = Date.now() + timeout;
            for (;;) {
                try {
                    if (await head(bucket, key)) return await get(bucket, key);
                } catch (error) {
                    return fail('waitForObject', { bucket, key }, error);
                }
                if (Date.now() >= deadline) break;
                await sleep(Math.min(250, Math.max(deadline - Date.now(), 0)));
            }
            const near = parentPrefix(key);
            const there = await list(bucket, near).catch(() => [] as S3ObjectSummary[]);
            const shown = there.slice(0, 10).map((s) => s.key).join(', ');
            return fail('waitForObject', { bucket, key, timeout }, new Error(
                `s3://${bucket}/${key} didn't appear within ${timeout} ms: ${there.length === 0 ? `nothing under ${near || '(bucket root)'}` : `${there.length} key(s) under ${near || '(bucket root)'}${there.length > 10 ? ' (first 10)' : ''}: ${shown}`}`,
            ));
        },

        async deleteObject(key, o) {
            const bucket = bucketOf('deleteObject', o);
            try {
                await sdk.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
            } catch (error) {
                return fail('deleteObject', { bucket, key }, error);
            }
        },

        async deletePrefix(deleteFrom, o) {
            const bucket = bucketOf('deleteObject', o);
            if (deleteFrom === '') return fail('deleteObject', { bucket }, new Error('refusing to delete with an empty prefix (the whole bucket)'));
            try {
                const keys = (await list(bucket, deleteFrom)).map((s) => s.key);
                // One DeleteObject per key: DeleteObjects needs Content-MD5, which some emulators reject.
                for (let i = 0; i < keys.length; i += 10) {
                    await Promise.all(keys.slice(i, i + 10).map((Key) => sdk.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key }))));
                }
                return keys.length;
            } catch (error) {
                return fail('deleteObject', { bucket, prefix: deleteFrom }, error);
            }
        },

        async bucketExists(bucket) {
            try {
                await sdk.send(new s3.HeadBucketCommand({ Bucket: bucket }));
                return true;
            } catch (error) {
                if (isNotFound(error)) return false;
                return fail('createBucket', { bucket }, error);
            }
        },

        async createBucket(bucket, o) {
            const existed = await client.bucketExists(bucket);
            if (existed) return;
            try {
                await sdk.send(new s3.CreateBucketCommand({
                    Bucket: bucket,
                    ...(sdkOptions.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: sdkOptions.region as never } } : {}),
                }));
            } catch (error) {
                return fail('createBucket', { bucket }, error);
            }
            if (track(o)) {
                registry!.add(`s3 bucket ${bucket}`, async () => {
                    for (const { key } of await list(bucket, '')) await sdk.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
                    await sdk.send(new s3.DeleteBucketCommand({ Bucket: bucket }));
                });
            }
        },

        close() {
            sdk.destroy();
        },
    };
    return client;
}

/**
 * Fixture definition for test.extend(). The undo actions run before the
 * SDK client is destroyed.
 */
export const s3Fixture = {
    s3Client: async (
        { aws, stagehandContainers, dataCleanup }: { aws: AwsFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: S3Client) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        const config = await stagehandContainers.aws(await resolveAwsConfig(aws));
        let client: S3Client;
        try {
            client = await createS3Client(config, { registry: dataCleanup, runId: newRunId(testInfo.workerIndex) });
        } catch (error) {
            if (error instanceof FixtureInitError || (error as Error).name === 'MissingPackageError') throw error;
            throw new FixtureInitError('s3', 'connect', { reason: reasonOf(error) }, error instanceof Error ? error : undefined);
        }
        let cleanupError: unknown;
        try {
            await use(client);
            await dataCleanup.flush();
        } catch (error) {
            cleanupError = error;
        }
        client.close();
        if (cleanupError) throw cleanupError;
    },
};
