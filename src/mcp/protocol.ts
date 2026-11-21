/**
 * A minimal Model Context Protocol server: JSON-RPC 2.0 over stdio, one
 * message per line. It implements what an MCP client needs to list and call
 * tools (`initialize`, `ping`, `tools/list`, `tools/call`), with no SDK
 * dependency.
 *
 * stdout carries protocol messages only. Logs go to stderr.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON Schema for a tool's arguments (an object schema). */
export interface JsonSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface ToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface ToolDefinition {
    name: string;
    title?: string;
    description: string;
    inputSchema: JsonSchema;
    annotations?: ToolAnnotations;
    /** Runs the tool. The result is sent as JSON text; a thrown error becomes `isError: true`. */
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolCallResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export const ErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
} as const;

export interface McpServerOptions {
    name: string;
    version: string;
    instructions?: string;
    tools: ToolDefinition[];
    /** Called after each tool call, for logging. */
    onToolCall?: (event: { name: string; args: Record<string, unknown>; ok: boolean; ms: number; error?: string }) => void;
}

/** Thrown by a tool for a bad argument: reported to the agent as a tool error. */
export class ToolInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolInputError';
    }
}

export class McpServer {
    private readonly tools: Map<string, ToolDefinition>;

    constructor(private readonly options: McpServerOptions) {
        this.tools = new Map(options.tools.map((t) => [t.name, t]));
    }

    get toolNames(): string[] {
        return [...this.tools.keys()];
    }

    /**
     * Handles one parsed JSON-RPC message. Returns the response, or `undefined`
     * for a notification (no `id`), which gets no reply.
     */
    async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
        if (!isRequest(message)) {
            return rpcError(null, ErrorCode.InvalidRequest, 'Invalid JSON-RPC request');
        }
        const isNotification = message.id === undefined;
        const id = message.id ?? null;

        try {
            const result = await this.dispatch(message.method, message.params ?? {});
            return isNotification ? undefined : { jsonrpc: '2.0', id, result };
        } catch (error) {
            if (isNotification) return undefined;
            if (error instanceof RpcError) return rpcError(id, error.code, error.message);
            return rpcError(id, ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
        }
    }

    /** Parses one line and handles it. */
    async handleLine(line: string): Promise<JsonRpcResponse | undefined> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            return rpcError(null, ErrorCode.ParseError, 'Parse error: not valid JSON');
        }
        return this.handle(parsed);
    }

    private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case 'initialize': {
                const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
                const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
                return {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: this.options.name, version: this.options.version },
                    ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
                };
            }
            case 'ping':
                return {};
            case 'tools/list':
                return {
                    tools: [...this.tools.values()].map(({ handler: _handler, ...tool }) => tool),
                };
            case 'tools/call':
                return this.callTool(params);
            default:
                // Notifications (initialized, cancelled, ...) need no handling.
                if (method.startsWith('notifications/')) return {};
                throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
        }
    }

    private async callTool(params: Record<string, unknown>): Promise<ToolCallResult> {
        const name = params.name;
        if (typeof name !== 'string') throw new RpcError(ErrorCode.InvalidParams, 'tools/call needs a tool name');
        const tool = this.tools.get(name);
        if (!tool) throw new RpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const started = Date.now();
        try {
            const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
            if (missing.length > 0) throw new ToolInputError(`Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

            const value = await tool.handler(args);
            this.options.onToolCall?.({ name, args, ok: true, ms: Date.now() - started });
            const text = typeof value === 'string' ? value : JSON.stringify(value, jsonReplacer, 2);
            const result: ToolCallResult = { content: [{ type: 'text', text }] };
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                result.structuredContent = JSON.parse(JSON.stringify(value, jsonReplacer)) as Record<string, unknown>;
            }
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.onToolCall?.({ name, args, ok: false, ms: Date.now() - started, error: message });
            return { content: [{ type: 'text', text: message }], isError: true };
        }
    }
}

class RpcError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
    }
}

function isRequest(value: unknown): value is JsonRpcRequest {
    return value !== null && typeof value === 'object' && (value as JsonRpcRequest).jsonrpc === '2.0'
        && typeof (value as JsonRpcRequest).method === 'string';
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/** JSON for values JSON.stringify can't encode: BigInt, Buffers, Dates stay readable. */
export function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
        return `<${(value as { data: unknown[] }).data.length} bytes>`;
    }
    return value;
}

/**
 * Serves the server over a pair of streams, one JSON message per line.
 * Resolves when the input ends.
 */
export function serveStdio(
    server: McpServer,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
    return new Promise((resolve) => {
        let buffer = '';
        let pending = Promise.resolve();
        input.setEncoding?.('utf8');
        input.on('data', (chunk: string | Buffer) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) continue;
                // Answer each request as soon as it's done; order isn't required by JSON-RPC.
                const work = server.handleLine(line).then((response) => {
                    if (response) output.write(JSON.stringify(response, jsonReplacer) + '\n');
                });
                pending = pending.then(() => work.catch(() => { }));
            }
        });
        input.on('end', () => {
            void pending.then(() => resolve());
        });
    });
}
