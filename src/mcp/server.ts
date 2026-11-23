/**
 * `propmaster mcp`: an MCP server that gives coding agents the project's
 * backends (database, MongoDB, Redis, Kafka, Neo4j, OpenAPI spec, OTP) and the
 * test-convention tools, using the same environments.json, .env files, PW_*
 * variables and secrets provider as the tests.
 *
 *   npx propmaster mcp [--environment <name>] [--allow-writes] [--allow-prod] [--root <dir>]
 *
 * Read-only by default. Environments named prod/production/prd/live, or
 * marked "production": true in environments.json, are refused unless
 * --allow-prod is passed, and never get write tools.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigLoader } from '../config/loader.js';
import type { FrameworkConfig } from '../config/schema.js';
import { findProjectRoot } from '../cli/check-tests.js';
import { redactCredentials, truncate } from '../annotations/truncation.js';
import { SecretsManager } from '../secrets/secrets-manager.js';
import { createProvider } from '../secrets/providers/index.js';
import { isProductionEnvironment } from './guards.js';
import { markedProduction } from '../cli/env.js';
import { McpServer, serveStdio, type ToolDefinition } from './protocol.js';
import { Connections, createTools, type McpContext } from './tools.js';

export interface McpOptions {
    root: string;
    environment?: string;
    allowWrites: boolean;
    allowProd: boolean;
}

export const MCP_HELP = `
  propmaster mcp: MCP server for coding agents

  Usage:
    npx propmaster mcp [--environment <name>] [--allow-writes] [--allow-prod] [--root <dir>]

  Gives an MCP client (Claude Code, VS Code, Cursor, ...) read tools for the
  backends configured for the environment, plus next_test_id and check_tests.
  Talks MCP over stdio; logs go to stderr.

  Options:
    --environment, -e  Environment to use (default: PW_ENVIRONMENT, else local)
    --allow-writes     Also offer write tools (db_execute, mongo_insert, redis_set,
                       kafka_produce, neo4j_write, ...). Never in production.
    --allow-prod       Allow a production environment (prod, production, prd,
                       live, or "production": true in environments.json), read-only
    --root <dir>       Project root (default: nearest package.json)
`;

export function parseMcpArgs(argv: string[], cwd: string = process.cwd()): McpOptions | { help: true } | { error: string } {
    const options: McpOptions = { root: '', allowWrites: false, allowProd: false };
    let root: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('-')) throw new Error(`${arg} needs a value`);
            return v;
        };
        try {
            if (arg === '--help' || arg === '-h') return { help: true };
            else if (arg === '--allow-writes') options.allowWrites = true;
            else if (arg === '--allow-prod') options.allowProd = true;
            else if (arg === '--environment' || arg === '-e') options.environment = value();
            else if (arg.startsWith('--environment=')) options.environment = arg.slice('--environment='.length);
            else if (arg === '--root') root = value();
            else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
            else return { error: `Unknown option: ${arg}` };
        } catch (error) {
            return { error: (error as Error).message };
        }
    }
    options.root = root ? resolve(cwd, root) : findProjectRoot(cwd);
    return options;
}

/** Config values that look like credentials, for scrubbing tool output. */
export function secretValues(value: unknown, key = '', out: Set<string> = new Set()): Set<string> {
    if (typeof value === 'string') {
        if (/pass(word)?|secret|token|api[-_]?key|credential|private/i.test(key) && value.length >= 4) out.add(value);
        // user:password@ in connection URIs
        const userInfo = /\/\/[^:/@\s]+:([^@/\s]+)@/.exec(value);
        if (userInfo && userInfo[1].length >= 4) out.add(decodeURIComponentSafe(userInfo[1]));
    } else if (Array.isArray(value)) {
        for (const item of value) secretValues(item, key, out);
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) secretValues(v, k, out);
    }
    return out;
}

function decodeURIComponentSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/** Replaces each secret (raw and JSON-escaped) with [REDACTED], then applies the pattern redaction. */
export function makeRedactor(secrets: Set<string>): (text: string) => string {
    const needles = [...secrets].flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]).sort((a, b) => b.length - a.length);
    return (text) => {
        let out = text;
        for (const needle of needles) out = out.split(needle).join('[REDACTED]');
        return redactCredentials(out);
    };
}

/** Wraps each tool so its result and errors are scrubbed of credentials. */
function redactTools(tools: ToolDefinition[], redact: (text: string) => string): ToolDefinition[] {
    return tools.map((tool) => ({
        ...tool,
        handler: async (args) => {
            try {
                const value = await tool.handler(args);
                return JSON.parse(redact(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
            } catch (error) {
                throw new Error(redact(error instanceof Error ? error.message : String(error)));
            }
        },
    }));
}

function packageVersion(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
            if (pkg.name === '@inluxc/propmaster') return pkg.version ?? '0.0.0';
        } catch {
            // keep looking
        }
        dir = dirname(dir);
    }
    return '0.0.0';
}

async function loadConfig(root: string, environment?: string): Promise<{ config?: FrameworkConfig; error?: string; secretsError?: string }> {
    let config: FrameworkConfig;
    try {
        config = new ConfigLoader(root).load(environment);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    if (config.secrets?.provider) {
        try {
            const manager = new SecretsManager();
            manager.registerProvider(createProvider(config.secrets.provider, config.secrets.options ?? {}));
            config = await manager.resolve(config);
        } catch (error) {
            // Carry on with the values from the files and PW_* variables.
            return { config, secretsError: error instanceof Error ? error.message : String(error) };
        }
    }
    return { config };
}

export interface CreatedServer {
    server: McpServer;
    context: McpContext;
    close: () => Promise<void>;
}

/**
 * Builds the server for a project. Throws when the environment is production
 * and --allow-prod wasn't given.
 */
export async function createPropmasterMcpServer(
    options: McpOptions,
    log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<CreatedServer> {
    const { config, error, secretsError } = await loadConfig(options.root, options.environment);
    const environment = config?.environment ?? options.environment ?? process.env.PW_ENVIRONMENT ?? 'local';
    const production = isProductionEnvironment(environment) || config?.production === true || markedProduction(options.root, environment);

    if (production && !options.allowProd) {
        throw new Error(`Refusing to start for environment "${environment}": it's a production environment. Pass --allow-prod to allow it (read-only).`);
    }
    let allowWrites = options.allowWrites;
    if (production && allowWrites) {
        log(`propmaster-mcp: --allow-writes ignored: "${environment}" is a production environment, so write tools stay off.`);
        allowWrites = false;
    }

    if (secretsError) log(`propmaster-mcp: secrets not resolved, using values from environments.json, .env and PW_* variables: ${redactCredentials(secretsError)}`);

    const context: McpContext = { root: options.root, environment, config, configError: error, allowWrites };
    const connections = new Connections();
    const redact = makeRedactor(secretValues(config));
    const tools = redactTools(createTools(context, connections), redact);

    const server = new McpServer({
        name: 'propmaster',
        version: packageVersion(),
        instructions: [
            `Propmaster test backends for environment "${environment}".`,
            allowWrites ? 'Write tools are enabled: data you change stays changed.' : 'Read-only: the server offers no write tools.',
            'Use environment_info to see which backends are configured, next_test_id before adding a test, and check_tests after changing tests.',
        ].join(' '),
        tools,
        onToolCall: ({ name, args, ok, ms, error: message }) => {
            const shownArgs = truncate(redact(JSON.stringify(args)), 500);
            log(`propmaster-mcp: ${name} ${shownArgs} → ${ok ? 'ok' : `error: ${truncate(redact(message ?? ''), 300)}`} (${ms} ms)`);
        },
    });

    log(`propmaster-mcp: environment "${environment}", ${allowWrites ? 'backend writes enabled' : 'backends read-only'}, ${server.toolNames.length} tools${error ? ` (config not loaded: ${redact(error)})` : ''}`);
    return { server, context, close: () => connections.closeAll() };
}

/** `propmaster mcp`: serves over stdio until the client disconnects. */
export async function runMcp(argv: string[]): Promise<number> {
    const parsed = parseMcpArgs(argv);
    if ('help' in parsed) {
        process.stderr.write(MCP_HELP);
        return 0;
    }
    if ('error' in parsed) {
        process.stderr.write(`propmaster mcp: ${parsed.error}\n${MCP_HELP}`);
        return 2;
    }

    let created: CreatedServer;
    try {
        created = await createPropmasterMcpServer(parsed);
    } catch (error) {
        process.stderr.write(`propmaster-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }

    const stop = async () => {
        await created.close();
        process.exit(0);
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());

    await serveStdio(created.server);
    await created.close();
    return 0;
}
