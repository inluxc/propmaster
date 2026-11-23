/**
 * `propmaster env list | add`: the project's environments, and a new one
 * made from an existing one.
 *
 * `env add stg --from dev` copies dev's block in environments.json with its
 * values replaced by CHANGE_ME (settings that are the same everywhere, like a
 * database `type`, are kept; `--copy-values` keeps the rest too), creates
 * `.env.stg` with the variable names commented out for you to fill in, and
 * keeps `.env.stg` out of git. Credentials are never copied: passwords,
 * tokens and keys come out empty. A production environment is marked
 * `"production": true`, so the MCP server refuses it without --allow-prod and
 * never offers it write tools.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findProjectRoot } from './check-tests.js';
import { FIXTURE_CATALOG, PLACEHOLDER } from './fixture-catalog.js';
import { ENVIRONMENTS_FILE, Files, environmentNames, formatPlanLines, localEnvironment, placeholderValue, type PlanLine } from './fixture.js';
import { addMember, valueAt } from './json-edit.js';
import { confirm, isInteractive, select, text, type Choice } from './prompts.js';
import { styleFor } from './style.js';

/** Environment names treated as production even without `"production": true`. */
const PRODUCTION_NAMES = new Set(['prod', 'production', 'prd', 'live']);

/** Keys whose values are credentials: never copied to a new environment. */
const CREDENTIAL_KEYS = /^(password|pass|secret|clientSecret|secretAccessKey|sessionToken|accessKeyId|token|authToken|apiKey|privateKey|passphrase)$/i;

/** Whether an environment is production: by its name, or `"production": true` in its block. */
export function isProduction(name: string, block?: unknown): boolean {
    if (PRODUCTION_NAMES.has(name.trim().toLowerCase())) return true;
    return !!block && typeof block === 'object' && (block as Record<string, unknown>).production === true;
}

/** Whether the project's environments.json marks `name` as production (false when it can't be read). */
export function markedProduction(root: string, name: string): boolean {
    try {
        const text = fs.readFileSync(path.join(root, ENVIRONMENTS_FILE), 'utf-8');
        return isProduction(name, valueAt(text, ['environments', name]));
    } catch {
        return isProduction(name);
    }
}

/**
 * `block` for a new environment: credentials emptied, values replaced by
 * CHANGE_ME unless `copyValues`, `secrets` kept as it is (its key mappings are
 * references, not secrets), and no `production` flag (the caller sets it).
 */
export function newEnvironmentBlock(block: Record<string, unknown>, copyValues: boolean): Record<string, unknown> {
    const scrub = (value: unknown, key: string | undefined, keepValues: boolean): unknown => {
        if (key && CREDENTIAL_KEYS.test(key) && (typeof value === 'string' || value === null)) return '';
        if (Array.isArray(value)) return keepValues ? value.map((v) => scrub(v, undefined, true)) : placeholderValue(value, key);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, keepValues)]));
        return keepValues ? value : placeholderValue(value, key);
    };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
        if (key === 'production') continue;
        out[key] = scrub(value, key, copyValues || key === 'secrets');
    }
    return out;
}

/** The PW_* variables for the blocks in `block`, grouped as the catalog groups them in .env.example. */
export function variablesFor(block: Record<string, unknown>): Array<{ title: string; names: string[] }> {
    const groups = new Map<string, { title: string; names: string[] }>();
    for (const key of Object.keys(block)) {
        for (const entry of FIXTURE_CATALOG) {
            for (const variant of entry.variants) {
                if (!variant.config.some((c) => c.path[0] === key)) continue;
                for (const section of variant.env) {
                    const group = groups.get(section.group) ?? { title: section.title, names: [] };
                    for (const v of section.vars) if (!group.names.includes(v.name)) group.names.push(v.name);
                    groups.set(section.group, group);
                }
            }
        }
    }
    return [...groups.values()];
}

/** The `.env.<name>` file for a new environment: every variable commented out, for you to fill in. */
export function envFileFor(name: string, block: Record<string, unknown>): string {
    const lines = [
        `# Settings for the "${name}" environment (PW_ENVIRONMENT=${name}). Keep this file out of git.`,
        '# Each line overrides environments.json. Uncomment and fill in what this environment needs;',
        '# put secrets here or in the secrets provider, never in environments.json.',
    ];
    for (const group of variablesFor(block)) lines.push('', `# ─── ${group.title}`, ...group.names.map((n) => `# ${n}=`));
    return `${lines.join('\n')}\n`;
}

/** A gitignore glob (no slashes) as a RegExp for a file name. */
function globRe(pattern: string): RegExp {
    return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

/** Whether `.gitignore` text ignores the root file `file` (last matching pattern wins, `!` un-ignores). */
export function gitIgnores(gitignore: string, file: string): boolean {
    let ignored = false;
    for (const raw of gitignore.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const negate = line.startsWith('!');
        const pattern = (negate ? line.slice(1) : line).replace(/^\//, '');
        if (pattern.includes('/')) continue;
        if (globRe(pattern).test(file)) ignored = !negate;
    }
    return ignored;
}

export interface EnvPlan {
    name: string;
    from?: string;
    production: boolean;
    lines: Array<{ sign: PlanLine['sign']; kind: string; text: string }>;
    files: Map<string, string | null>;
    /** Why it can't be done (the name is taken, the source is missing...). Empty when it can. */
    blockers: string[];
}

export interface EnvAddOptions {
    /** The environment to copy (default: local, else the first); null for an empty one. */
    from?: string | null;
    /** Mark it production (default: by its name). */
    production?: boolean;
    /** Copy the values too, not just the shape (credentials are still left out). */
    copyValues?: boolean;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Why `name` can't be a new environment here, or undefined. */
export function nameProblem(name: string, existing: string[]): string | undefined {
    if (!NAME_RE.test(name)) return 'letters, digits, - and _ only, starting with a letter or digit';
    if (name === 'example' || name.endsWith('.example')) return '"example" is taken by .env.example';
    if (existing.includes(name)) return `"${name}" already exists`;
    return undefined;
}

/** Works out what adding environment `name` would change. Writes nothing. */
export function planEnvAdd(root: string, name: string, options: EnvAddOptions = {}): EnvPlan {
    const files = new Files(root);
    const environments = files.read(ENVIRONMENTS_FILE);
    const names = environmentNames(environments);
    const production = options.production ?? isProduction(name);
    const plan: EnvPlan = { name, production, lines: [], files: new Map(), blockers: [] };
    if (environments === null) {
        plan.blockers.push(`${ENVIRONMENTS_FILE} not found: run \`npx propmaster init\` first.`);
        return plan;
    }
    if (!names.length && valueAt(environments, ['environments']) === undefined) {
        plan.blockers.push(`${ENVIRONMENTS_FILE} has no "environments" object.`);
        return plan;
    }
    const problem = nameProblem(name, names);
    if (problem) {
        plan.blockers.push(`can't add "${name}": ${problem}.`);
        return plan;
    }
    const from = options.from === undefined ? (names.length ? localEnvironment(names) : null) : options.from;
    if (from !== null && !names.includes(from)) {
        plan.blockers.push(`no environment "${from}" to copy. Environments: ${names.join(', ') || 'none'}.`);
        return plan;
    }
    plan.from = from ?? undefined;

    const source = from === null ? {} : (valueAt(environments, ['environments', from]) as Record<string, unknown>);
    const block = { ...(production ? { production: true } : {}), ...newEnvironmentBlock(source, options.copyValues === true) };
    files.write(ENVIRONMENTS_FILE, addMember(environments, ['environments'], name, block));
    const keys = Object.keys(block).filter((k) => k !== 'production');
    plan.lines.push({
        sign: '+',
        kind: 'config',
        text: `${ENVIRONMENTS_FILE}: ${name}${from ? ` from ${from}` : ' (empty)'}${keys.length ? ` (${keys.join(', ')}${options.copyValues ? ', values copied' : `, ${PLACEHOLDER} to fill in`}; credentials left empty)` : ''}`,
    });
    if (production) plan.lines.push({ sign: '+', kind: 'config', text: `${ENVIRONMENTS_FILE}: "production": true (the MCP server refuses it without --allow-prod, and never writes to it)` });

    const envFile = `.env.${name}`;
    if (files.read(envFile) !== null) plan.lines.push({ sign: '·', kind: 'variables', text: `${envFile} already exists` });
    else {
        files.write(envFile, envFileFor(name, block));
        const count = variablesFor(block).reduce((n, g) => n + g.names.length, 0);
        plan.lines.push({ sign: '+', kind: 'variables', text: `${envFile}${count ? ` (${count} variables, commented out)` : ''}` });
    }

    const gitignore = files.read('.gitignore');
    const inGit = gitignore !== null || fs.existsSync(path.join(root, '.git'));
    if (inGit && !gitIgnores(gitignore ?? '', envFile)) {
        const current = gitignore ?? '';
        files.write('.gitignore', `${current}${current && !current.endsWith('\n') ? '\n' : ''}${envFile}\n`);
        plan.lines.push({ sign: '+', kind: 'git', text: `.gitignore: ${envFile}` });
    }
    plan.files = files.changes();
    return plan;
}

/** Writes the plan's files. Throws when it has blockers. */
export function applyEnvPlan(root: string, plan: EnvPlan): string[] {
    if (plan.blockers.length) throw new Error(plan.blockers.join(' '));
    for (const [rel, content] of plan.files) fs.writeFileSync(path.join(root, rel), content ?? '', 'utf-8');
    return [...plan.files.keys()];
}

export function formatEnvPlan(plan: EnvPlan, color = false): string[] {
    if (plan.blockers.length) return plan.blockers.map((b) => `${styleFor({ isTTY: color }, color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' }).red('✖')} ${b}`);
    return formatPlanLines(`Add environment ${plan.name}${plan.production ? ' (production)' : ''}`, plan.lines, color);
}

export interface EnvironmentInfo {
    name: string;
    production: boolean;
    /** Its top-level blocks (database, redis, ...), without `production`. */
    blocks: string[];
    /** Whether `.env.<name>` exists. */
    envFile: boolean;
    /** Values still CHANGE_ME, as dotted paths. */
    placeholders: string[];
}

/** The project's environments. */
export function listEnvironments(root: string): EnvironmentInfo[] {
    const text = new Files(root).read(ENVIRONMENTS_FILE);
    return environmentNames(text).map((name) => {
        const block = (valueAt(text!, ['environments', name]) ?? {}) as Record<string, unknown>;
        const placeholders: string[] = [];
        const walk = (value: unknown, at: string) => {
            if (value === PLACEHOLDER) placeholders.push(at);
            else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
            else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k);
        };
        walk(block, '');
        return {
            name,
            production: isProduction(name, block),
            blocks: Object.keys(block).filter((k) => k !== 'production'),
            envFile: fs.existsSync(path.join(root, `.env.${name}`)),
            placeholders,
        };
    });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `
  Usage:
    npx propmaster env list [--json]
    npx propmaster env add [name] [--from <env> | --empty] [--prod | --no-prod] [--copy-values] [--dry-run]

  add    Add an environment to environments.json, copied from another one
         (local by default), and create .env.<name> with its variables
         commented out. Values become CHANGE_ME unless --copy-values;
         credentials are never copied. Names like prod, production, prd and
         live are production; --prod marks any other. With no name, asks.
  list   The environments, which are production, and what's still CHANGE_ME.

  Options:
    --from <env>     the environment to copy (default: local, else the first)
    --empty          start from an empty environment
    --prod           mark it production (the MCP server refuses it without --allow-prod)
    --no-prod        don't, even for a name like prod
    --copy-values    copy the values too, not just the shape (credentials stay empty)
    --dry-run        show the plan and change nothing
    --root <dir>     the project (default: the nearest package.json)
`;

function option(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
}

function positionals(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root' || argv[i] === '--from') i++;
        else if (!argv[i].startsWith('-')) out.push(argv[i]);
    }
    return out;
}

function printList(root: string, json: boolean, log: (line?: string) => void): number {
    const envs = listEnvironments(root);
    if (json) {
        log(JSON.stringify(envs, null, 2));
        return 0;
    }
    if (!envs.length) {
        log(`  No environments: ${ENVIRONMENTS_FILE} is missing or empty.`);
        return 0;
    }
    const s = styleFor();
    const width = Math.max(...envs.map((e) => e.name.length));
    for (const e of envs) {
        const flags = [e.production ? s.red('production') : '', e.envFile ? `.env.${e.name}` : '', e.placeholders.length ? s.yellow(`${e.placeholders.length} ${PLACEHOLDER}`) : ''].filter(Boolean).join(s.dim(' · '));
        log(`  ${e.name.padEnd(width)}  ${s.dim(e.blocks.join(', ') || '(empty)')}${flags ? `  ${flags}` : ''}`);
    }
    return 0;
}

/** `propmaster env ...` */
export async function runEnv(argv: string[], log: (line?: string) => void = console.log): Promise<number> {
    const root = option(argv, '--root') ? path.resolve(option(argv, '--root')!) : findProjectRoot();
    let [sub, name] = positionals(argv);
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    if (flags.has('--help') || sub === 'help') {
        log(HELP);
        return 0;
    }
    if (!sub && isInteractive()) {
        sub = await select({
            message: 'Environments',
            choices: [
                { value: 'add', label: 'add', hint: 'a new environment, copied from another' },
                { value: 'list', label: 'list', hint: 'the environments and what is still to fill in' },
            ],
            flag: 'add or list',
        });
    }
    if (sub === 'list') return printList(root, flags.has('--json'), log);
    if (sub !== 'add') {
        log(HELP);
        return sub ? 2 : 0;
    }

    const existing = listEnvironments(root);
    const names = existing.map((e) => e.name);
    const asked = !name;
    const options: EnvAddOptions = { copyValues: flags.has('--copy-values') };
    if (flags.has('--empty')) options.from = null;
    else if (option(argv, '--from')) options.from = option(argv, '--from');
    if (flags.has('--prod')) options.production = true;
    if (flags.has('--no-prod')) options.production = false;

    if (asked) {
        name = await text({ message: 'Name of the new environment', placeholder: 'e.g. stg', flag: '<name>, e.g. `propmaster env add stg`', validate: (v) => nameProblem(v, names) });
        if (options.from === undefined && names.length) {
            const choices: Choice<string | null>[] = [
                ...existing.map((e) => ({ value: e.name as string | null, label: e.name, hint: e.blocks.join(', ') || '(empty)' })),
                { value: null, label: 'empty', hint: 'start with nothing' },
            ];
            options.from = await select({ message: 'Copy which environment?', choices, default: localEnvironment(names), flag: '--from <env>' });
        }
        if (options.production === undefined) {
            options.production = await confirm({ message: 'Is it a production environment?', default: isProduction(name), flag: '--prod or --no-prod' });
        }
    }

    const plan = planEnvAdd(root, name, options);
    const color = styleFor().enabled;
    log('');
    for (const line of formatEnvPlan(plan, color)) log(`  ${line}`);
    log('');
    if (plan.blockers.length) return 2;
    if (flags.has('--dry-run')) {
        log('  Dry run: nothing changed.');
        return 0;
    }
    if (asked && !(await confirm({ message: 'Apply these changes?', default: true, flag: '--yes' }))) return 0;
    applyEnvPlan(root, plan);
    const s = styleFor();
    log(`  ${s.green('✔')} Added environment ${name}.`);
    log(`  ${s.dim('→')} Fill in the ${PLACEHOLDER} values in ${ENVIRONMENTS_FILE} and the variables in .env.${name}, then run with PW_ENVIRONMENT=${name}.`);
    return 0;
}
