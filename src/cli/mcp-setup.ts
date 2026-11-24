/**
 * `propmaster mcp setup`: connects the Propmaster MCP server to each editor,
 * by writing the config file that editor reads.
 *
 *   npx propmaster mcp setup                          pick the editors from a menu
 *   npx propmaster mcp setup --client claude,vscode   Claude Code and VS Code
 *   npx propmaster mcp setup -e dev --allow-writes    server for "dev", with write tools
 *   npx propmaster mcp setup --check                  start each configured server and list its tools
 *   npx propmaster mcp setup --remove                 take the entry out again
 *
 * The `propmaster` entry is added next to the servers already in the file,
 * and every other byte of the file stays as it was. Running it again changes
 * nothing; `--remove` gives back the file as it was.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot } from './check-tests.js';
import { objectAt, parseJsonSpans, removeMember, sameJson, setMember, type JsonEditOptions } from './json-edit.js';
import { isInteractive, multiselect, type Choice } from './prompts.js';
import { styleFor } from './style.js';
import { packageManager, type PackageManager } from '../package-manager.js';

export type ClientId = 'claude' | 'vscode' | 'cursor' | 'windsurf' | 'zed';

export interface ServerEntry {
    command: string;
    args: string[];
}

export interface McpClient {
    id: ClientId;
    name: string;
    /** The config file, relative to the project (or absolute, for a file in the home folder). */
    file: (ctx: SetupContext) => string;
    /** Keys from the file's root to the object that holds the servers. */
    serversPath: string[];
    /** The file is shared by every project on the machine (Windsurf): the entry has absolute paths and a name per project. */
    global?: boolean;
    jsonc?: boolean;
    /** Signs that the project uses this editor. */
    detect: (ctx: SetupContext) => boolean;
    /** The entry as this editor writes it. */
    entry: (server: ServerEntry) => Record<string, unknown>;
}

export interface SetupContext {
    root: string;
    /** The home folder, for editors with one config for the machine (tests replace it). */
    home: string;
}

const exists = (ctx: SetupContext, ...parts: string[]) => fs.existsSync(path.join(ctx.root, ...parts));

export const MCP_CLIENTS: McpClient[] = [
    {
        id: 'claude',
        name: 'Claude Code',
        file: () => '.mcp.json',
        serversPath: ['mcpServers'],
        detect: (ctx) => exists(ctx, '.mcp.json') || exists(ctx, '.claude') || exists(ctx, 'CLAUDE.md'),
        entry: (s) => ({ command: s.command, args: s.args }),
    },
    {
        id: 'vscode',
        name: 'VS Code',
        file: () => '.vscode/mcp.json',
        serversPath: ['servers'],
        jsonc: true,
        detect: (ctx) => exists(ctx, '.vscode'),
        entry: (s) => ({ type: 'stdio', command: s.command, args: s.args }),
    },
    {
        id: 'cursor',
        name: 'Cursor',
        file: () => '.cursor/mcp.json',
        serversPath: ['mcpServers'],
        detect: (ctx) => exists(ctx, '.cursor') || exists(ctx, '.cursorrules'),
        entry: (s) => ({ command: s.command, args: s.args }),
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        file: (ctx) => path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
        serversPath: ['mcpServers'],
        global: true,
        detect: (ctx) => exists(ctx, '.windsurf') || exists(ctx, '.windsurfrules'),
        entry: (s) => ({ command: s.command, args: s.args }),
    },
    {
        id: 'zed',
        name: 'Zed',
        file: () => '.zed/settings.json',
        serversPath: ['context_servers'],
        jsonc: true,
        detect: (ctx) => exists(ctx, '.zed'),
        entry: (s) => ({ source: 'custom', command: s.command, args: s.args }),
    },
];

export const CLIENT_IDS = MCP_CLIENTS.map((c) => c.id);

export function clientById(id: string): McpClient | undefined {
    return MCP_CLIENTS.find((c) => c.id === id);
}

export interface ServerOptions {
    environment?: string;
    allowWrites?: boolean;
    /** The project's package manager, when the caller knows it better than the lock file (init, before there is one). */
    packageManager?: PackageManager;
}

/** `propmaster mcp` with the options, as arguments after the command. */
function serverArgs(options: ServerOptions): string[] {
    return [
        'mcp',
        ...(options.environment ? ['--environment', options.environment] : []),
        ...(options.allowWrites ? ['--allow-writes'] : []),
    ];
}

/**
 * The JavaScript file of the `propmaster` bin the project has installed (or
 * the project's own, in Propmaster itself), for configs shared by every
 * project, where `npx` would run from the wrong folder.
 */
export function installedBin(root: string): string | undefined {
    const fromPackage = (pkgFile: string) => {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as { name?: string; bin?: string | Record<string, string> };
            if (pkg.name !== '@inluxc/propmaster') return undefined;
            const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.propmaster;
            return bin ? path.join(path.dirname(pkgFile), bin) : undefined;
        } catch {
            return undefined;
        }
    };
    return fromPackage(path.join(root, 'node_modules', '@inluxc', 'propmaster', 'package.json')) ?? fromPackage(path.join(root, 'package.json'));
}

/** Entry name in a config shared by every project: `propmaster-<folder>`. */
export function globalEntryName(root: string): string {
    const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `propmaster-${slug || 'project'}`;
}

/** The key and the server the client gets. */
export function serverFor(client: McpClient, ctx: SetupContext, options: ServerOptions): { key: string; server: ServerEntry } {
    // Bun projects start it with bunx: the bin still runs on Node.js, and bunx starts faster than npx.
    if (!client.global) return { key: 'propmaster', server: { command: (options.packageManager ?? packageManager(ctx.root)) === 'bun' ? 'bunx' : 'npx', args: ['propmaster', ...serverArgs(options)] } };
    const bin = installedBin(ctx.root);
    const server = bin
        ? { command: 'node', args: [bin, ...serverArgs(options), '--root', ctx.root] }
        : { command: 'npx', args: ['--prefix', ctx.root, 'propmaster', ...serverArgs(options), '--root', ctx.root] };
    return { key: globalEntryName(ctx.root), server };
}

export function configPath(client: McpClient, ctx: SetupContext): string {
    const file = client.file(ctx);
    return path.isAbsolute(file) ? file : path.join(ctx.root, file);
}

/** How the file is shown: relative to the project, or with ~ for the home folder. */
export function displayPath(client: McpClient, ctx: SetupContext): string {
    const file = configPath(client, ctx);
    if (!client.global) return path.relative(ctx.root, file).split(path.sep).join('/');
    return file.startsWith(ctx.home + path.sep) ? `~/${path.relative(ctx.home, file).split(path.sep).join('/')}` : file;
}

// ─── Planning and applying ──────────────────────────────────────────────────

export type ChangeKind = 'create' | 'add' | 'update' | 'remove' | 'delete' | 'unchanged' | 'absent' | 'error';

export interface Change {
    client: ClientId;
    name: string;
    /** The config file, as shown to people. */
    file: string;
    /** Its full path. */
    path: string;
    key: string;
    kind: ChangeKind;
    /** The file's new text (absent for delete, unchanged, absent and error). */
    text?: string;
    /** For an error: why, and the entry to add by hand. */
    message?: string;
}

const editOptions = (client: McpClient): JsonEditOptions => ({ jsonc: client.jsonc === true });

/** The servers object of a config file's text, or an error message. */
function serversIn(client: McpClient, text: string): { members?: string[]; error?: string } {
    try {
        const root = parseJsonSpans(text, editOptions(client));
        if (root.kind !== 'object') return { error: 'it isn\'t a JSON object' };
        return { members: objectAt(root, client.serversPath)?.members.map((m) => m.key) ?? [] };
    } catch (error) {
        return { error: (error as Error).message };
    }
}

/** What `setup` would change in `client`'s config file. */
export function planSetup(client: McpClient, ctx: SetupContext, options: ServerOptions): Change {
    const file = configPath(client, ctx);
    const { key, server } = serverFor(client, ctx, options);
    const entry = client.entry(server);
    const base = { client: client.id, name: client.name, file: displayPath(client, ctx), path: file, key };
    if (!fs.existsSync(file)) {
        const value: Record<string, unknown> = {};
        let at = value;
        for (const k of client.serversPath.slice(0, -1)) at = (at[k] = {}) as Record<string, unknown>;
        at[client.serversPath.at(-1)!] = { [key]: entry };
        return { ...base, kind: 'create', text: `${JSON.stringify(value, null, 4)}\n` };
    }
    const text = fs.readFileSync(file, 'utf-8');
    if (!text.trim()) return { ...base, kind: 'add', text: `${JSON.stringify({ [client.serversPath[0]]: { [key]: entry } }, null, 4)}\n` };
    const before = serversIn(client, text);
    if (before.error) {
        return { ...base, kind: 'error', message: `${base.file} can't be read (${before.error}). Add this to "${client.serversPath.join('.')}" by hand: ${JSON.stringify({ [key]: entry })}` };
    }
    const next = setMember(text, client.serversPath, key, entry, editOptions(client));
    if (next === text) return { ...base, kind: 'unchanged' };
    return { ...base, kind: before.members!.includes(key) ? 'update' : 'add', text: next };
}

/** What `--remove` would change: the entry taken out, and the file deleted when nothing else is left in it. */
export function planRemove(client: McpClient, ctx: SetupContext): Change {
    const file = configPath(client, ctx);
    const key = client.global ? globalEntryName(ctx.root) : 'propmaster';
    const base = { client: client.id, name: client.name, file: displayPath(client, ctx), path: file, key };
    if (!fs.existsSync(file)) return { ...base, kind: 'absent' };
    const text = fs.readFileSync(file, 'utf-8');
    const before = serversIn(client, text);
    if (before.error) return { ...base, kind: 'error', message: `${base.file} can't be read (${before.error}); take "${key}" out of "${client.serversPath.join('.')}" by hand.` };
    if (!before.members!.includes(key)) return { ...base, kind: 'absent' };
    const next = removeMember(text, client.serversPath, key, editOptions(client));
    // What `setup` created, `--remove` deletes: a file with nothing but the empty servers object.
    let empty = false;
    try {
        const parsed = JSON.parse(next) as unknown;
        let skeleton: unknown = {};
        for (const k of [...client.serversPath].reverse()) skeleton = { [k]: skeleton };
        empty = sameJson(parsed, skeleton);
    } catch {
        empty = false;
    }
    return empty ? { ...base, kind: 'delete' } : { ...base, kind: 'remove', text: next };
}

export function applyChange(change: Change): void {
    if (change.kind === 'delete') {
        fs.rmSync(change.path);
        return;
    }
    if (change.text === undefined) return;
    fs.mkdirSync(path.dirname(change.path), { recursive: true });
    fs.writeFileSync(change.path, change.text, 'utf-8');
}

/** The editors this project uses; Claude Code when there are no signs of any. */
export function detectClients(ctx: SetupContext): ClientId[] {
    const found = MCP_CLIENTS.filter((c) => c.detect(ctx)).map((c) => c.id);
    return found.length ? found : ['claude'];
}

export interface ConfiguredServer {
    client: ClientId;
    name: string;
    file: string;
    key: string;
    /** The command and arguments in the file, when they're plain JSON. */
    server?: ServerEntry;
}

/** The editors whose config file has the propmaster entry for this project. */
export function configuredServers(ctx: SetupContext): ConfiguredServer[] {
    const out: ConfiguredServer[] = [];
    for (const client of MCP_CLIENTS) {
        const file = configPath(client, ctx);
        if (!fs.existsSync(file)) continue;
        const key = client.global ? globalEntryName(ctx.root) : 'propmaster';
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf-8');
            const member = objectAt(parseJsonSpans(text, editOptions(client)), client.serversPath)?.members.find((m) => m.key === key);
            if (!member) continue;
            const value = JSON.parse(text.slice(member.value.start, member.value.end)) as Record<string, unknown>;
            const server = typeof value.command === 'string' ? { command: value.command, args: Array.isArray(value.args) ? value.args.map(String) : [] } : undefined;
            out.push({ client: client.id, name: client.name, file: displayPath(client, ctx), key, ...(server ? { server } : {}) });
        } catch {
            continue;
        }
    }
    return out;
}

// ─── --check: start the server as an editor would ───────────────────────────

export interface CheckResult {
    ok: boolean;
    /** The command that was run. */
    command: string;
    serverName?: string;
    serverVersion?: string;
    tools: string[];
    durationMs: number;
    error?: string;
    /** The server's log lines (stderr), at most the last 20. */
    stderr: string[];
}

/**
 * Starts `server` in `cwd`, sends `initialize` and `tools/list` over stdio as
 * an MCP client does, and stops it. Never throws.
 */
export function checkServer(server: ServerEntry, cwd: string, timeoutMs = 60_000): Promise<CheckResult> {
    const started = Date.now();
    const command = [server.command, ...server.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const result = (partial: Partial<CheckResult>): CheckResult => ({
            ok: false,
            command,
            tools: [],
            durationMs: Date.now() - started,
            stderr: stderr.split('\n').filter(Boolean).slice(-20),
            ...partial,
        });
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(server.command, server.args, {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, FORCE_COLOR: '0' },
                shell: process.platform === 'win32',
            });
        } catch (error) {
            resolve(result({ error: (error as Error).message }));
            return;
        }
        const finish = (r: CheckResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdin?.end();
            child.kill();
            resolve(r);
        };
        const timer = setTimeout(() => finish(result({ error: `no answer within ${Math.round(timeoutMs / 1000)} s` })), timeoutMs);
        const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
        let info: { name?: string; version?: string } = {};
        child.on('error', (error) => finish(result({ error: `can't start ${server.command}: ${error.message}` })));
        child.on('exit', (code) => finish(result({ error: `the server exited (code ${code}) before listing its tools` })));
        child.stderr?.on('data', (d) => (stderr += d));
        child.stdout?.on('data', (d) => {
            stdout += d;
            let newline: number;
            while ((newline = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, newline).trim();
                stdout = stdout.slice(newline + 1);
                if (!line) continue;
                let message: { id?: number; result?: Record<string, unknown>; error?: { message: string } };
                try {
                    message = JSON.parse(line);
                } catch {
                    finish(result({ error: `the server wrote something that isn't MCP to stdout: ${line.slice(0, 200)}` }));
                    return;
                }
                if (message.error) {
                    finish(result({ error: message.error.message }));
                    return;
                }
                if (message.id === 1) {
                    info = (message.result?.serverInfo ?? {}) as typeof info;
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
                } else if (message.id === 2) {
                    const tools = ((message.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
                    finish(result({ ok: tools.length > 0, serverName: info.name, serverVersion: info.version, tools, ...(tools.length ? {} : { error: 'the server lists no tools' }) }));
                }
            }
        });
        send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'propmaster-mcp-setup', version: '1' } },
        });
    });
}

/** This copy of Propmaster's `propmaster mcp`, run with Node.js (under tsx when it's the TypeScript source). */
export function selfServer(root: string, options: ServerOptions = {}): ServerEntry {
    const cli = fileURLToPath(new URL(`./init${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
    const loader: string[] = [];
    if (cli.endsWith('.ts')) {
        try {
            loader.push('--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href);
        } catch {
            loader.push('--import', 'tsx');
        }
    }
    return { command: process.execPath, args: [...loader, cli, ...serverArgs(options), '--root', root] };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export const MCP_SETUP_HELP = `
  propmaster mcp setup: connect the MCP server to your editors

  Usage:
    npx propmaster mcp setup [--client <names>] [-e <env>] [--allow-writes] [--dry-run]
    npx propmaster mcp setup --check [--client <names>]
    npx propmaster mcp setup --remove [--client <names>] [--dry-run]

  Writes the propmaster entry into each editor's MCP config, next to the
  servers already there:
    claude    Claude Code   .mcp.json
    vscode    VS Code       .vscode/mcp.json
    cursor    Cursor        .cursor/mcp.json
    windsurf  Windsurf      ~/.codeium/windsurf/mcp_config.json (for every project:
                            the entry is propmaster-<folder>, with absolute paths)
    zed       Zed           .zed/settings.json (context_servers)
  Running it again changes nothing.

  Options:
    --client <names>   Comma-separated, or "all". Without it, a menu with the
                       editors this project uses already selected (with no
                       terminal: those editors, or Claude Code)
    --environment, -e  Environment the server uses (default: PW_ENVIRONMENT, else local)
    --allow-writes     Give the server write tools for the backends
    --check            Start each configured server as the editor would, and
                       list its tools. Exits 1 when one doesn't start
    --remove           Take the propmaster entry out (a file left with nothing
                       else in it is deleted)
    --dry-run          Show what would change, and change nothing
    --json             The changes (or the check) as JSON
    --root <dir>       Project root (default: nearest package.json)
`;

interface SetupArgs {
    root: string;
    clients?: ClientId[];
    environment?: string;
    allowWrites: boolean;
    check: boolean;
    remove: boolean;
    dryRun: boolean;
    json: boolean;
}

export function parseSetupArgs(argv: string[], cwd: string = process.cwd()): SetupArgs | { help: true } | { error: string } {
    const out: SetupArgs = { root: '', allowWrites: false, check: false, remove: false, dryRun: false, json: false };
    let root: string | undefined;
    const clients: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
        const value = (): string => {
            const v = inline ?? argv[++i];
            if (v === undefined || (inline === undefined && v.startsWith('-'))) throw new Error(`${flag} needs a value`);
            return v;
        };
        try {
            if (flag === '--help' || flag === '-h') return { help: true };
            else if (flag === '--client' || flag === '-c') clients.push(...value().split(','));
            else if (flag === '--environment' || flag === '-e') out.environment = value();
            else if (flag === '--allow-writes') out.allowWrites = true;
            else if (flag === '--check') out.check = true;
            else if (flag === '--remove') out.remove = true;
            else if (flag === '--dry-run') out.dryRun = true;
            else if (flag === '--json') out.json = true;
            else if (flag === '--root') root = value();
            else return { error: `Unknown option: ${arg}` };
        } catch (error) {
            return { error: (error as Error).message };
        }
    }
    if (out.check && out.remove) return { error: '--check and --remove can\'t be used together' };
    if (clients.length) {
        const ids = clients.map((c) => c.trim().toLowerCase()).filter(Boolean);
        if (ids.includes('all')) out.clients = [...CLIENT_IDS];
        else {
            const unknown = ids.filter((id) => !clientById(id));
            if (unknown.length) return { error: `Unknown client: ${unknown.join(', ')}. Use ${CLIENT_IDS.join(', ')} or all.` };
            out.clients = CLIENT_IDS.filter((id) => ids.includes(id));
        }
    }
    out.root = root ? path.resolve(cwd, root) : findProjectRoot(cwd);
    return out;
}

const VERB: Record<ChangeKind, string> = {
    create: 'Create',
    add: 'Add to',
    update: 'Update',
    remove: 'Remove from',
    delete: 'Delete',
    unchanged: 'Unchanged',
    absent: 'Not in',
    error: 'Can\'t edit',
};

/** `propmaster mcp setup`. Returns the exit code. */
export async function runMcpSetup(
    argv: string[],
    options: { cwd?: string; home?: string; log?: (line?: string) => void; interactive?: boolean } = {},
): Promise<number> {
    const log = options.log ?? console.log;
    const parsed = parseSetupArgs(argv, options.cwd);
    if ('help' in parsed) {
        log(MCP_SETUP_HELP);
        return 0;
    }
    if ('error' in parsed) {
        log(`  ${parsed.error}`);
        log(MCP_SETUP_HELP);
        return 2;
    }
    const ctx: SetupContext = { root: parsed.root, home: options.home ?? os.homedir() };
    const s = styleFor();

    if (parsed.check) return runCheck(ctx, parsed, log);

    let ids = parsed.clients;
    if (!ids) {
        const detected = parsed.remove ? configuredServers(ctx).map((c) => c.client) : detectClients(ctx);
        if (options.interactive ?? isInteractive()) {
            const choices: Choice<ClientId>[] = MCP_CLIENTS.map((c) => ({
                value: c.id,
                label: c.name,
                hint: displayPath(c, ctx) + (detected.includes(c.id) ? (parsed.remove ? ' · set up' : ' · in use here') : ''),
                search: c.id,
            }));
            ids = await multiselect({
                message: parsed.remove ? 'Remove the MCP server from' : 'Set up the MCP server for',
                choices,
                defaults: detected,
                flag: '--client <names>',
            });
        } else {
            ids = detected;
        }
    }
    const clients = ids.map((id) => clientById(id)!);
    const changes = clients.map((c) => (parsed.remove ? planRemove(c, ctx) : planSetup(c, ctx, parsed)));
    if (!parsed.dryRun) for (const change of changes) applyChange(change);

    if (parsed.json) {
        log(JSON.stringify({ dryRun: parsed.dryRun, changes: changes.map(({ text: _text, path: _path, ...rest }) => rest) }, null, 2));
        return changes.some((c) => c.kind === 'error') ? 1 : 0;
    }
    if (!changes.length) {
        log(parsed.remove ? '  No editor has the propmaster server set up.' : '  No editor picked.');
        return 0;
    }
    const width = Math.max(...changes.map((c) => VERB[c.kind].length));
    for (const c of changes) {
        const mark = c.kind === 'error' ? s.red('✖') : c.kind === 'unchanged' || c.kind === 'absent' ? s.dim('·') : s.green(parsed.dryRun ? '○' : '✓');
        log(`  ${mark} ${VERB[c.kind].padEnd(width)}  ${c.file}  ${s.dim(`${c.name}, "${c.key}"`)}`);
        if (c.message) log(`    ${c.message}`);
    }
    log();
    if (parsed.dryRun) log('  Dry run: nothing changed. Run it again without --dry-run to apply.');
    else if (!parsed.remove && changes.some((c) => c.kind !== 'error')) {
        log(`  Restart the editor or reload its MCP servers. ${s.cyan('npx propmaster mcp setup --check')} starts the server as the editor will.`);
        if (changes.some((c) => c.client === 'windsurf')) log('  Windsurf reads one config for every project: run this in each project that should have the server.');
    }
    return changes.some((c) => c.kind === 'error') ? 1 : 0;
}

async function runCheck(ctx: SetupContext, args: SetupArgs, log: (line?: string) => void): Promise<number> {
    const s = styleFor();
    let configured = configuredServers(ctx);
    if (args.clients) configured = configured.filter((c) => args.clients!.includes(c.client));
    // Editors with the same command and folder start the same server: check it once.
    const targets = new Map<string, { server: ServerEntry; editors: ConfiguredServer[] }>();
    for (const c of configured) {
        if (!c.server) continue;
        const id = JSON.stringify(c.server);
        const target = targets.get(id) ?? { server: c.server, editors: [] };
        target.editors.push(c);
        targets.set(id, target);
    }
    const broken = configured.filter((c) => !c.server);
    const results: Array<{ editors: string[]; files: string[]; result: CheckResult }> = [];
    for (const { server, editors } of targets.values()) {
        results.push({ editors: editors.map((e) => e.name), files: editors.map((e) => e.file), result: await checkServer(server, ctx.root) });
    }
    const failed = results.some((r) => !r.result.ok) || broken.length > 0 || !configured.length;

    if (args.json) {
        log(JSON.stringify({ ok: !failed, configured: configured.map(({ server: _s, ...rest }) => rest), checks: results }, null, 2));
        return failed ? 1 : 0;
    }
    if (!configured.length) {
        log(`  No editor has the propmaster server set up${args.clients ? ` (of ${args.clients.join(', ')})` : ''}. ${s.cyan('npx propmaster mcp setup')} sets it up.`);
        return 1;
    }
    for (const c of broken) log(`  ${s.red('✖')} ${c.file}  ${s.dim(c.name)}: the "${c.key}" entry has no command`);
    for (const { editors, files, result } of results) {
        if (result.ok) {
            log(`  ${s.green('✓')} ${editors.join(', ')}  ${s.dim(files.join(', '))}`);
            log(`    ${result.serverName ?? 'server'} ${result.serverVersion ?? ''} started in ${(result.durationMs / 1000).toFixed(1)} s with ${result.tools.length} tools: ${result.tools.join(', ')}`);
        } else {
            log(`  ${s.red('✖')} ${editors.join(', ')}  ${s.dim(files.join(', '))}`);
            log(`    ${result.command}: ${result.error}`);
            for (const line of result.stderr.slice(-5)) log(`    ${s.dim(line)}`);
        }
    }
    return failed ? 1 : 0;
}
