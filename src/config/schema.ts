/**
 * Configuration schema types for the Playwright Framework Template.
 *
 * Defines all configuration interfaces used across the framework,
 * including fixture-specific configs, secrets config, and the
 * top-level FrameworkConfig that composes them.
 */

/**
 * SASL authentication options for Kafka connections.
 */
export interface SASLOptions {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
}

/**
 * Configuration for the OpenAPI client fixture.
 */
export interface OpenApiFixtureConfig {
    /** Local file path or remote URL to the OpenAPI specification. */
    specPath: string;
    /** Override base URL for API calls (takes precedence over spec server URLs). */
    baseUrl?: string;
    /** Timeout in ms for remote spec retrieval (default: 10000). */
    specTimeout?: number;
    /** Timeout in ms for client initialization (default: 30000). */
    initTimeout?: number;
    /**
     * Check every response against the spec: its status, content type and
     * body schema. `true` fails the call on a mismatch, `'warn'` records it
     * on the test and goes on. Needs `ajv` and `ajv-formats`. Default: off.
     */
    validateResponses?: boolean | 'warn';
    /** Check request bodies against the spec before they're sent (`true` or `'warn'`). Default: off. */
    validateRequests?: boolean | 'warn';
}

/**
 * Run a backend in a throwaway Docker container (Testcontainers) instead of
 * connecting to a host and port. Needs Docker and the optional
 * `testcontainers` package. The container starts the first time a test in a
 * worker uses the fixture and stops when the worker exits.
 */
export interface ContainerOptions {
    /** Image to run (default: the same image Stagehand's CI uses for that backend). */
    image?: string;
    /**
     * Keep the container running between test runs and reuse it (Testcontainers
     * reuse mode; also needs `TESTCONTAINERS_REUSE_ENABLE=true`). Not available for Kafka.
     */
    reuse?: boolean;
    /** Seconds to wait for the container's health check (default: 60, 120 for MSSQL and Neo4j). */
    startupTimeout?: number;
    /**
     * SQL files to run once after the database starts, in order (database fixture:
     * PostgreSQL, MySQL and MSSQL). Paths are relative to the working directory.
     */
    initScripts?: string[];
}

/** `true` for the defaults, or options. `false`/absent connects to `host`/`port` as usual. */
export type ContainerSetting = boolean | ContainerOptions;

/**
 * Configuration for the database connection fixture.
 */
export interface DatabaseFixtureConfig {
    /** Database engine type. */
    type: 'postgresql' | 'mysql' | 'mssql' | 'sqlite';
    /** Database server host. */
    host?: string;
    /** Database server port. */
    port?: number;
    /** Database name. */
    database: string;
    /** Database username. */
    username?: string;
    /** Database password. */
    password?: string;
    /** Connection timeout in ms (default: 10000). */
    connectionTimeout?: number;
    /** Query execution timeout in ms (default: 30000). */
    queryTimeout?: number;
    /** Whether to encrypt the connection (MSSQL: default true). */
    encrypt?: boolean;
    /** Whether to trust the server certificate (MSSQL: useful for local dev). */
    trustServerCertificate?: boolean;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the Kafka integration fixture.
 */
export interface KafkaFixtureConfig {
    /** List of Kafka broker addresses (host:port). */
    brokers: string[];
    /** Kafka client identifier. */
    clientId?: string;
    /** Whether to use SSL for broker connections. */
    ssl?: boolean;
    /** SASL authentication options. */
    sasl?: SASLOptions;
    /** Timeout in ms for disconnect operations (default: 5000). */
    disconnectTimeout?: number;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the RabbitMQ / AMQP 0-9-1 fixture (`amqpClient`).
 * Give either `url` or `host` (plus port, credentials and vhost).
 */
export interface AmqpFixtureConfig {
    /** Broker URL, e.g. `amqp://user:pass@localhost:5672/vhost` (`amqps://` for TLS). Wins over host/port/credentials. */
    url?: string;
    /** Broker host. */
    host?: string;
    /** Broker port (default: 5672, 5671 with `tls`). */
    port?: number;
    username?: string;
    password?: string;
    /** Virtual host (default: `/`). */
    vhost?: string;
    /** Connect with TLS (`amqps`). */
    tls?: boolean;
    /** Heartbeat interval in seconds (default: the broker's; 0 turns heartbeats off). */
    heartbeat?: number;
    /** Connection timeout in ms (default: 10000). */
    connectionTimeout?: number;
    /** Default wait for `consume()`, `listener.messages()` and `waitForMessage()` in ms (default: 10000). */
    timeout?: number;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the AWS fixtures (`s3Client`, `sqsClient`): one config for
 * every service, pointed at an emulator (Moto, LocalStack) with `endpoint` or
 * at a real test account without it.
 */
export interface AwsFixtureConfig {
    /** Region (default: AWS_REGION / AWS_DEFAULT_REGION, else `us-east-1` with an endpoint). */
    region?: string;
    /** Emulator URL for every service, e.g. `http://localhost:5000` (Moto) or `http://localhost:4566` (LocalStack). */
    endpoint?: string;
    /** Static credentials. Without them the standard AWS chain is used (env, profile, SSO, instance role); with an endpoint, `test`/`test`. */
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    /** A profile from ~/.aws/config for the standard chain. */
    profile?: string;
    /** Path-style S3 URLs (`endpoint/bucket/key`). Default: true with an endpoint, false without. */
    forcePathStyle?: boolean;
    s3?: {
        /** Bucket used when a call doesn't name one. */
        bucket?: string;
        /** Root of the per-test prefix (default: `propmaster-tests/`). */
        prefix?: string;
    };
    /** Default wait for `waitForObject()`, `receive()` and `waitForMessage()` in ms (default: 10000). */
    timeout?: number;
    /** Start Moto (an AWS emulator) in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the search fixture (`searchClient`): Elasticsearch or
 * OpenSearch over their REST API.
 */
export interface SearchFixtureConfig {
    /** Cluster URL, e.g. `http://localhost:9200`. */
    url?: string;
    /** Basic auth (Elasticsearch `elastic` user, OpenSearch `admin`, or any other). */
    username?: string;
    password?: string;
    /** Elasticsearch API key (the base64 `id:key` value), sent as `Authorization: ApiKey ...`. */
    apiKey?: string;
    /** Extra headers on every request, e.g. a gateway's auth header. */
    headers?: Record<string, string>;
    /** Root of the per-test index prefix (default: `propmaster-tests-`). */
    indexPrefix?: string;
    /** Default wait for `waitForDocument()` and `waitForCount()` in ms, and the request timeout (default: 10000). */
    timeout?: number;
    /**
     * Start a search engine in a Docker container for the run (see ContainerOptions).
     * Elasticsearch by default; an `opensearchproject/opensearch` image starts OpenSearch.
     */
    container?: ContainerSetting;
}

/**
 * TLS for the gRPC fixture. Certificates are PEM text or a path to a PEM file,
 * so they can come from a secrets provider or from disk.
 */
export interface GrpcTlsConfig {
    /** CA certificate(s) to trust instead of the system roots, e.g. a self-signed server's. */
    ca?: string;
    /** Client certificate and key, for servers that want mutual TLS. */
    cert?: string;
    key?: string;
    /** Name to check the server certificate against (and the `:authority`), when it differs from the address. */
    serverName?: string;
    /** Accept any server certificate. For test servers only. */
    insecureSkipVerify?: boolean;
}

/**
 * Configuration for the gRPC fixture (`grpcClient`).
 */
export interface GrpcFixtureConfig {
    /** Server address: `host:port`, or `grpcs://host:port` for TLS (`grpc://` for plaintext). */
    address?: string;
    /** `.proto` files describing the services. Services they don't cover are looked up through server reflection. */
    protoFiles?: string[];
    /** Folders that `import` statements in the proto files are resolved against. */
    includeDirs?: string[];
    /** Look services up through server reflection (default: true). */
    reflection?: boolean;
    /** `true` for TLS with the system roots, or the certificates to use (default: plaintext, unless the address is `grpcs://`). */
    tls?: boolean | GrpcTlsConfig;
    /** Bearer token, sent as `authorization: Bearer <token>` metadata on every call. */
    authToken?: string;
    /** Metadata sent on every call. */
    metadata?: Record<string, string>;
    /** Default deadline per call in ms (default: 10000). */
    timeout?: number;
    /**
     * How messages map to JavaScript objects, as @grpc/proto-loader options
     * (default: `{ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }`).
     */
    loaderOptions?: Record<string, unknown>;
    /** gRPC channel options, e.g. `{ 'grpc.max_receive_message_length': 16777216 }`. */
    channelOptions?: Record<string, string | number>;
}

/**
 * Configuration for the realtime fixture (`realtimeClient`): WebSocket and
 * Server-Sent Events.
 */
export interface RealtimeFixtureConfig {
    /**
     * Base URL that relative URLs resolve against, e.g. `http://localhost:8080`.
     * `connect()` switches http(s) to ws(s) and `subscribe()` switches back, so
     * one URL serves both.
     */
    url?: string;
    /** Headers sent on every connection. */
    headers?: Record<string, string>;
    /** Bearer token, sent as `Authorization: Bearer <token>` on every connection. */
    authToken?: string;
    /** Default wait for a message, in ms (default: 10000). */
    timeout?: number;
    /** Default wait for a connection to open, in ms (default: 10000). */
    connectTimeout?: number;
}

/**
 * Configuration for the Redis integration fixture.
 */
export interface RedisFixtureConfig {
    /** Redis server host. */
    host: string;
    /** Redis server port. */
    port: number;
    /** Redis authentication password. */
    password?: string;
    /** Redis database index. */
    db?: number;
    /** Test-scoped key prefix for isolation. */
    keyPrefix?: string;
    /** Connection timeout in ms (default: 5000). */
    connectionTimeout?: number;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the Neo4j graph database fixture.
 */
export interface Neo4jFixtureConfig {
    /** Connection URI, e.g. `bolt://localhost:7687` or `neo4j://cluster:7687`. */
    uri: string;
    /** Authentication username. */
    username: string;
    /** Authentication password. */
    password: string;
    /** Target database name (default: the server's default database). */
    database?: string;
    /** Connection timeout in ms (default: 10000). */
    connectionTimeout?: number;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * GADS preset for the Appium fixture (https://github.com/shamanec/GADS).
 * When present, `serverUrl` is the GADS hub and sessions go through its `/grid` endpoint.
 */
export interface GadsPresetConfig {
    /** Client secret from GADS Admin → Client credentials (sent as `gads:clientSecret`). */
    clientSecret: string;
    /** Seconds the hub waits for a free device before failing (`gads:queueTimeout`; hub default 10, max 300). */
    queueTimeout?: number;
}

/**
 * Configuration for the Appium fixture. Works with any Appium-compatible server:
 * a local `appium` server, Selenium Grid, a cloud farm, or a GADS hub (set `gads`).
 */
export interface AppiumFixtureConfig {
    /** Appium server URL, e.g. `http://127.0.0.1:4723` (GADS: the hub URL, e.g. `http://gads-hub:10000`). */
    serverUrl: string;
    /** Target platform; sets `platformName` and the default automation engine. */
    platform?: 'ios' | 'android';
    /** Pin one device by UDID (`appium:udid`). */
    udid?: string;
    /**
     * Device name. Plain Appium: sent as `appium:deviceName`.
     * GADS: a case-insensitive regular expression resolved to a UDID from the hub's device list.
     */
    deviceName?: string;
    /** OS version (`appium:platformVersion`). GADS accepts exact (`17.5.1`) or major (`17`). */
    platformVersion?: string;
    /** Appium automation engine (default: XCUITest for iOS, UiAutomator2 for Android). */
    automationName?: string;
    /** App to install: local path, URL, or a cloud/farm app reference (`appium:app`). */
    app?: string;
    /** Seconds of inactivity before the server ends the session (`appium:newCommandTimeout`). */
    newCommandTimeout?: number;
    /** Extra W3C capabilities, e.g. `{ 'appium:bundleId': 'com.example.app' }`. */
    capabilities?: Record<string, unknown>;
    /** Session creation timeout in ms, including device queueing and app install (default: 240000). */
    sessionTimeout?: number;
    /** WebdriverIO log level (default: 'warn' so capabilities and secrets stay out of logs). */
    logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
    /** Route sessions through a GADS hub. */
    gads?: GadsPresetConfig;
}

/**
 * Configuration for the MongoDB connection fixture.
 */
export interface MongoDbFixtureConfig {
    /** Full MongoDB connection URI (overrides host/port/auth fields when provided). */
    uri?: string;
    /** MongoDB server host (default: 'localhost'). */
    host?: string;
    /** MongoDB server port (default: 27017). */
    port?: number;
    /** Database name. */
    database: string;
    /** Authentication username. */
    username?: string;
    /** Authentication password. */
    password?: string;
    /** Authentication source database (default: 'admin'). */
    authSource?: string;
    /** Whether to use mongodb+srv:// protocol (default: false). */
    srv?: boolean;
    /** Connection timeout in ms (default: 10000). */
    connectionTimeout?: number;
    /** Start this backend in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the GraphQL client fixture.
 */
export interface GraphQLFixtureConfig {
    /** GraphQL endpoint URL. */
    endpoint: string;
    /** Default headers to include with every request. */
    headers?: Record<string, string>;
    /** Bearer token for authorization (sets Authorization header). */
    authToken?: string;
    /** Request timeout in ms (default: 30000). */
    requestTimeout?: number;
}

/**
 * Configuration for the OTP (One-Time Password) fixture.
 */
/** Credentials and options for one role (a test user or client identity). */
export interface AuthRoleConfig {
    /** Login name: used by the password grant and by browser login steps. */
    username?: string;
    password?: string;
    /** Per-role OAuth client, when roles use different clients. */
    clientId?: string;
    clientSecret?: string;
    /** Per-role scopes (space-separated), overriding the top-level `scope`. */
    scope?: string;
    /** Anything else your login steps need: an OTP secret, a tenant, an email address. */
    extra?: Record<string, string>;
}

/**
 * Auth helpers: OAuth 2.0 / OIDC access tokens for API and GraphQL calls, and
 * per-role browser login state. Keep secrets out of files: set them with
 * PW_AUTH_* variables or map them from a secrets provider (`keyMappings`).
 */
export interface AuthConfig {
    /** OIDC issuer URL; the token endpoint is read from `<issuer>/.well-known/openid-configuration`. */
    issuer?: string;
    /** Token endpoint, when there's no discovery document (overrides `issuer`). */
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    /** How the client authenticates: HTTP Basic (default) or form fields. */
    clientAuth?: 'basic' | 'post';
    /** Default: `password` for roles with a username, otherwise `client_credentials`. */
    grantType?: 'client_credentials' | 'password';
    /** Space-separated scopes. */
    scope?: string;
    /** `audience` parameter some providers (Auth0, ...) need. */
    audience?: string;
    /** Get a new token this many seconds before the current one expires (default: 60). */
    refreshBeforeExpiry?: number;
    /** Role used when a test doesn't pick one (default: `default`). */
    defaultRole?: string;
    /** Named identities: `test.use({ authRole: 'admin' })` picks one. */
    roles?: Record<string, AuthRoleConfig>;
    /** Credentials for the default role, when `roles` isn't used. */
    username?: string;
    password?: string;
    /** Clients that get `Authorization: Bearer <token>` automatically (default: all three). */
    applyTo?: ('openapi' | 'graphql' | 'grpc' | 'realtime')[];
    /** Folder for saved browser login state (default: `.auth`). */
    stateDir?: string;
}

/**
 * Configuration for the mock-server fixture: a WireMock server that stands in
 * for the third-party APIs your application calls.
 */
export interface MockServerConfig {
    /** Base URL the application under test calls, e.g. `http://localhost:8089`. */
    url: string;
    /** Admin API URL when it differs from `url` (default: `url`). */
    adminUrl?: string;
    /** Start WireMock in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

/**
 * Configuration for the inbox fixture: a test mail server (Mailpit) that
 * catches the email your application sends.
 */
export interface InboxFixtureConfig {
    /** Mailpit web/API URL, e.g. `http://localhost:8025`. */
    url: string;
    /** SMTP host your application should send to; exposed as `inboxClient.smtp` (informational). */
    smtpHost?: string;
    /** SMTP port your application should send to (Mailpit default: 1025). */
    smtpPort?: number;
    /** Domain for `uniqueAddress()` (default: `test.local`). */
    domain?: string;
    /** Default `waitForMessage()` timeout in ms (default: 30000). */
    timeout?: number;
    /** How often to check for new mail in ms (default: 500). */
    pollInterval?: number;
    /** Basic-auth user, when Mailpit's UI/API is protected (`MP_UI_AUTH`). */
    username?: string;
    /** Basic-auth password. */
    password?: string;
    /** Start Mailpit in a Docker container for the run (see ContainerOptions). */
    container?: ContainerSetting;
}

export interface OtpFixtureConfig {
    /** Base32-encoded secret key for TOTP/HOTP generation. */
    secret?: string;
    /** Number of digits in the generated token (default: 6). */
    digits?: number;
    /** Time step period in seconds for TOTP (default: 30). */
    period?: number;
    /** Verification window — number of periods to check before/after current (default: 1). */
    window?: number;
    /** Hash algorithm (default: 'sha1'). */
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    /** Issuer name for otpauth:// URI generation. */
    issuer?: string;
}

/**
 * Configuration for the secrets provider.
 */
export interface SecretsConfig {
    /** Provider backend name (e.g., 'aws', 'vault', 'openbao', 'gitlab', 'azure', 'env-file'). */
    provider: string;
    /** Provider-specific options (region, vault URL, etc.). */
    options?: Record<string, unknown>;
    /** Maps secret key → Connection_Config field path. */
    keyMappings?: Record<string, string>;
    /** Fetch timeout in ms (default: 10000). */
    timeout?: number;
}

/**
 * Top-level framework configuration combining all fixture configs.
 */
export interface FrameworkConfig {
    /** Active environment name (local, dev, test, stg, prod). */
    environment: string;
    /** OpenAPI client fixture configuration. */
    openapi?: OpenApiFixtureConfig;
    /** Database fixture configuration. */
    database?: DatabaseFixtureConfig;
    /** Kafka fixture configuration. */
    kafka?: KafkaFixtureConfig;
    /** RabbitMQ / AMQP fixture configuration. */
    amqp?: AmqpFixtureConfig;
    /** AWS (S3, SQS, SNS) fixture configuration. */
    aws?: AwsFixtureConfig;
    /** Elasticsearch / OpenSearch fixture configuration. */
    search?: SearchFixtureConfig;
    /** gRPC fixture configuration. */
    grpc?: GrpcFixtureConfig;
    /** Realtime (WebSocket / SSE) fixture configuration. */
    realtime?: RealtimeFixtureConfig;
    /** Redis fixture configuration. */
    redis?: RedisFixtureConfig;
    /** MongoDB fixture configuration. */
    mongodb?: MongoDbFixtureConfig;
    /** Neo4j fixture configuration. */
    neo4j?: Neo4jFixtureConfig;
    /** Appium fixture configuration (local Appium, grids, cloud farms, GADS). */
    appium?: AppiumFixtureConfig;
    /** OTP fixture configuration. */
    otp?: OtpFixtureConfig;
    /** Auth helpers: OAuth/OIDC tokens and per-role browser login state. */
    auth?: AuthConfig;
    /** Mock-server (WireMock) fixture configuration. */
    mock?: MockServerConfig;
    /** Inbox (test mail server) fixture configuration. */
    inbox?: InboxFixtureConfig;
    /** GraphQL client fixture configuration. */
    graphql?: GraphQLFixtureConfig;
    /** Secrets provider configuration. */
    secrets?: SecretsConfig;
}

/**
 * Structure of the environments.json configuration file.
 */
export interface EnvironmentsFile {
    /** Map of environment name to its partial configuration. */
    environments: Record<string, Partial<FrameworkConfig>>;
}
