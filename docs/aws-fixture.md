# AWS Fixtures (S3, SQS, SNS)

Two fixtures test what a backend does with AWS. `s3Client` checks the files it writes to S3. `sqsClient` checks the messages it sends to SQS queues and publishes to SNS topics. Both run against an emulator ([Moto](https://github.com/getmoto/moto) or [LocalStack](https://www.localstack.cloud/)) or a real test account. One `aws` config serves both, and the [DynamoDB fixture](./dynamodb-fixture) too.

---

## What They Do

**`s3Client`**
- Every test gets a key prefix of its own: `s3Client.prefix`, or a key under it from `s3Client.key(name)`. Hand it to the application and the files the test causes are the test's own. Everything under the prefix is deleted when the test ends.
- `putObject()` outside the prefix is undone too. A new key is deleted. An overwritten key gets its previous content back.
- `getObject()` returns the body as text, JSON or a Buffer, with its content type and metadata.
- `waitForObject()` polls until the application has written a key. If the key never shows up, the error lists the keys that are there instead.
- Buckets created with `createBucket()` are emptied and deleted afterwards.

**`sqsClient`**
- `send()`, `receive()`, `purge()` and `checkQueue()` work on queues.
- `publish()` sends to an SNS topic, given its ARN or its name.
- `listen(topic)` subscribes a temporary SQS queue to the topic. The application's own subscribers still get their copies, and the test reads its copy from the listener.
- Queues and topics created with `createQueue()` / `createTopic()` are deleted afterwards. Listener queues and their subscriptions are always deleted.

---

## Setup

### Install

```bash
npm install --save-dev @aws-sdk/client-s3     # s3Client
npm install --save-dev @aws-sdk/client-sqs    # sqsClient
npm install --save-dev @aws-sdk/client-sns    # sqsClient's publish() and listen()
```

Then pick where the tests run:

```bash
# Moto from the repo's compose file, on LocalStack's port 4566
docker compose -f compose.test.yaml up -d --wait moto
PW_AWS_ENDPOINT=http://localhost:4566 PW_AWS_S3_BUCKET=test-files npx playwright test

# Or let the test run start Moto (needs Docker and testcontainers)
npm install --save-dev testcontainers
PW_AWS_CONTAINER=true PW_AWS_S3_BUCKET=test-files npx playwright test

# Or a real test account: credentials from the standard AWS chain
PW_AWS_REGION=eu-west-1 PW_AWS_PROFILE=tests PW_AWS_S3_BUCKET=app-test-files npx playwright test
```

::: tip Moto or LocalStack
Since 2026, LocalStack's Docker image needs an auth token (`LOCALSTACK_AUTH_TOKEN`), so the compose file, CI and container mode use Moto instead. Moto is free and needs no account. LocalStack still works: start it yourself and set `PW_AWS_ENDPOINT=http://localhost:4566`.
:::

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_AWS_ENDPOINT` | Emulator URL for every service. Leave it out for real AWS | — |
| `PW_AWS_REGION` | Region | `AWS_REGION`, else `us-east-1` with an endpoint |
| `PW_AWS_ACCESS_KEY_ID`, `PW_AWS_SECRET_ACCESS_KEY`, `PW_AWS_SESSION_TOKEN` | Static credentials | the standard AWS chain; `test`/`test` with an endpoint |
| `PW_AWS_PROFILE` | A profile from `~/.aws/config` | — |
| `PW_AWS_FORCE_PATH_STYLE` | Path-style S3 URLs | `true` with an endpoint |
| `PW_AWS_S3_BUCKET` | Default bucket for `s3Client` | — |
| `PW_AWS_S3_PREFIX` | Root of the per-test prefix | `propmaster-tests/` |
| `PW_AWS_TIMEOUT` | Default wait for `waitForObject()`, `receive()` and `waitForMessage()`, in ms | `10000` |
| `PW_AWS_CONTAINER` | `true` (or an image name) starts Moto in a container | off |

Without static credentials, the AWS SDK's standard chain supplies them: the `AWS_*` variables, a profile, SSO, or an instance or task role. With an endpoint, the credentials default to `test`/`test`, so a run against an emulator never picks up real credentials by accident.

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "aws": { "endpoint": "http://localhost:4566", "s3": { "bucket": "test-files" } }
        },
        "dev": {
            "aws": { "region": "eu-west-1", "profile": "tests", "s3": { "bucket": "app-dev-test-files", "prefix": "ci/" } }
        }
    }
}
```

Static keys can come from a [secrets provider](./secrets): map them to `aws.accessKeyId` and `aws.secretAccessKey`.

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import { ConfigLoader } from '@inluxc/propmaster';

const config = new ConfigLoader().load();

export default defineConfig({
    projects: [
        {
            name: 'integration',
            testDir: './tests/integration',
            use: { aws: config.aws, database: config.database },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `endpoint` | `string` | — | Emulator URL |
| `region` | `string` | `AWS_REGION` / `us-east-1` with an endpoint | |
| `accessKeyId`, `secretAccessKey`, `sessionToken` | `string` | the standard chain | Set both keys or neither |
| `profile` | `string` | — | |
| `forcePathStyle` | `boolean` | `true` with an endpoint | |
| `s3.bucket` | `string` | — | Used when a call doesn't pass `{ bucket }` |
| `s3.prefix` | `string` | `propmaster-tests/` | Root of the per-test prefix |
| `timeout` | `number` | `10000` | ms |
| `container` | `boolean \| ContainerOptions` | off | Moto; see [Testcontainers](./testcontainers) |

---

## S3

### Check a file your application writes

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-AWS-001] an export writes a CSV to S3', { tag: ['@TC-AWS-001'] }, async ({ s3Client, openApiClient }) => {
    const key = s3Client.key('exports/orders.csv');   // propmaster-tests/t0-9f2a1c0b/exports/orders.csv

    await test.step('Step 1: Start the export, telling the app where to write', async () => {
        const response = await (openApiClient.client as any).startExport(null, { bucket: s3Client.bucket, key });
        expect(response.status).toBe(202);
    });

    await test.step('Step 2: Verify the file appears with the expected rows', async () => {
        const file = await s3Client.waitForObject(key, { timeout: 30_000 });
        expect(file.contentType).toBe('text/csv');
        expect(file.text().split('\n')[0]).toBe('id,total');
    });
});
```

When the application picks the key itself, pass it `s3Client.prefix` as its base path, or wait for the key it uses and delete it afterwards with `testData.cleanup()`.

### Seed a file your application reads

```typescript
await s3Client.putObject(s3Client.key('imports/products.json'), [{ sku: 'SKU-1' }]);   // sent as application/json
await s3Client.putObject('config/feature-flags.json', { beta: true });                 // outside the prefix: put back afterwards
```

The body can be a string (sent as `text/plain`), a Buffer or Uint8Array (sent as it is), or anything else (sent as JSON). `contentType`, `metadata`, `cacheControl` and `contentEncoding` go in the options.

### With the Steps class

```typescript
import { S3Steps } from '@inluxc/propmaster/steps';

const s3 = new S3Steps(s3Client);
await s3.putObject('Upload the import file', s3Client.key('in.csv'), 'sku\nSKU-1');
await s3.expectJsonObject('Verify the result file', s3Client.key('out.json'), { imported: 1 });
await s3.expectKeys('Verify nothing else was written', [s3Client.key('in.csv'), s3Client.key('out.json')]);
await s3.expectNoObject('Verify no error file', s3Client.key('errors.csv'));
```

### API Reference

| Method | Returns | |
|---|---|---|
| `prefix`, `bucket` | `string`, `string \| undefined` | The test's prefix; the default bucket |
| `key(name)` | `string` | `prefix + name` |
| `putObject(key, body, options?)` | `Promise<void>` | Undone after the test unless `{ keep: true }` |
| `getObject(key, { bucket }?)` | `Promise<S3Object>` | Throws when the key doesn't exist |
| `headObject(key, { bucket }?)` | `Promise<S3ObjectInfo \| null>` | Size, content type, metadata |
| `exists(key, { bucket }?)` | `Promise<boolean>` | |
| `listObjects(prefix = this.prefix, { bucket }?)` | `Promise<S3ObjectSummary[]>` | Every key, sorted |
| `waitForObject(key, { bucket, timeout }?)` | `Promise<S3Object>` | Polls every 250 ms |
| `deleteObject(key, { bucket }?)` | `Promise<void>` | |
| `deletePrefix(prefix, { bucket }?)` | `Promise<number>` | Keys deleted (refuses `''`) |
| `createBucket(bucket, { keep }?)` | `Promise<void>` | Deleted after the test unless it existed |
| `bucketExists(bucket)` | `Promise<boolean>` | |
| `sdk` | `S3Client` (AWS SDK) | For anything else |

**`S3Object`:** `bucket`, `key`, `content` (Buffer), `text()`, `json<T>()`, `contentType`, `metadata`, `etag`, `lastModified`, `size`.

---

## SQS and SNS

### Check the event your application publishes to SNS

Start listening **before** the action. A listener only receives messages published after `listen()` returns.

```typescript
test('[TC-AWS-002] placing an order publishes OrderCreated', { tag: ['@TC-AWS-002'] }, async ({ sqsClient, openApiClient }) => {
    const listener = await sqsClient.listen('orders-events');        // the topic name, or its ARN
    let orderId: string;

    await test.step('Step 1: Place an order through the API', async () => {
        const response = await (openApiClient.client as any).createOrder(null, { sku: 'SKU-1' });
        orderId = response.data.id;
    });

    await test.step('Step 2: Verify the event', async () => {
        const event = await listener.waitForMessage((m) => m.json<{ orderId: string }>().orderId === orderId);
        expect(event.attributes.eventType).toBe('OrderCreated');
    });
});
```

Tests running in parallel share the topic, so every listener also sees the other tests' events. Match on something unique to the test, as `waitForMessage()` does above.

`listen(topic, { filterPolicy })` subscribes with an SNS filter policy, for example `{ eventType: ['OrderCreated'] }`. Pass `filterPolicyScope: 'MessageBody'` to filter on the body instead of the attributes.

On real AWS, a new subscription can take a few seconds before it receives messages. Emulators deliver at once.

### Send a message your application consumes

```typescript
await sqsClient.send('payments-in', { orderId, amount: 4200 }, { attributes: { source: 'psp' } });
await sqsClient.publish('payments', { orderId }, { subject: 'PaymentCaptured', attributes: { eventType: 'PaymentCaptured' } });
```

A `.fifo` queue or topic gets the group ID `default` unless you pass `groupId`.

### Work with a queue the test owns

```typescript
const queue = testData.unique('jobs');
await sqsClient.createQueue(queue);                          // deleted after the test
await sqsClient.send(queue, { job: 1 });
const [job] = await sqsClient.receive(queue);                // received and deleted
expect((await sqsClient.checkQueue(queue))?.messages).toBe(0);
```

`receive()` deletes each message it takes, like a consumer that processed it. On an application's queue that competes with the application's own consumers. Pass `{ delete: false }` to leave the messages there (they become visible again after the visibility timeout), or use `listen()` on the topic instead.

### With the Steps class

```typescript
import { SqsSteps } from '@inluxc/propmaster/steps';

const sqs = new SqsSteps(sqsClient);
const listener = await sqs.listen('Listen for order events', 'orders-events');
await sqs.publish('Publish OrderCreated', 'orders-events', { orderId });
await sqs.expectMessage('Verify the event arrives', listener, (m) => m.json<{ orderId: string }>().orderId === orderId);
await sqs.expectNoMessage('Verify no cancellation', listener, (m) => m.subject === 'OrderCancelled');
await sqs.send('Queue a job', 'jobs', { job: 1 });
await sqs.receiveExpectMessages('Take the job', 'jobs');
await sqs.expectQueueDepth('Verify the queue is empty', 'jobs', 0);
```

### API Reference

| Method | Returns | |
|---|---|---|
| `send(queue, body, options?)` | `Promise<string>` | Message ID. A queue name or URL |
| `receive(queue, { count = 1, timeout, visibilityTimeout, delete = true }?)` | `Promise<SqsMessage[]>` | What arrived before the timeout |
| `purge(queue)` | `Promise<void>` | On AWS, once per queue every 60 seconds |
| `checkQueue(queue)` | `Promise<{ url, arn, messages, inFlight, delayed } \| null>` | `null` when the queue doesn't exist |
| `queueUrl(queue)` | `Promise<string>` | |
| `createQueue(name, { attributes, keep }?)` | `Promise<string>` | The queue URL |
| `createTopic(name, { attributes, keep }?)` | `Promise<string>` | The topic ARN |
| `topicArn(topic)` | `Promise<string>` | Throws when the topic doesn't exist |
| `publish(topic, body, { subject, attributes, groupId, deduplicationId }?)` | `Promise<string>` | Message ID |
| `listen(topic, { filterPolicy, filterPolicyScope }?)` | `Promise<SnsListener>` | |
| `listener.waitForMessage(predicate?, { timeout }?)` | `Promise<SnsMessage>` | Throws on timeout, listing what arrived |
| `listener.messages({ count = 1, timeout }?)` | `Promise<SnsMessage[]>` | |
| `listener.received` | `SnsMessage[]` | Everything received so far |
| `sdk.sqs`, `sdk.sns()` | AWS SDK clients | For anything else |

**Send options:** `delaySeconds`, `attributes` (string, number or Buffer values), `groupId`, `deduplicationId`.

**`SqsMessage`:** `body`, `json<T>()`, `messageId`, `receiptHandle`, `attributes` (message attributes as strings), `systemAttributes`.

**`SnsMessage`:** `body` (the published message), `json<T>()`, `subject`, `messageId`, `topicArn`, `attributes`, `timestamp`.

---

## Lifecycle

1. **Setup:** each fixture creates an AWS SDK client per test. Nothing is sent until the first call.
2. **Teardown:** in reverse order, the test's writes are undone, its buckets, queues and topics are deleted, and everything under its S3 prefix is removed. Pass `{ keep: true }` to `putObject`, `createBucket`, `createQueue` or `createTopic` to leave one in place, or set `use: { autoCleanup: false }` on a project. A bucket, queue or topic that existed before the test is never deleted. Then listener subscriptions and queues are removed and the clients are destroyed.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`aws`, `connect`) | No region, or only one of the two access keys |
| `FixtureOperationError` (`s3`, `putObject` / `getObject` / ...) | AWS rejected the call, the key or bucket doesn't exist, or no bucket was given |
| `FixtureOperationError` (`s3`, `waitForObject`) | The key didn't appear before the timeout. The message lists the keys next to it |
| `FixtureOperationError` (`sqs`, `send` / `receive` / ...) | The queue doesn't exist, or SQS rejected the call |
| `FixtureOperationError` (`sns`, `publish` / `listen` / `waitForMessage`) | The topic doesn't exist, or no matching message arrived before the timeout |
| `MissingPackageError` | `@aws-sdk/client-s3`, `-sqs` or `-sns` isn't installed |
