# Kafka Fixture

The `kafkaClient` fixture provides Kafka producer and consumer capabilities for integration testing. It runs on [KafkaJS](https://kafka.js.org/) by default, or on Confluent's [`@confluentinc/kafka-javascript`](https://github.com/confluentinc/confluent-kafka-javascript) (see [Choosing a driver](#choosing-a-driver)). It manages the producer and consumer connections per test, with a unique consumer group ID per test for message isolation.

---

## What It Does

- Connects a Kafka producer per test, and a consumer for each `consume()` call
- Generates a unique consumer group ID per test, so tests don't take each other's messages
- A second `consume()` in the same test goes on where the first one stopped: only the messages a call returned are committed
- Supports SSL and SASL authentication
- Provides `produce()` and `consume()` methods with configurable timeouts
- Handles graceful disconnection with timeout-based force-close

---

## Setup

### Install

The driver is an optional peer dependency. Install it in your project:

```bash
npm install --save-dev kafkajs
# or, for the Confluent driver
npm install --save-dev @confluentinc/kafka-javascript
```

### Choosing a driver

| | `kafkajs` (default) | `confluent` |
|---|---|---|
| Package | `kafkajs` | `@confluentinc/kafka-javascript` |
| Maintained | Last release February 2023 | Maintained by Confluent |
| Under the hood | Pure JavaScript | [librdkafka](https://github.com/confluentinc/librdkafka) (native) |
| Install | Nothing to build, 2 MB | ~30 MB. Its install script downloads a prebuilt binary from GitHub (Node 18–24 on Linux, macOS and Windows x64), and builds librdkafka from source when there is none for the platform |

Pick Confluent's with `driver: 'confluent'` in the config, or `PW_KAFKA_DRIVER=confluent`. Tests don't change: `produce()`, `consume()`, the options and the errors are the same on both, and this repository's CI runs the Kafka suite on each.

Confluent's client needs its install script to run. It doesn't load (`Could not locate the bindings file`) when it was installed with `--ignore-scripts`, with pnpm 10 or Bun without allowing its scripts (`pnpm approve-builds`, `trustedDependencies`), or where GitHub downloads are blocked and there's no compiler to fall back on. Stay on kafkajs in those setups.

### Run it in a container

No Kafka broker to connect to? Set `PW_KAFKA_CONTAINER=true` (or `container: true` in config) and the fixture starts one with Testcontainers for the run, then removes it. Needs Docker and `npm install --save-dev testcontainers`. See [Testcontainers](./testcontainers).

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PW_KAFKA_BROKERS` | No | Comma-separated broker list (default: `localhost:9092`) |
| `PW_KAFKA_CLIENT_ID` | No | Client identifier (default: `playwright-test`) |
| `PW_KAFKA_SSL` | No | Enable SSL (`true`/`false`) |
| `PW_KAFKA_DISCONNECT_TIMEOUT` | No | Disconnect timeout in ms (default: `5000`) |
| `PW_KAFKA_DRIVER` | No | `kafkajs` (default) or `confluent` |

### Configuration via `environments.json`

```json
{
  "environments": {
    "dev": {
      "kafka": {
        "brokers": ["kafka-1.dev.example.com:9092", "kafka-2.dev.example.com:9092"],
        "clientId": "playwright-test",
        "ssl": true,
        "sasl": {
          "mechanism": "plain",
          "username": "test-user",
          "password": "test-pass"
        },
        "disconnectTimeout": 5000
      }
    }
  }
}
```

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'integration',
      testMatch: '**/integration/**/*.spec.ts',
      use: {
        kafka: {
          brokers: ['localhost:9092'],
          clientId: 'playwright-test',
          ssl: false,
        },
      },
    },
  ],
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `brokers` | `string[]` | `['localhost:9092']` | List of Kafka broker addresses |
| `clientId` | `string` | `'playwright-test'` | Kafka client identifier |
| `ssl` | `boolean` | `false` | Enable SSL for broker connections |
| `sasl` | `SASLOptions` | — | SASL authentication options |
| `disconnectTimeout` | `number` | `5000` | Timeout in ms for disconnect operations |
| `driver` | `'kafkajs' \| 'confluent'` | `'kafkajs'` | The client library |

#### SASL Options

| Option | Type | Description |
|--------|------|-------------|
| `mechanism` | `'plain' \| 'scram-sha-256' \| 'scram-sha-512'` | Authentication mechanism |
| `username` | `string` | SASL username |
| `password` | `string` | SASL password |

---

## Usage

### Producing Messages

```typescript
import { test, expect } from '@inluxc/propmaster';

test('produce a message', async ({ kafkaClient }) => {
  await kafkaClient.produce('user-events', [
    { key: 'user-42', value: JSON.stringify({ action: 'signup' }) },
  ]);
});
```

### Consuming Messages

```typescript
test('consume messages from a topic', async ({ kafkaClient }) => {
  const messages = await kafkaClient.consume('user-events', {
    count: 1,
    timeout: 10000,
    fromBeginning: true,
  });

  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0].value as string)).toHaveProperty('action');
});
```

### Produce and Consume Together

```typescript
test('produce and consume a message', async ({ kafkaClient }) => {
  const payload = { userId: 42, action: 'signup' };

  await kafkaClient.produce('user-events', [
    { key: 'user-42', value: JSON.stringify(payload) },
  ]);

  const messages = await kafkaClient.consume('user-events', {
    count: 1,
    timeout: 10000,
    fromBeginning: false,
  });

  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0].value as string)).toMatchObject(payload);
});
```

### Consume Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `30000` | Maximum time to wait for messages in ms |
| `count` | `number` | — | Maximum number of messages to consume |
| `fromBeginning` | `boolean` | `false` | Whether to consume from the beginning of the topic |

### Message Shape

Each consumed message has the following structure:

```typescript
interface KafkaMessage {
  key: string | null;
  value: string | Buffer;
  topic: string;
  partition: number;
  offset: string;
}
```

---

## Lifecycle

1. **Setup** — Connects the producer and an admin client (for topic lookups) on the configured driver.
2. **Use** — Provides `kafkaClient` to the test. Each `consume()` connects a consumer in the test's group, reads, commits the offsets of the messages it returns, and disconnects.
3. **Teardown** — Disconnects everything within `disconnectTimeout`, then gives up.

---

## Error Handling

| Error | When |
|-------|------|
| `FixtureInitError` | The brokers can't be reached (the message names the brokers and the driver) |
| `FixtureOperationError` | A message can't be produced, or a consumer can't connect to a topic that exists |
| `MissingPackageError` | The driver's package isn't installed |

The `consume()` method returns an empty array (rather than throwing) if the timeout expires with no messages or if the topic does not exist.
