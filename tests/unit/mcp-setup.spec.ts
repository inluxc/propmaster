/**
 * Unit tests for `propmaster mcp setup` (src/cli/mcp-setup.ts): each editor's
 * config file, merging with what's already there, --remove, and --check
 * against the real server over stdio.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CLIENT_IDS,
    MCP_CLIENTS,
    checkServer,
    clientById,
    configuredServers,
    detectClients,
    globalEntryName,
    parseSetupArgs,
    planRemove,
    planSetup,
    runMcpSetup,
    selfServer,
    type ClientId,
} from '../../src/cli/mcp-setup';
import { addMember, parseJsonSpans, removeMember, setMember } from '../../src/cli/json-edit';

let root: string;
let home: string;

test.beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-mcp-setup-'));
    root = path.join(base, 'Shop App');
    home = path.join(base, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "shop" }\n');
});
test.afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

const ctx = () => ({ root, home });
const read = (file: string) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file), 'utf-8');
const write = (file: string, text: string) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
};
const lines: string[] = [];
const run = (...argv: string[]) => {
    lines.length = 0;
    return runMcpSetup([...argv, '--root', root], { home, log: (l = '') => lines.push(l), interactive: false });
};
const windsurfFile = () => path.join(home, '.codeium/windsurf/mcp_config.json');

test.describe('mcp setup — each editor', () => {
    const expected: Record<ClientId, { file: () => string; json: () => unknown }> = {
        claude: { file: () => '.mcp.json', json: () => ({ mcpServers: { propmaster: { command: 'npx', args: ['propmaster', 'mcp'] } } }) },
        vscode: { file: () => '.vscode/mcp.json', json: () => ({ servers: { propmaster: { type: 'stdio', command: 'npx', args: ['propmaster', 'mcp'] } } }) },
        cursor: { file: () => '.cursor/mcp.json', json: () => ({ mcpServers: { propmaster: { command: 'npx', args: ['propmaster', 'mcp'] } } }) },
        zed: { file: () => '.zed/settings.json', json: () => ({ context_servers: { propmaster: { source: 'custom', command: 'npx', args: ['propmaster', 'mcp'] } } }) },
        windsurf: {
            file: windsurfFile,
            json: () => ({
                mcpServers: {
                    'propmaster-shop-app': { command: 'npx', args: ['--prefix', root, 'propmaster', 'mcp', '--root', root] },
                },
            }),
        },
    };

    for (const id of CLIENT_IDS) {
        test(`${id}: a new config file with the propmaster entry`, async () => {
            expect(await run('--client', id)).toBe(0);
            expect(JSON.parse(read(expected[id].file()))).toEqual(expected[id].json());
            expect(configuredServers(ctx()).map((c) => c.client)).toEqual([id]);
        });
    }

    test('every editor in the catalog is covered', () => {
        expect(MCP_CLIENTS.map((c) => c.id).sort()).toEqual(Object.keys(expected).sort());
    });

    test('--environment and --allow-writes go into the arguments', async () => {
        await run('--client', 'claude,vscode', '-e', 'dev', '--allow-writes');
        expect(JSON.parse(read('.mcp.json')).mcpServers.propmaster.args).toEqual(['propmaster', 'mcp', '--environment', 'dev', '--allow-writes']);
        expect(JSON.parse(read('.vscode/mcp.json')).servers.propmaster.args).toEqual(['propmaster', 'mcp', '--environment', 'dev', '--allow-writes']);
    });

    test('Windsurf: the installed bin with node and absolute paths, and an entry name per project', async () => {
        write('node_modules/@inluxc/propmaster/package.json', JSON.stringify({ name: '@inluxc/propmaster', bin: { propmaster: 'dist/src/cli/init.js' } }));
        expect(globalEntryName(root)).toBe('propmaster-shop-app');
        await run('--client', 'windsurf');
        const entry = JSON.parse(read(windsurfFile())).mcpServers['propmaster-shop-app'];
        expect(entry).toEqual({ command: 'node', args: [path.join(root, 'node_modules/@inluxc/propmaster/dist/src/cli/init.js'), 'mcp', '--root', root] });
        expect(lines.join('\n')).toContain('~/.codeium/windsurf/mcp_config.json');
    });
});

test.describe('mcp setup — merging with existing files', () => {
    test('other servers stay, with their formatting; a second run changes nothing', async () => {
        const before = '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp", "args": ["--stdio"] }\n  },\n  "other": true\n}\n';
        write('.mcp.json', before);
        expect(await run('--client', 'claude')).toBe(0);
        const after = read('.mcp.json');
        expect(after).toBe('{\n  "mcpServers": {\n    "github": { "command": "gh-mcp", "args": ["--stdio"] },\n    "propmaster": {\n      "command": "npx",\n      "args": ["propmaster", "mcp"]\n    }\n  },\n  "other": true\n}\n');
        expect(lines[0]).toContain('Add to');

        expect(await run('--client', 'claude')).toBe(0);
        expect(read('.mcp.json')).toBe(after);
        expect(lines[0]).toContain('Unchanged');

        expect(await run('--client', 'claude', '--remove')).toBe(0);
        expect(read('.mcp.json')).toBe(before);
    });

    test('a different environment updates the entry in place', async () => {
        write('.mcp.json', '{\n    "mcpServers": {\n        "propmaster": { "command": "npx", "args": ["propmaster", "mcp"] },\n        "z": {}\n    }\n}\n');
        await run('--client', 'claude', '-e', 'stg');
        expect(lines[0]).toContain('Update');
        const json = JSON.parse(read('.mcp.json'));
        expect(Object.keys(json.mcpServers)).toEqual(['propmaster', 'z']);
        expect(json.mcpServers.propmaster.args).toEqual(['propmaster', 'mcp', '--environment', 'stg']);
    });

    test('VS Code: a file with inputs and no servers gets a servers object; comments are kept', async () => {
        write('.vscode/mcp.json', '{\n  // shared with the team\n  "inputs": [],\n}\n');
        expect(await run('--client', 'vscode')).toBe(0);
        const text = read('.vscode/mcp.json');
        expect(text).toContain('// shared with the team');
        const parsed = parseJsonSpans(text, { jsonc: true });
        expect(parsed.kind).toBe('object');
        expect(text).toContain('"type": "stdio"');
        expect(configuredServers(ctx()).map((c) => c.client)).toEqual(['vscode']);
    });

    test('Zed: settings with comments and other keys; remove gives them back', async () => {
        const before = '// Folder-specific settings\n{\n  "tab_size": 2,\n  /* servers */\n  "context_servers": {},\n}\n';
        write('.zed/settings.json', before);
        await run('--client', 'zed');
        expect(read('.zed/settings.json')).toContain('"source": "custom"');
        expect(read('.zed/settings.json')).toContain('// Folder-specific settings');
        await run('--client', 'zed', '--remove');
        expect(read('.zed/settings.json')).toBe(before);
    });

    test('Windsurf: another project\'s entry stays', async () => {
        fs.mkdirSync(path.dirname(windsurfFile()), { recursive: true });
        fs.writeFileSync(windsurfFile(), JSON.stringify({ mcpServers: { 'propmaster-billing': { command: 'node', args: ['x'] } } }, null, 2));
        await run('--client', 'windsurf');
        expect(Object.keys(JSON.parse(read(windsurfFile())).mcpServers)).toEqual(['propmaster-billing', 'propmaster-shop-app']);
        await run('--client', 'windsurf', '--remove');
        expect(Object.keys(JSON.parse(read(windsurfFile())).mcpServers)).toEqual(['propmaster-billing']);
    });

    test('a file that isn\'t JSON is left alone, with the entry to add by hand', async () => {
        write('.cursor/mcp.json', '{ not json');
        expect(await run('--client', 'cursor')).toBe(1);
        expect(read('.cursor/mcp.json')).toBe('{ not json');
        expect(lines.join('\n')).toContain('Add this to "mcpServers" by hand: {"propmaster":{"command":"npx","args":["propmaster","mcp"]}}');
    });

    test('an empty file gets the servers object', () => {
        write('.mcp.json', '');
        const change = planSetup(clientById('claude')!, ctx(), {});
        expect(JSON.parse(change.text!)).toEqual({ mcpServers: { propmaster: { command: 'npx', args: ['propmaster', 'mcp'] } } });
    });
});

test.describe('mcp setup — remove, dry run, detection, arguments', () => {
    test('--remove deletes a file it created, and does nothing where there is no entry', async () => {
        await run('--client', 'claude,cursor');
        expect(await run('--remove')).toBe(0);
        expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.cursor/mcp.json'))).toBe(false);
        expect(planRemove(clientById('vscode')!, ctx()).kind).toBe('absent');
        expect(await run('--remove')).toBe(0);
        expect(lines).toEqual(['  No editor has the propmaster server set up.']);
    });

    test('--dry-run changes nothing; --json lists the changes', async () => {
        expect(await run('--client', 'all', '--dry-run', '--json')).toBe(0);
        const out = JSON.parse(lines.join('\n'));
        expect(out.dryRun).toBe(true);
        expect(out.changes.map((c: { client: string; kind: string }) => `${c.client}:${c.kind}`)).toEqual(CLIENT_IDS.map((id) => `${id}:create`));
        expect(fs.readdirSync(root)).toEqual(['package.json']);
        expect(fs.existsSync(windsurfFile())).toBe(false);
    });

    test('with no --client and no terminal: the editors in use, else Claude Code', async () => {
        expect(detectClients(ctx())).toEqual(['claude']);
        fs.mkdirSync(path.join(root, '.vscode'));
        fs.mkdirSync(path.join(root, '.zed'));
        expect(detectClients(ctx())).toEqual(['vscode', 'zed']);
        await run();
        expect(configuredServers(ctx()).map((c) => c.client)).toEqual(['vscode', 'zed']);
    });

    test('arguments: unknown clients and options are refused', () => {
        expect(parseSetupArgs(['--client', 'emacs'], root)).toEqual({ error: 'Unknown client: emacs. Use claude, vscode, cursor, windsurf, zed or all.' });
        expect(parseSetupArgs(['--check', '--remove'], root)).toEqual({ error: '--check and --remove can\'t be used together' });
        expect(parseSetupArgs(['--nope'], root)).toEqual({ error: 'Unknown option: --nope' });
        expect(parseSetupArgs(['--client=zed,claude', '-e', 'dev'], root)).toMatchObject({ clients: ['claude', 'zed'], environment: 'dev', root });
    });
});

test.describe('json-edit — JSONC', () => {
    test('comments and trailing commas are accepted only with jsonc', () => {
        const text = '{\n  // c\n  "a": [1, 2,],\n  /* d */ "b": {},\n}';
        expect(() => parseJsonSpans(text)).toThrow();
        expect(parseJsonSpans(text, { jsonc: true }).kind).toBe('object');
        const added = addMember(text, ['b'], 'x', 1, { jsonc: true });
        expect(removeMember(added, ['b'], 'x', { jsonc: true })).toBe(text);
    });

    test('setMember adds missing objects on the way, and replaces a value in place', () => {
        expect(JSON.parse(setMember('{}', ['a', 'b'], 'k', 1))).toEqual({ a: { b: { k: 1 } } });
        const text = '{\n    "s": {\n        "k": { "v": 1 },\n        "z": 2\n    }\n}';
        expect(setMember(text, ['s'], 'k', { v: 1 })).toBe(text);
        expect(setMember(text, ['s'], 'k', { v: 2 })).toBe('{\n    "s": {\n        "k": {\n            "v": 2\n        },\n        "z": 2\n    }\n}');
    });
});

test.describe('mcp setup — --check', () => {
    test('starts the real server over stdio and lists its tools', async () => {
        test.setTimeout(90_000);
        fs.writeFileSync(path.join(root, 'environments.json'), JSON.stringify({ environments: { local: { otp: { secret: 'JBSWY3DPEHPK3PXP' } } } }));
        const result = await checkServer(selfServer(root), root);
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.serverName).toBe('propmaster');
        expect(result.tools).toEqual(expect.arrayContaining(['environment_info', 'next_test_id', 'check_tests', 'run_tests']));

        // The same through the CLI, from an entry in .mcp.json.
        write('.mcp.json', JSON.stringify({ mcpServers: { propmaster: selfServer(root) } }));
        expect(await run('--check')).toBe(0);
        expect(lines[0]).toContain('Claude Code');
        expect(lines[1]).toMatch(/^ {4}propmaster \S+ started in [\d.]+ s with \d+ tools: /);
    });

    test('a server that fails to start, or none set up, exits 1', async () => {
        test.setTimeout(60_000);
        expect(await run('--check')).toBe(1);
        expect(lines[0]).toContain('No editor has the propmaster server set up');

        write('.mcp.json', JSON.stringify({ mcpServers: { propmaster: { command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] } } }));
        expect(await run('--check', '--json')).toBe(1);
        const out = JSON.parse(lines.join('\n'));
        expect(out.ok).toBe(false);
        expect(out.checks[0].result).toMatchObject({ ok: false, error: 'the server exited (code 3) before listing its tools', stderr: ['boom'] });

        const missing = await checkServer({ command: 'propmaster-no-such-command', args: [] }, root);
        expect(missing.ok).toBe(false);
        expect(missing.error).toMatch(/can't start propmaster-no-such-command|exited/);
    });

    test('a production environment the server refuses shows its message', async () => {
        test.setTimeout(60_000);
        const result = await checkServer(selfServer(root, { environment: 'prod' }), root);
        expect(result.ok).toBe(false);
        expect(result.stderr.join('\n')).toContain('Refusing to start for environment "prod"');
    });
});
