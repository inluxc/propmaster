/**
 * What each fixture needs in a project: its driver packages, its block in
 * environments.json, its PW_* variables, a compose service to run the
 * backend locally, and a starter test. `propmaster fixture add|remove`
 * applies it; doctor and `propmaster env` read it.
 *
 * Keep in step with FIXTURE_PACKAGES (src/fixtures/optional-package.ts), the
 * config schema (src/config/schema.ts) and compose.test.yaml; the unit tests
 * compare them.
 */

import type { TestType } from './layout.js';

/** One value in environments.json, at `path` inside an environment (e.g. ['aws', 's3']). */
export interface ConfigItem {
    path: string[];
    value: unknown;
}

/** One PW_* variable for .env.example. */
export interface EnvVar {
    name: string;
    value: string;
    /** Written commented out: optional, or a secret to fill in. */
    optional?: boolean;
}

/** A block of .env.example; entries sharing a group (the AWS ones) share the block. */
export interface EnvSection {
    group: string;
    title: string;
    vars: EnvVar[];
}

/** A compose service, as YAML under `services:` (indented two spaces, name line included). */
export interface ServiceSpec {
    name: string;
    yaml: string;
}

export interface StarterStep {
    name: string;
    code: string;
}

export interface Starter {
    /** File name in the test type's folder, without `.spec.ts`. */
    file: string;
    describe: string;
    title: string;
    /** Fixtures the test takes, as written in its parameter list. */
    params: string;
    /** Values the steps share, declared before them (a step's own `const` isn't seen by the next). */
    setup?: string;
    steps: StarterStep[];
}

/** One way to set a fixture up: SQL databases by type, Kafka by driver, search by engine. */
export interface FixtureVariant {
    id: string;
    label: string;
    packages: string[];
    config: ConfigItem[];
    env: EnvSection[];
    services: ServiceSpec[];
}

export interface CatalogEntry {
    /** What you type: `propmaster fixture add redis`. */
    id: string;
    label: string;
    /** The fixture names tests request. */
    fixtures: string[];
    testType: TestType;
    /** TestCaseID category for the starter test. */
    category: string;
    /** The first is the default. Entries with one way to set up have one variant with id 'default'. */
    variants: FixtureVariant[];
    starter: Starter;
    /** Shown after adding: what to do next. */
    next?: string;
}

/** Placeholder for values each environment has to fill in itself. */
export const PLACEHOLDER = 'CHANGE_ME';

const section = (group: string, title: string, vars: EnvVar[]): EnvSection => ({ group, title, vars });

const service = (name: string, lines: string[]): ServiceSpec => ({ name, yaml: [`  ${name}:`, ...lines.map((l) => `    ${l}`)].join('\n') });

const one = (v: Omit<FixtureVariant, 'id' | 'label'>): FixtureVariant[] => [{ id: 'default', label: 'default', ...v }];

// ─── Services (the same images and ports as Propmaster's own compose.test.yaml) ─

const SERVICES = {
    postgres: service('postgres', [
        'image: postgres:15',
        'environment:',
        '  POSTGRES_DB: testdb',
        '  POSTGRES_USER: testuser',
        '  POSTGRES_PASSWORD: testpass',
        'ports: ["127.0.0.1:5432:5432"]',
        'healthcheck:',
        '  test: ["CMD-SHELL", "pg_isready -U testuser -d testdb"]',
        '  interval: 2s',
        '  retries: 30',
    ]),
    mysql: service('mysql', [
        'image: mysql:8.0',
        'environment:',
        '  MYSQL_DATABASE: testdb',
        '  MYSQL_USER: testuser',
        '  MYSQL_PASSWORD: testpass',
        '  MYSQL_ROOT_PASSWORD: rootpass',
        'ports: ["127.0.0.1:3306:3306"]',
        'healthcheck:',
        '  test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]',
        '  interval: 2s',
        '  retries: 60',
    ]),
    mssql: service('mssql', [
        'image: mcr.microsoft.com/mssql/server:2022-latest',
        'environment:',
        '  ACCEPT_EULA: "Y"',
        '  MSSQL_SA_PASSWORD: "TestPass123!"',
        'ports: ["127.0.0.1:1433:1433"]',
        'healthcheck:',
        `  test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'TestPass123!' -C -Q 'SELECT 1'"]`,
        '  interval: 5s',
        '  retries: 30',
    ]),
    redis: service('redis', ['image: redis:7', 'ports: ["127.0.0.1:6379:6379"]', 'healthcheck:', '  test: ["CMD", "redis-cli", "ping"]', '  interval: 2s', '  retries: 30']),
    mongodb: service('mongodb', [
        'image: mongo:7',
        'ports: ["127.0.0.1:27017:27017"]',
        'healthcheck:',
        '  test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ ping: 1 }).ok"]',
        '  interval: 2s',
        '  retries: 30',
    ]),
    neo4j: service('neo4j', [
        'image: neo4j:5',
        'environment:',
        '  NEO4J_AUTH: neo4j/testpassword',
        'ports: ["127.0.0.1:7687:7687"]',
        'healthcheck:',
        '  test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "testpassword", "RETURN 1"]',
        '  interval: 5s',
        '  retries: 30',
    ]),
    scylla: service('scylla', [
        '# ScyllaDB: CQL-compatible with Cassandra and ready in seconds.',
        'image: scylladb/scylla:2026.3.6',
        'command: ["--smp", "1", "--memory", "750M", "--overprovisioned", "1", "--developer-mode", "1"]',
        'ports: ["127.0.0.1:9042:9042"]',
        'healthcheck:',
        `  test: ["CMD-SHELL", "cqlsh -e 'SELECT now() FROM system.local' > /dev/null"]`,
        '  interval: 5s',
        '  timeout: 10s',
        '  start_period: 10s',
        '  retries: 30',
    ]),
    kafka: service('kafka', [
        'image: apache/kafka:latest',
        'environment:',
        '  KAFKA_NODE_ID: 1',
        '  KAFKA_PROCESS_ROLES: broker,controller',
        '  # Two listeners: kafka:19092 for other containers, localhost:9092 for the host.',
        '  KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:19092,HOST://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
        '  KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:19092,HOST://localhost:9092',
        '  KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT',
        '  KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER',
        '  KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,HOST:PLAINTEXT,CONTROLLER:PLAINTEXT',
        '  KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093',
        '  KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"',
        '  KAFKA_NUM_PARTITIONS: 1',
        '  KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1',
        '  CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk',
        'ports: ["127.0.0.1:9092:9092"]',
        'healthcheck:',
        '  test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092"]',
        '  interval: 5s',
        '  retries: 30',
    ]),
    rabbitmq: service('rabbitmq', [
        'image: rabbitmq:4',
        'environment:',
        '  RABBITMQ_DEFAULT_USER: testuser',
        '  RABBITMQ_DEFAULT_PASS: testpass',
        'ports: ["127.0.0.1:5672:5672"]',
        'healthcheck:',
        '  test: ["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]',
        '  interval: 5s',
        '  retries: 30',
    ]),
    moto: service('moto', [
        '# AWS emulator (S3, SQS, SNS, DynamoDB) on LocalStack\'s port: PW_AWS_ENDPOINT=http://localhost:4566',
        'image: motoserver/moto:5.2.5',
        'ports: ["127.0.0.1:4566:5000"]',
        'healthcheck:',
        '  test: ["CMD-SHELL", "curl -fs http://localhost:5000/moto-api/ > /dev/null"]',
        '  interval: 2s',
        '  retries: 15',
    ]),
    elasticsearch: service('elasticsearch', [
        'image: elasticsearch:9.5.5',
        'ports: ["127.0.0.1:9200:9200"]',
        'environment:',
        '  discovery.type: single-node',
        '  xpack.security.enabled: "false"',
        '  cluster.routing.allocation.disk.threshold_enabled: "false"',
        '  ES_JAVA_OPTS: -Xms512m -Xmx512m',
        'healthcheck:',
        `  test: ["CMD-SHELL", "curl -fs 'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=1s' > /dev/null"]`,
        '  interval: 3s',
        '  retries: 40',
    ]),
    opensearch: service('opensearch', [
        'image: opensearchproject/opensearch:3.10.0',
        'ports: ["127.0.0.1:9201:9200"]',
        'environment:',
        '  discovery.type: single-node',
        '  DISABLE_SECURITY_PLUGIN: "true"',
        '  DISABLE_INSTALL_DEMO_CONFIG: "true"',
        '  cluster.routing.allocation.disk.threshold_enabled: "false"',
        '  OPENSEARCH_JAVA_OPTS: -Xms512m -Xmx512m',
        'healthcheck:',
        `  test: ["CMD-SHELL", "curl -fs 'http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=1s' > /dev/null"]`,
        '  interval: 3s',
        '  retries: 40',
    ]),
    grpcbin: service('grpcbin', [
        '# gRPC test server with server reflection, plaintext on 9000. Replace with your own service.',
        'image: moul/grpcbin:latest',
        'ports: ["127.0.0.1:9000:9000"]',
        'healthcheck:',
        '  test: ["CMD-SHELL", "nc -z localhost 9000"]',
        '  interval: 2s',
        '  retries: 15',
    ]),
    'echo-server': service('echo-server', [
        '# WebSocket echo on any path, SSE on /.sse. Replace with your own service. No shell, so no health check.',
        'image: jmalloc/echo-server:v0.3.7',
        'ports: ["127.0.0.1:8091:8080"]',
    ]),
    mailpit: service('mailpit', [
        'image: axllent/mailpit:latest',
        'ports: ["127.0.0.1:8025:8025", "127.0.0.1:1025:1025"]   # API/UI, SMTP',
        'healthcheck:',
        '  test: ["CMD", "/mailpit", "readyz"]',
        '  interval: 2s',
        '  retries: 15',
    ]),
    wiremock: service('wiremock', [
        'image: wiremock/wiremock:3.13.2',
        'ports: ["127.0.0.1:8089:8080"]   # stubs and admin API (/__admin)',
        'healthcheck:',
        '  test: ["CMD-SHELL", "curl -fs http://localhost:8080/__admin/health > /dev/null"]',
        '  interval: 2s',
        '  retries: 30',
    ]),
} satisfies Record<string, ServiceSpec>;

// ─── Shared pieces ──────────────────────────────────────────────────────────

const AWS_CONFIG: ConfigItem[] = [
    { path: ['aws', 'endpoint'], value: 'http://localhost:4566' },
    { path: ['aws', 'region'], value: 'us-east-1' },
];

const AWS_ENV = section('aws', 'AWS (S3, SQS, SNS, DynamoDB)', [
    { name: 'PW_AWS_ENDPOINT', value: 'http://localhost:4566' },
    { name: 'PW_AWS_REGION', value: 'us-east-1' },
]);

const database = (id: string, label: string, pkg: string, port: number | null, values: Record<string, unknown>, svc: ServiceSpec | null): FixtureVariant => ({
    id,
    label,
    packages: [pkg],
    config: [{ path: ['database'], value: { type: id, ...(port ? { host: 'localhost', port } : {}), ...values } }],
    env: [
        section('database', 'SQL database', [
            { name: 'PW_DB_TYPE', value: id },
            ...(port ? [{ name: 'PW_DB_HOST', value: 'localhost' }, { name: 'PW_DB_PORT', value: String(port) }] : []),
            { name: 'PW_DB_NAME', value: String(values.database) },
            ...(values.username ? [{ name: 'PW_DB_USERNAME', value: String(values.username) }, { name: 'PW_DB_PASSWORD', value: String(values.password) }] : []),
        ]),
    ],
    services: svc ? [svc] : [],
});

const kafkaVariant = (id: string, label: string, pkg: string): FixtureVariant => ({
    id,
    label,
    packages: [pkg],
    config: [{ path: ['kafka'], value: { brokers: ['localhost:9092'], ...(id === 'confluent' ? { driver: 'confluent' } : {}) } }],
    env: [section('kafka', 'Kafka', [{ name: 'PW_KAFKA_BROKERS', value: 'localhost:9092' }, ...(id === 'confluent' ? [{ name: 'PW_KAFKA_DRIVER', value: 'confluent' }] : [])])],
    services: [SERVICES.kafka],
});

const searchVariant = (id: string, label: string, port: number, svc: ServiceSpec): FixtureVariant => ({
    id,
    label,
    packages: [],
    config: [{ path: ['search'], value: { url: `http://localhost:${port}` } }],
    env: [section('search', 'Search', [{ name: 'PW_SEARCH_URL', value: `http://localhost:${port}` }])],
    services: [svc],
});

// ─── The catalog ────────────────────────────────────────────────────────────

export const FIXTURE_CATALOG: readonly CatalogEntry[] = [
    {
        id: 'openapi',
        label: 'OpenAPI / REST',
        fixtures: ['openApiClient'],
        testType: 'api',
        category: 'API',
        variants: one({
            packages: ['openapi-client-axios'],
            config: [{ path: ['openapi'], value: { specPath: './specs/api.yaml', baseUrl: 'http://localhost:3000' } }],
            env: [section('openapi', 'OpenAPI', [{ name: 'PW_OPENAPI_SPEC_PATH', value: './specs/api.yaml' }, { name: 'PW_OPENAPI_BASE_URL', value: 'http://localhost:3000' }])],
            services: [],
        }),
        starter: {
            file: 'openapi',
            describe: 'API — starter',
            title: 'the OpenAPI spec loads and has operations',
            params: 'openApiClient',
            steps: [{ name: 'Step 1: Read the operations from the spec', code: 'expect(openApiClient.api.getOperations().length).toBeGreaterThan(0);' }],
        },
        next: 'Point openapi.specPath at your spec; `npx propmaster generate openapi` then writes a test per operation. YAML specs also need js-yaml.',
    },
    {
        id: 'graphql',
        label: 'GraphQL',
        fixtures: ['graphqlClient'],
        testType: 'api',
        category: 'GQL',
        variants: one({
            packages: ['graphql-request', 'graphql'],
            config: [{ path: ['graphql'], value: { endpoint: 'http://localhost:4000/graphql' } }],
            env: [section('graphql', 'GraphQL', [{ name: 'PW_GRAPHQL_ENDPOINT', value: 'http://localhost:4000/graphql' }])],
            services: [],
        }),
        starter: {
            file: 'graphql',
            describe: 'GraphQL — starter',
            title: 'the endpoint answers a query',
            params: 'graphqlClient',
            steps: [
                {
                    name: 'Step 1: Ask for the query type name',
                    code: "const data = await graphqlClient.query<{ __typename: string }>('{ __typename }');\nexpect(data.__typename).toBeTruthy();",
                },
            ],
        },
    },
    {
        id: 'grpc',
        label: 'gRPC',
        fixtures: ['grpcClient'],
        testType: 'api',
        category: 'GRPC',
        variants: one({
            packages: ['@grpc/grpc-js', '@grpc/proto-loader'],
            config: [{ path: ['grpc'], value: { address: 'localhost:9000' } }],
            env: [section('grpc', 'gRPC', [{ name: 'PW_GRPC_ADDRESS', value: 'localhost:9000' }, { name: 'PW_GRPC_PROTO_FILES', value: 'protos/service.proto', optional: true }])],
            services: [SERVICES.grpcbin],
        }),
        starter: {
            file: 'grpc',
            describe: 'gRPC — starter',
            title: 'the server lists its services',
            params: 'grpcClient',
            steps: [{ name: 'Step 1: List the services by reflection', code: 'expect((await grpcClient.services()).length).toBeGreaterThan(0);' }],
        },
        next: 'Without server reflection, set grpc.protoFiles to your .proto files.',
    },
    {
        id: 'realtime',
        label: 'WebSocket / SSE',
        fixtures: ['realtimeClient'],
        testType: 'api',
        category: 'RT',
        variants: one({
            packages: ['ws'],
            config: [{ path: ['realtime'], value: { url: 'http://localhost:8091' } }],
            env: [section('realtime', 'WebSocket / SSE', [{ name: 'PW_REALTIME_URL', value: 'http://localhost:8091' }])],
            services: [SERVICES['echo-server']],
        }),
        starter: {
            file: 'realtime',
            describe: 'WebSocket — starter',
            title: 'a message sent comes back',
            params: 'realtimeClient, testData',
            setup: "const text = testData.unique('hello');",
            steps: [
                {
                    name: 'Step 1: Connect, send, and wait for the echo',
                    code: "const ws = await realtimeClient.connect('/');\nawait ws.send(text);\nexpect((await ws.waitForMessage(text)).data).toBe(text);",
                },
            ],
        },
    },
    {
        id: 'database',
        label: 'SQL database',
        fixtures: ['databaseClient'],
        testType: 'integration',
        category: 'DB',
        variants: [
            database('postgresql', 'PostgreSQL', 'pg', 5432, { database: 'testdb', username: 'testuser', password: 'testpass' }, SERVICES.postgres),
            database('mysql', 'MySQL / MariaDB', 'mysql2', 3306, { database: 'testdb', username: 'testuser', password: 'testpass' }, SERVICES.mysql),
            database('mssql', 'SQL Server', 'mssql', 1433, { database: 'master', username: 'sa', password: 'TestPass123!', trustServerCertificate: true }, SERVICES.mssql),
            database('sqlite', 'SQLite', 'better-sqlite3', null, { database: './test.db' }, null),
        ],
        starter: {
            file: 'database',
            describe: 'Database — starter',
            title: 'the database answers a query',
            params: 'databaseClient',
            steps: [
                {
                    name: 'Step 1: Run SELECT 1',
                    code: "const rows = await databaseClient.query<{ one: number }>('SELECT 1 AS one');\nexpect(Number(rows[0].one)).toBe(1);",
                },
            ],
        },
    },
    {
        id: 'mongodb',
        label: 'MongoDB',
        fixtures: ['mongoDbClient'],
        testType: 'integration',
        category: 'MDB',
        variants: one({
            packages: ['mongodb'],
            config: [{ path: ['mongodb'], value: { host: 'localhost', port: 27017, database: 'testdb' } }],
            env: [section('mongodb', 'MongoDB', [{ name: 'PW_MONGODB_HOST', value: 'localhost' }, { name: 'PW_MONGODB_PORT', value: '27017' }, { name: 'PW_MONGODB_DATABASE', value: 'testdb' }])],
            services: [SERVICES.mongodb],
        }),
        starter: {
            file: 'mongodb',
            describe: 'MongoDB — starter',
            title: 'a document inserted can be found',
            params: 'mongoDbClient, testData',
            setup: "const name = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Insert a document (removed after the test)', code: "await mongoDbClient.insertOne('starter', { name });" },
                { name: 'Step 2: Find it', code: "expect(await mongoDbClient.findOne('starter', { name })).toMatchObject({ name });" },
            ],
        },
    },
    {
        id: 'neo4j',
        label: 'Neo4j',
        fixtures: ['neo4jClient'],
        testType: 'integration',
        category: 'NEO',
        variants: one({
            packages: ['neo4j-driver'],
            config: [{ path: ['neo4j'], value: { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'testpassword' } }],
            env: [
                section('neo4j', 'Neo4j', [
                    { name: 'PW_NEO4J_URI', value: 'bolt://localhost:7687' },
                    { name: 'PW_NEO4J_USERNAME', value: 'neo4j' },
                    { name: 'PW_NEO4J_PASSWORD', value: 'testpassword' },
                ]),
            ],
            services: [SERVICES.neo4j],
        }),
        starter: {
            file: 'neo4j',
            describe: 'Neo4j — starter',
            title: 'a node written can be read',
            params: 'neo4jClient, testData',
            steps: [
                { name: 'Step 1: Create a node (deleted after the test)', code: "await neo4jClient.write('CREATE (:Starter {runId: $runId})', { runId: testData.runId });" },
                {
                    name: 'Step 2: Read it back',
                    code: "const rows = await neo4jClient.run<{ n: number }>('MATCH (s:Starter {runId: $runId}) RETURN count(s) AS n', { runId: testData.runId });\nexpect(rows[0].n).toBe(1);",
                },
            ],
        },
    },
    {
        id: 'cassandra',
        label: 'Cassandra / ScyllaDB',
        fixtures: ['cassandraClient'],
        testType: 'integration',
        category: 'CAS',
        variants: one({
            packages: ['cassandra-driver'],
            config: [{ path: ['cassandra'], value: { contactPoints: ['localhost'], keyspace: 'tests', createKeyspace: true } }],
            env: [
                section('cassandra', 'Cassandra / ScyllaDB', [
                    { name: 'PW_CASSANDRA_CONTACT_POINTS', value: 'localhost' },
                    { name: 'PW_CASSANDRA_KEYSPACE', value: 'tests' },
                    { name: 'PW_CASSANDRA_CREATE_KEYSPACE', value: 'true' },
                ]),
            ],
            services: [SERVICES.scylla],
        }),
        starter: {
            file: 'cassandra',
            describe: 'Cassandra — starter',
            title: 'the cluster answers a query',
            params: 'cassandraClient',
            steps: [
                {
                    name: 'Step 1: Read the release version',
                    code: "const rows = await cassandraClient.query<{ release_version: string }>('SELECT release_version FROM system.local');\nexpect(rows[0].release_version).toBeTruthy();",
                },
            ],
        },
    },
    {
        id: 'redis',
        label: 'Redis',
        fixtures: ['redisClient'],
        testType: 'integration',
        category: 'RDS',
        variants: one({
            packages: ['ioredis'],
            config: [{ path: ['redis'], value: { host: 'localhost', port: 6379 } }],
            env: [section('redis', 'Redis', [{ name: 'PW_REDIS_HOST', value: 'localhost' }, { name: 'PW_REDIS_PORT', value: '6379' }, { name: 'PW_REDIS_PASSWORD', value: '', optional: true }])],
            services: [SERVICES.redis],
        }),
        starter: {
            file: 'redis',
            describe: 'Redis — starter',
            title: 'a key set can be read',
            params: 'redisClient, testData',
            setup: "const key = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Set a key (deleted after the test)', code: "await redisClient.set(key, 'hello');" },
                { name: 'Step 2: Read it back', code: "expect(await redisClient.get(key)).toBe('hello');" },
            ],
        },
    },
    {
        id: 'kafka',
        label: 'Kafka',
        fixtures: ['kafkaClient'],
        testType: 'integration',
        category: 'KFK',
        variants: [kafkaVariant('kafkajs', 'kafkajs (default)', 'kafkajs'), kafkaVariant('confluent', "Confluent's client (librdkafka)", '@confluentinc/kafka-javascript')],
        starter: {
            file: 'kafka',
            describe: 'Kafka — starter',
            title: 'a message produced can be consumed',
            params: 'kafkaClient, testData',
            setup: "const topic = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Produce to a topic of the test\'s own', code: "await kafkaClient.produce(topic, [{ value: 'hello' }]);" },
                {
                    name: 'Step 2: Consume it',
                    code: "const [message] = await kafkaClient.consume(topic, { count: 1, fromBeginning: true, timeout: 15_000 });\nexpect(message.value).toBe('hello');",
                },
            ],
        },
    },
    {
        id: 'amqp',
        label: 'RabbitMQ / AMQP',
        fixtures: ['amqpClient'],
        testType: 'integration',
        category: 'AMQ',
        variants: one({
            packages: ['amqplib'],
            config: [{ path: ['amqp'], value: { url: 'amqp://testuser:testpass@localhost:5672' } }],
            env: [section('amqp', 'RabbitMQ / AMQP', [{ name: 'PW_AMQP_URL', value: 'amqp://testuser:testpass@localhost:5672' }])],
            services: [SERVICES.rabbitmq],
        }),
        starter: {
            file: 'amqp',
            describe: 'RabbitMQ — starter',
            title: 'a message sent to a queue can be taken',
            params: 'amqpClient, testData',
            setup: "const queue = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Make a queue (deleted after the test) and send to it', code: "await amqpClient.assertQueue(queue);\nawait amqpClient.sendToQueue(queue, 'hello');" },
                { name: 'Step 2: Take it', code: "const [message] = await amqpClient.consume(queue, { count: 1, timeout: 5000 });\nexpect(message.body.toString()).toBe('hello');" },
            ],
        },
    },
    {
        id: 's3',
        label: 'AWS S3',
        fixtures: ['s3Client'],
        testType: 'integration',
        category: 'AWS',
        variants: one({
            packages: ['@aws-sdk/client-s3'],
            config: [...AWS_CONFIG, { path: ['aws', 's3'], value: { bucket: 'tests' } }],
            env: [AWS_ENV, section('s3', 'S3', [{ name: 'PW_AWS_S3_BUCKET', value: 'tests' }])],
            services: [SERVICES.moto],
        }),
        starter: {
            file: 's3',
            describe: 'S3 — starter',
            title: 'an object put can be read',
            params: 's3Client, testData',
            setup: "const bucket = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Make a bucket (deleted after the test)', code: 'await s3Client.createBucket(bucket);' },
                {
                    name: 'Step 2: Put an object and read it back',
                    code: "await s3Client.putObject('hello.json', { hello: 'world' }, { bucket });\nexpect((await s3Client.getObject('hello.json', { bucket })).json()).toEqual({ hello: 'world' });",
                },
            ],
        },
    },
    {
        id: 'sqs',
        label: 'AWS SQS / SNS',
        fixtures: ['sqsClient'],
        testType: 'integration',
        category: 'AWS',
        variants: one({ packages: ['@aws-sdk/client-sqs', '@aws-sdk/client-sns'], config: [...AWS_CONFIG], env: [AWS_ENV], services: [SERVICES.moto] }),
        starter: {
            file: 'sqs',
            describe: 'SQS — starter',
            title: 'a message sent to a queue can be received',
            params: 'sqsClient, testData',
            setup: "const queue = testData.unique('starter');",
            steps: [
                { name: 'Step 1: Make a queue (deleted after the test) and send to it', code: "await sqsClient.createQueue(queue);\nawait sqsClient.send(queue, { hello: 'world' });" },
                { name: 'Step 2: Receive it', code: "const [message] = await sqsClient.receive(queue, { count: 1, timeout: 5000 });\nexpect(message.json()).toEqual({ hello: 'world' });" },
            ],
        },
    },
    {
        id: 'dynamodb',
        label: 'AWS DynamoDB',
        fixtures: ['dynamoDbClient'],
        testType: 'integration',
        category: 'DDB',
        variants: one({ packages: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'], config: [...AWS_CONFIG], env: [AWS_ENV], services: [SERVICES.moto] }),
        starter: {
            file: 'dynamodb',
            describe: 'DynamoDB — starter',
            title: 'an item put can be read',
            params: 'dynamoDbClient',
            setup: "const table = dynamoDbClient.tableName('starter');",
            steps: [
                { name: 'Step 1: Make a table (deleted after the test)', code: "await dynamoDbClient.createTable(table, { key: { id: 'S' } });" },
                { name: 'Step 2: Put an item and read it back', code: "await dynamoDbClient.put(table, { id: '1', hello: 'world' });\nexpect(await dynamoDbClient.get(table, { id: '1' })).toMatchObject({ hello: 'world' });" },
            ],
        },
    },
    {
        id: 'search',
        label: 'Elasticsearch / OpenSearch',
        fixtures: ['searchClient'],
        testType: 'integration',
        category: 'SRCH',
        variants: [searchVariant('elasticsearch', 'Elasticsearch', 9200, SERVICES.elasticsearch), searchVariant('opensearch', 'OpenSearch', 9201, SERVICES.opensearch)],
        starter: {
            file: 'search',
            describe: 'Search — starter',
            title: 'a document indexed can be found',
            params: 'searchClient',
            setup: "const index = searchClient.indexName('starter');",
            steps: [
                { name: 'Step 1: Index a document in an index of the test\'s own', code: "await searchClient.index(index, { title: 'hello world' });" },
                { name: 'Step 2: Search for it', code: "expect((await searchClient.search(index, { match: { title: 'hello' } })).total).toBe(1);" },
            ],
        },
    },
    {
        id: 'inbox',
        label: 'Email inbox (Mailpit)',
        fixtures: ['inboxClient'],
        testType: 'integration',
        category: 'EML',
        variants: one({
            packages: [],
            config: [{ path: ['inbox'], value: { url: 'http://localhost:8025', smtpHost: 'localhost', smtpPort: 1025 } }],
            env: [
                section('inbox', 'Email inbox (Mailpit)', [
                    { name: 'PW_INBOX_URL', value: 'http://localhost:8025' },
                    { name: 'PW_INBOX_SMTP_HOST', value: 'localhost' },
                    { name: 'PW_INBOX_SMTP_PORT', value: '1025' },
                ]),
            ],
            services: [SERVICES.mailpit],
        }),
        starter: {
            file: 'inbox',
            describe: 'Inbox — starter',
            title: 'a message sent arrives',
            params: 'inboxClient',
            setup: "const to = inboxClient.uniqueAddress('starter');",
            steps: [
                { name: 'Step 1: Send to an address of the test\'s own', code: "await inboxClient.send({ from: 'app@example.test', to, subject: 'Hello' });" },
                { name: 'Step 2: Wait for it', code: "expect((await inboxClient.waitForMessage({ to })).subject).toBe('Hello');" },
            ],
        },
        next: 'Point your application\'s SMTP settings at Mailpit (localhost:1025) for the tests.',
    },
    {
        id: 'mock',
        label: 'Mock server (WireMock)',
        fixtures: ['mockServer'],
        testType: 'integration',
        category: 'MCK',
        variants: one({
            packages: [],
            config: [{ path: ['mock'], value: { url: 'http://localhost:8089' } }],
            env: [section('mock', 'Mock server (WireMock)', [{ name: 'PW_MOCK_URL', value: 'http://localhost:8089' }])],
            services: [SERVICES.wiremock],
        }),
        starter: {
            file: 'mock-server',
            describe: 'Mock server — starter',
            title: 'a stubbed call answers and is recorded',
            params: 'mockServer, testData',
            setup: "const path = `/${testData.unique('starter')}`;",
            steps: [
                { name: 'Step 1: Stub a path of the test\'s own', code: 'await mockServer.stub({ path }, { json: { ok: true } });' },
                {
                    name: 'Step 2: Call it and check the call was recorded',
                    code: 'expect(await (await fetch(`${mockServer.url}${path}`)).json()).toEqual({ ok: true });\nawait mockServer.verify({ path }, { times: 1 });',
                },
            ],
        },
        next: 'Point your application at mockServer.url instead of the third-party API.',
    },
    {
        id: 'otp',
        label: 'One-time passwords (TOTP / HOTP)',
        fixtures: ['otpClient'],
        testType: 'api',
        category: 'OTP',
        variants: one({
            packages: ['otplib'],
            config: [{ path: ['otp'], value: { digits: 6, period: 30 } }],
            env: [section('otp', 'One-time passwords', [{ name: 'PW_OTP_SECRET', value: '', optional: true }])],
            services: [],
        }),
        starter: {
            file: 'otp',
            describe: 'OTP — starter',
            title: 'a generated code verifies',
            params: 'otpClient',
            steps: [
                {
                    name: 'Step 1: Generate a secret and a code, and verify it',
                    code: 'const secret = otpClient.generateSecret();\nconst code = await otpClient.generateTotp(secret);\nexpect(await otpClient.verifyTotp(code, secret)).toBe(true);',
                },
            ],
        },
    },
    {
        id: 'appium',
        label: 'Appium (mobile)',
        fixtures: ['appiumDriver'],
        testType: 'mobile',
        category: 'APM',
        variants: one({
            packages: ['webdriverio'],
            config: [{ path: ['appium'], value: { serverUrl: 'http://127.0.0.1:4723', platform: 'android', deviceName: 'emulator-5554' } }],
            env: [
                section('appium', 'Appium', [
                    { name: 'PW_APPIUM_SERVER_URL', value: 'http://127.0.0.1:4723' },
                    { name: 'PW_APPIUM_PLATFORM', value: 'android' },
                    { name: 'PW_APPIUM_APP', value: './app.apk', optional: true },
                ]),
            ],
            services: [],
        }),
        starter: {
            file: 'appium',
            describe: 'Appium — starter',
            title: 'a session starts on the device',
            params: 'appiumDriver',
            steps: [{ name: 'Step 1: Check the session', code: 'expect(appiumDriver.sessionId).toBeTruthy();' }],
        },
        next: 'Start Appium (`npx appium`) and a device or emulator; set appium.app or the capabilities for your app.',
    },
];

/** The catalog entry for `id` (case-insensitive), or for a fixture name like `redisClient`. */
export function catalogEntry(id: string): CatalogEntry | undefined {
    const key = id.toLowerCase();
    return FIXTURE_CATALOG.find((e) => e.id === key || e.fixtures.some((f) => f.toLowerCase() === key));
}

/** Every package any variant of `entry` installs. */
export function allPackages(entry: CatalogEntry): string[] {
    return [...new Set(entry.variants.flatMap((v) => v.packages))];
}

/** The starter test's source, with `id` as its TestCaseID. */
export function starterSource(entry: CatalogEntry, id: string): string {
    const { starter } = entry;
    const indent = (code: string, spaces: number) =>
        code
            .split('\n')
            .map((l) => `${' '.repeat(spaces)}${l}`)
            .join('\n');
    const steps = starter.steps.map((s) => `        await test.step('${s.name.replace(/'/g, "\\'")}', async () => {\n${indent(s.code, 12)}\n        });`).join('\n\n');
    return `import { test, expect } from '@inluxc/propmaster';

/** Starter test from \`propmaster fixture add ${entry.id}\`: replace it with your own. */
test.describe('${starter.describe}', () => {
    test('[${id}] ${starter.title}', { tag: ['@${id}'] }, async ({ ${starter.params} }) => {
${starter.setup ? `${indent(starter.setup, 8)}\n\n` : ''}${steps}
    });
});
`;
}
