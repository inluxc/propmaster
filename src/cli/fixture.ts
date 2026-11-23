/**
 * `propmaster fixture list | add | remove`: sets a fixture up in a project, or
 * takes it out again, from the catalog in fixture-catalog.ts.
 *
 * A plan is worked out in memory first (every file's new text, the packages
 * to install or remove), so a dry run shows exactly what would change and the
 * MCP tools can show it before applying. Adding then removing a fixture gives
 * back the files as they were. Remove takes out only what add would have
 * written: config blocks and compose services holding your own values stay,
 * and the plan says so.
 *
 *   package.json        the driver, through the project's package manager
 *   environments.json   the fixture's block in every environment (local values in
 *                       `local`, CHANGE_ME elsewhere); only the keys it touches change
 *   .env.example        its PW_* variables, in a marked section
 *   compose.test.yaml   a service to run the backend locally (optional)
 *   tests/<type>/       a starter test with a fresh TestCaseID (optional)
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collect, findProjectRoot, loadConfig, nextIds, walk, type IdEntry } from './check-tests.js';
import { FIXTURE_CATALOG, PLACEHOLDER, allPackages, catalogEntry, starterSource, type CatalogEntry, type ConfigItem, type EnvSection, type FixtureVariant, type ServiceSpec } from './fixture-catalog.js';
import { addMember, objectAt, parseJsonSpans, removeMember, valueAt } from './json-edit.js';
import { TEST_TYPES } from './layout.js';
import { analyzeSource } from './organize.js';
import { confirm, isInteractive, multiselect, select, type Choice } from './prompts.js';
import { styleFor } from './style.js';

export const ENVIRONMENTS_FILE = 'environments.json';
export const ENV_EXAMPLE_FILE = '.env.example';
export const COMPOSE_FILE = 'compose.test.yaml';

const NEW_ENVIRONMENTS = '{\n    "environments": {\n        "local": {}\n    }\n}\n';
const NEW_COMPOSE = '# Services for the tests: docker compose -f compose.test.yaml up -d --wait\nservices:\n';

/** Keys whose values are the same in every environment, so they aren't replaced by CHANGE_ME. */
const SAME_EVERYWHERE = new Set(['type', 'driver', 'platform', 'region', 'createKeyspace', 'trustServerCertificate', 'digits', 'period']);

// ─── Project state ──────────────────────────────────────────────────────────

/** The project's files as a plan sees them: what's on disk, plus the plan's own edits. */
export class Files {
    private readonly changed = new Map<string, string | null>();

    constructor(readonly root: string) {}

    read(rel: string): string | null {
        if (this.changed.has(rel)) return this.changed.get(rel)!;
        const full = path.join(this.root, rel);
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null;
    }

    write(rel: string, content: string | null): void {
        const onDisk = fs.existsSync(path.join(this.root, rel)) ? fs.readFileSync(path.join(this.root, rel), 'utf-8') : null;
        if (content === onDisk) this.changed.delete(rel);
        else this.changed.set(rel, content);
    }

    /** Files whose content changes, with their new content (null: deleted). */
    changes(): Map<string, string | null> {
        return new Map(this.changed);
    }
}

/** Packages in the project's package.json (dependencies, devDependencies, optionalDependencies). */
export function installedPackages(root: string): Set<string> {
    const file = path.join(root, 'package.json');
    if (!fs.existsSync(file)) return new Set();
    const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, Record<string, string> | undefined>;
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
}

/** The environment names in environments.json text. */
export function environmentNames(text: string | null): string[] {
    if (!text) return [];
    const envs = valueAt(text, ['environments']);
    return envs && typeof envs === 'object' && !Array.isArray(envs) ? Object.keys(envs) : [];
}

function hasConfig(text: string | null, key: string): boolean {
    return environmentNames(text).some((env) => valueAt(text!, ['environments', env, key]) !== undefined);
}

export interface FixtureState {
    entry: CatalogEntry;
    /** Its packages are installed, tests use it, or (no package) its config is there. */
    present: boolean;
    /** The variant set up (by its packages, or its compose service), when present. */
    variant?: FixtureVariant;
}

/** Which catalog fixtures the project has: by their packages, or (for those without one) by their config. */
export function fixtureStates(root: string, files: Files = new Files(root)): FixtureState[] {
    const installed = installedPackages(root);
    const environments = files.read(ENVIRONMENTS_FILE);
    const compose = files.read(COMPOSE_FILE) ?? '';
    const used = new Set(testFixtures(root));
    return FIXTURE_CATALOG.map((entry) => {
        const packages = allPackages(entry);
        const present =
            entry.fixtures.some((f) => used.has(f)) || (packages.length ? packages.some((p) => installed.has(p)) : hasConfig(environments, entry.variants[0].config[0].path[0]));
        if (!present) return { entry, present };
        const variant = packages.length
            ? entry.variants.find((v) => v.packages.length && v.packages.every((p) => installed.has(p)))
            : entry.variants.find((v) => v.services.some((s) => hasService(compose, s.name)));
        return { entry, present, variant: variant ?? entry.variants[0] };
    });
}

// ─── environments.json ──────────────────────────────────────────────────────

/** The environment that gets local values: `local`, else the first. */
export function localEnvironment(names: string[]): string {
    return names.includes('local') ? 'local' : names[0];
}

/** `value` for an environment other than local: strings become CHANGE_ME, except settings that are the same everywhere. */
export function placeholderValue(value: unknown, key?: string): unknown {
    if (key && SAME_EVERYWHERE.has(key)) return value;
    if (typeof value === 'string') return PLACEHOLDER;
    if (Array.isArray(value)) return value.map((v) => placeholderValue(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, placeholderValue(v, k)]));
    return value;
}

function nest(keys: string[], value: unknown): unknown {
    return keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

/** Adds `item` to environment `env`; returns the new text and whether it was added. */
function addConfigItem(text: string, env: string, item: ConfigItem, value: unknown): { text: string; added: boolean } {
    const root = parseJsonSpans(text);
    const base = ['environments', env];
    let depth = 0;
    while (depth < item.path.length - 1 && objectAt(root, [...base, ...item.path.slice(0, depth + 1)])) depth++;
    const parent = [...base, ...item.path.slice(0, depth)];
    if (!objectAt(root, parent)) return { text, added: false }; // something that isn't an object is in the way: leave it
    if (valueAt(text, [...base, ...item.path]) !== undefined) return { text, added: false };
    const [key, ...rest] = item.path.slice(depth);
    return { text: addMember(text, parent, key, nest(rest, value)), added: true };
}

/** Removes `item` from environment `env`, and the objects above it that it leaves empty. */
function removeConfigItem(text: string, env: string, item: ConfigItem): { text: string; removed: boolean } {
    const base = ['environments', env];
    if (valueAt(text, [...base, ...item.path]) === undefined) return { text, removed: false };
    let next = removeMember(text, [...base, ...item.path.slice(0, -1)], item.path[item.path.length - 1]);
    for (let depth = item.path.length - 1; depth >= 1; depth--) {
        const parentPath = [...base, ...item.path.slice(0, depth)];
        const parent = objectAt(parseJsonSpans(next), parentPath);
        if (!parent || parent.members.length) break;
        next = removeMember(next, parentPath.slice(0, -1), parentPath[parentPath.length - 1]);
    }
    return { text: next, removed: true };
}

const configKey = (item: ConfigItem) => item.path.join('.');

/** Deep equality of JSON values, ignoring key order. */
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Where an existing block disagrees with the variant on a setting that's the
 * same everywhere (`type`, `driver`, ...), e.g. `type is "postgresql", not "mysql"`.
 */
function conflicts(existing: unknown, wanted: unknown): string[] {
    if (!existing || typeof existing !== 'object' || !wanted || typeof wanted !== 'object') return [];
    const have = existing as Record<string, unknown>;
    return Object.entries(wanted as Record<string, unknown>)
        .filter(([key, value]) => (key === 'type' || key === 'driver') && JSON.stringify(have[key]) !== JSON.stringify(value))
        .map(([key, value]) => `${key} is ${have[key] === undefined ? 'not set' : JSON.stringify(have[key])}, not ${JSON.stringify(value)}: change it`);
}

// ─── .env.example ───────────────────────────────────────────────────────────

const sectionMarker = (s: EnvSection) => `# ─── ${s.title} ── propmaster fixture: ${s.group}`;
const markerRe = (group: string) => new RegExp(`^# ─── .* ── propmaster fixture: ${group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');

/** Whether `name` is in the env file, set or commented out. */
function mentionsVar(text: string, name: string): boolean {
    return new RegExp(`^\\s*#?\\s*${name}=`, 'm').test(text);
}

/** Adds `section` unless its marker, or every one of its variables, is already there. */
export function addEnvSection(text: string | null, section: EnvSection): string | null {
    const current = text ?? '';
    if (markerRe(section.group).test(current)) return text;
    const vars = section.vars.filter((v) => !mentionsVar(current, v.name));
    if (!vars.length) return text;
    const lines = [sectionMarker(section), ...vars.map((v) => `${v.optional ? '# ' : ''}${v.name}=${v.value}`)];
    if (!current) return `${lines.join('\n')}\n`;
    return `${current.endsWith('\n') ? current : `${current}\n`}\n${lines.join('\n')}\n`;
}

/** Removes the marked section for `group` (and the blank line before it). Returns null when nothing is left. */
export function removeEnvSection(text: string | null, group: string): string | null {
    if (!text) return text;
    const lines = text.split('\n');
    const start = lines.findIndex((l) => markerRe(group).test(l));
    if (start === -1) return text;
    let end = start + 1;
    while (end < lines.length && lines[end] !== '') end++;
    const from = start > 0 && lines[start - 1] === '' ? start - 1 : start;
    const result = [...lines.slice(0, from), ...lines.slice(from === start ? end + 1 : end)].join('\n');
    return result.trim() === '' ? null : result;
}

// ─── compose.test.yaml ──────────────────────────────────────────────────────

/** The `services:` section as line numbers: [first line after `services:`, line after the last one). */
function servicesSection(lines: string[]): [number, number] | null {
    const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    return [start + 1, end];
}

/** The service `name`'s lines: [its name line, line after its last line). */
function serviceBlock(lines: string[], name: string): [number, number] | null {
    const section = servicesSection(lines);
    if (!section) return null;
    const start = lines.findIndex((l, i) => i >= section[0] && i < section[1] && new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(l));
    if (start === -1) return null;
    let end = start + 1;
    while (end < section[1] && (lines[end].trim() === '' || /^ {3,}\S/.test(lines[end]))) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    return [start, end];
}

export function hasService(text: string | null, name: string): boolean {
    return text ? serviceBlock(text.split('\n'), name) !== null : false;
}

/** Adds `svc` at the end of `services:`, after a blank line. */
export function addService(text: string | null, svc: ServiceSpec): string {
    const current = text ?? NEW_COMPOSE;
    if (hasService(current, svc.name)) return current;
    const lines = current.split('\n');
    let section = servicesSection(lines);
    if (!section) {
        const body = current.endsWith('\n') ? current : `${current}\n`;
        return `${body}${body.trim() ? '\n' : ''}services:\n${svc.yaml}\n`;
    }
    const [first, end] = section;
    const block = (end > first ? [''] : []).concat(svc.yaml.split('\n'));
    lines.splice(end, 0, ...block);
    const result = lines.join('\n');
    return result.endsWith('\n') ? result : `${result}\n`;
}

/**
 * Removes the service `name` when it's still as the catalog wrote it (one you
 * changed stays). Returns the new text, null when only the new-file header is
 * left, and `changed: false` when it was kept or missing.
 */
export function removeService(text: string | null, svc: ServiceSpec): { text: string | null; removed: boolean; edited: boolean } {
    if (!text) return { text, removed: false, edited: false };
    const lines = text.split('\n');
    const block = serviceBlock(lines, svc.name);
    if (!block) return { text, removed: false, edited: false };
    if (lines.slice(block[0], block[1]).join('\n') !== svc.yaml) return { text, removed: false, edited: true };
    const from = block[0] > 0 && lines[block[0] - 1].trim() === '' && block[0] - 1 > servicesSection(lines)![0] - 1 ? block[0] - 1 : block[0];
    // A first service has no blank line before it; drop the one after it instead, if any.
    let to = block[1];
    if (from === block[0] && lines[to] === '' && to + 1 < lines.length && /^  \S/.test(lines[to + 1])) to++;
    const result = [...lines.slice(0, from), ...lines.slice(to)].join('\n');
    return { text: result === NEW_COMPOSE ? null : result, removed: true, edited: false };
}

// ─── Plans ──────────────────────────────────────────────────────────────────

export interface PlanLine {
    /** + adds, - removes, · leaves as is, ! needs a look. */
    sign: '+' | '-' | '·' | '!';
    kind: 'package' | 'config' | 'variables' | 'service' | 'test';
    text: string;
}

export interface FixturePlan {
    command: 'add' | 'remove';
    fixtures: Array<{ entry: CatalogEntry; variant: FixtureVariant }>;
    lines: PlanLine[];
    /** New content per changed file, relative to the root (null: delete the file). */
    files: Map<string, string | null>;
    install: string[];
    uninstall: string[];
    /** Why the plan can't be applied (remove: tests still use the fixture). Empty when it can. */
    blockers: string[];
    /** What to do after applying. */
    notes: string[];
}

export interface AddRequest {
    id: string;
    variant?: string;
}

export interface AddOptions {
    /** Add the compose service(s) (default true). */
    service?: boolean;
    /** Add a starter test (default true). */
    test?: boolean;
}

/** Parses `database:mysql` into `{ id: 'database', variant: 'mysql' }`. */
export function parseRequest(arg: string): AddRequest {
    const [id, variant] = arg.split(':');
    return { id, variant: variant || undefined };
}

/** The entry and variant for `request`; throws with the choices when either is unknown. */
export function resolveRequest(request: AddRequest): { entry: CatalogEntry; variant: FixtureVariant } {
    const entry = catalogEntry(request.id);
    if (!entry) throw new Error(`unknown fixture "${request.id}". Choose from: ${FIXTURE_CATALOG.map((e) => e.id).join(', ')}`);
    if (!request.variant) return { entry, variant: entry.variants[0] };
    const variant = entry.variants.find((v) => v.id === request.variant!.toLowerCase());
    if (!variant) throw new Error(`${entry.id} has no variant "${request.variant}". Choose from: ${entry.variants.map((v) => v.id).join(', ')}`);
    return { entry, variant };
}

function testDir(root: string, entry: CatalogEntry): string {
    const dir = TEST_TYPES.find((t) => t.type === entry.testType)!.dir;
    return fs.existsSync(path.join(root, dir)) ? dir : 'tests';
}

/** Works out what adding `requests` would change. Writes nothing. */
export function planAdd(root: string, requests: AddRequest[], options: AddOptions = {}): FixturePlan {
    const files = new Files(root);
    const installed = installedPackages(root);
    const plan: FixturePlan = { command: 'add', fixtures: requests.map(resolveRequest), lines: [], files: new Map(), install: [], uninstall: [], blockers: [], notes: [] };
    const { ids } = collect(root);
    const allocated: IdEntry[] = [...ids];

    let environments = files.read(ENVIRONMENTS_FILE);
    if (environments === null) {
        environments = NEW_ENVIRONMENTS;
        plan.lines.push({ sign: '+', kind: 'config', text: `${ENVIRONMENTS_FILE} (new, with a local environment)` });
    }
    const envs = environmentNames(environments);
    if (!envs.length) throw new Error(`${ENVIRONMENTS_FILE} has no "environments" object to add to.`);
    const local = localEnvironment(envs);

    for (const { entry, variant } of plan.fixtures) {
        for (const pkg of variant.packages) {
            if (installed.has(pkg) || plan.install.includes(pkg)) plan.lines.push({ sign: '·', kind: 'package', text: `${pkg} already installed` });
            else {
                plan.install.push(pkg);
                plan.lines.push({ sign: '+', kind: 'package', text: pkg });
            }
        }

        const added = new Map<string, string[]>();
        const kept = new Map<string, string[]>();
        const push = (map: Map<string, string[]>, key: string, env: string) => map.set(key, [...(map.get(key) ?? []), env]);
        for (const item of variant.config) {
            for (const env of envs) {
                const value = env === local ? item.value : placeholderValue(item.value, item.path[item.path.length - 1]);
                const result = addConfigItem(environments, env, item, value);
                environments = result.text;
                push(result.added ? added : kept, configKey(item), env);
                if (!result.added) {
                    for (const problem of conflicts(valueAt(environments, ['environments', env, ...item.path]), item.value)) {
                        plan.lines.push({ sign: '!', kind: 'config', text: `${ENVIRONMENTS_FILE}: ${env}.${configKey(item)}.${problem}` });
                    }
                }
            }
        }
        const where = (map: Map<string, string[]>) => [...map].map(([key, list]) => `${key} in ${list.join(', ')}`).join('; ');
        if (added.size) plan.lines.push({ sign: '+', kind: 'config', text: `${ENVIRONMENTS_FILE}: ${where(added)}${envs.length > 1 ? ` (${PLACEHOLDER} outside ${local})` : ''}` });
        if (kept.size) plan.lines.push({ sign: '·', kind: 'config', text: `${ENVIRONMENTS_FILE}: ${where(kept)} already set` });

        for (const s of variant.env) {
            const before = files.read(ENV_EXAMPLE_FILE);
            const after = addEnvSection(before, s);
            if (after === before) plan.lines.push({ sign: '·', kind: 'variables', text: `${ENV_EXAMPLE_FILE}: ${s.title} already there` });
            else {
                files.write(ENV_EXAMPLE_FILE, after);
                plan.lines.push({ sign: '+', kind: 'variables', text: `${ENV_EXAMPLE_FILE}: ${s.vars.map((v) => v.name).join(', ')}` });
            }
        }

        if (options.service !== false) {
            for (const svc of variant.services) {
                const before = files.read(COMPOSE_FILE);
                if (hasService(before, svc.name)) plan.lines.push({ sign: '·', kind: 'service', text: `${COMPOSE_FILE}: ${svc.name} already there` });
                else {
                    files.write(COMPOSE_FILE, addService(before, svc));
                    plan.lines.push({ sign: '+', kind: 'service', text: `${COMPOSE_FILE}: ${svc.name}${before === null ? ' (new file)' : ''}` });
                }
            }
        }

        if (options.test !== false) {
            const file = `${testDir(root, entry)}/${entry.starter.file}.spec.ts`;
            if (files.read(file) !== null) plan.lines.push({ sign: '·', kind: 'test', text: `${file} already exists` });
            else {
                const [id] = nextIds(entry.category, allocated);
                allocated.push({ id, category: entry.category, num: Number(id.split('-')[2]), file, line: 1 } as IdEntry);
                files.write(file, starterSource(entry, id));
                plan.lines.push({ sign: '+', kind: 'test', text: `${file} [${id}]` });
            }
        }
        if (entry.next) plan.notes.push(`${entry.label}: ${entry.next}`);
    }

    files.write(ENVIRONMENTS_FILE, environments);
    plan.files = files.changes();
    if (plan.fixtures.some(({ variant }) => variant.services.length) && options.service !== false) {
        plan.notes.unshift(`Start the services: docker compose -f ${COMPOSE_FILE} up -d --wait`);
    }
    return plan;
}

/** Each test file (relative path) with the fixtures its tests request. */
function scanTests(root: string): Array<{ file: string; fixtures: string[] }> {
    const config = loadConfig(root);
    const out = new Map<string, string[]>();
    for (const dir of config.testDirs) {
        for (const full of walk(path.join(root, dir))) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (!config.testFileSuffixes.some((s) => rel.endsWith(s)) || out.has(rel)) continue;
            out.set(rel, [...new Set(analyzeSource(fs.readFileSync(full, 'utf-8')).tests.flatMap((t) => t.fixtures))]);
        }
    }
    return [...out].map(([file, fixtures]) => ({ file, fixtures })).sort((a, b) => a.file.localeCompare(b.file));
}

/** Every fixture name the project's tests request. */
export function testFixtures(root: string): string[] {
    return [...new Set(scanTests(root).flatMap((t) => t.fixtures))];
}

/** Test files (relative paths) whose tests request any of `fixtures`. */
export function testsUsing(root: string, fixtures: readonly string[]): string[] {
    return scanTests(root)
        .filter((t) => t.fixtures.some((f) => fixtures.includes(f)))
        .map((t) => t.file);
}

/** Works out what removing `id` would change. Writes nothing; `blockers` lists tests that still use it. */
export function planRemove(root: string, id: string): FixturePlan {
    const entry = catalogEntry(id);
    if (!entry) throw new Error(`unknown fixture "${id}". Choose from: ${FIXTURE_CATALOG.map((e) => e.id).join(', ')}`);
    const files = new Files(root);
    const states = fixtureStates(root, files);
    const state = states.find((s) => s.entry === entry)!;
    const others = states.filter((s) => s.present && s.entry !== entry);
    const otherVariants = others.map((s) => s.variant!);
    const plan: FixturePlan = { command: 'remove', fixtures: [{ entry, variant: state.variant ?? entry.variants[0] }], lines: [], files: new Map(), install: [], uninstall: [], blockers: [], notes: [] };

    // Tests: unchanged starter tests go with the fixture; any other test using it blocks the removal.
    for (const file of testsUsing(root, entry.fixtures)) {
        const content = files.read(file)!;
        const starterId = /\[(TC-[A-Z][A-Z0-9]*-\d+)\]/.exec(content)?.[1];
        if (path.basename(file) === `${entry.starter.file}.spec.ts` && starterId && content === starterSource(entry, starterId)) {
            files.write(file, null);
            plan.lines.push({ sign: '-', kind: 'test', text: `${file} (the starter test, unchanged)` });
        } else plan.blockers.push(file);
    }

    const installed = installedPackages(root);
    const neededElsewhere = new Set(otherVariants.flatMap((v) => v.packages));
    for (const pkg of allPackages(entry)) {
        if (installed.has(pkg) && !neededElsewhere.has(pkg)) {
            plan.uninstall.push(pkg);
            plan.lines.push({ sign: '-', kind: 'package', text: pkg });
        }
    }

    let environments = files.read(ENVIRONMENTS_FILE);
    if (environments !== null) {
        const shared = new Set(otherVariants.flatMap((v) => v.config.map(configKey)));
        // Every value add could have written at each path (one per variant).
        const items = new Map<string, ConfigItem[]>();
        for (const item of entry.variants.flatMap((v) => v.config)) items.set(configKey(item), [...(items.get(configKey(item)) ?? []), item]);
        const names = environmentNames(environments);
        const local = localEnvironment(names);
        const removed: string[] = [];
        const kept: string[] = [];
        for (const env of names) {
            for (const [key, variants] of items) {
                if (shared.has(key)) continue;
                const current = valueAt(environments, ['environments', env, ...variants[0].path]);
                if (current === undefined) continue;
                const written = variants.map((item) => (env === local ? item.value : placeholderValue(item.value, item.path[item.path.length - 1])));
                if (!written.some((w) => sameJson(w, current))) {
                    kept.push(`${env}.${key}`);
                    continue;
                }
                environments = removeConfigItem(environments, env, variants[0]).text;
                removed.push(`${env}.${key}`);
            }
        }
        if (removed.length) plan.lines.push({ sign: '-', kind: 'config', text: `${ENVIRONMENTS_FILE}: ${removed.join(', ')}` });
        if (kept.length) plan.lines.push({ sign: '!', kind: 'config', text: `${ENVIRONMENTS_FILE}: ${kept.join(', ')} kept (your own values; delete them yourself if nothing needs them)` });
        files.write(ENVIRONMENTS_FILE, environments === NEW_ENVIRONMENTS ? null : environments);
    }

    const sharedGroups = new Set(otherVariants.flatMap((v) => v.env.map((s) => s.group)));
    for (const group of new Set(entry.variants.flatMap((v) => v.env.map((s) => s.group)))) {
        if (sharedGroups.has(group)) continue;
        const before = files.read(ENV_EXAMPLE_FILE);
        const after = removeEnvSection(before, group);
        if (after !== before) {
            files.write(ENV_EXAMPLE_FILE, after);
            plan.lines.push({ sign: '-', kind: 'variables', text: `${ENV_EXAMPLE_FILE}: the ${entry.variants.flatMap((v) => v.env).find((s) => s.group === group)!.title} section` });
        }
    }

    const sharedServices = new Set(otherVariants.flatMap((v) => v.services.map((s) => s.name)));
    const services = new Map(entry.variants.flatMap((v) => v.services).map((s) => [s.name, s]));
    for (const svc of services.values()) {
        if (sharedServices.has(svc.name)) continue;
        const result = removeService(files.read(COMPOSE_FILE), svc);
        if (result.removed) {
            files.write(COMPOSE_FILE, result.text);
            plan.lines.push({ sign: '-', kind: 'service', text: `${COMPOSE_FILE}: ${svc.name}` });
        } else if (result.edited) plan.lines.push({ sign: '!', kind: 'service', text: `${COMPOSE_FILE}: ${svc.name} kept (changed since it was added; remove it yourself if nothing else needs it)` });
    }

    if (!plan.lines.length && !plan.blockers.length) plan.notes.push(`${entry.id} isn't set up in this project: nothing to remove.`);
    plan.files = files.changes();
    return plan;
}

// ─── Applying ───────────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** The project's package manager, from its lock file (npm when there's none). */
export function packageManager(root: string): PackageManager {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
    return 'npm';
}

/** The command that installs (as dev dependencies) or removes `packages`. */
export function packageCommand(pm: PackageManager, action: 'install' | 'uninstall', packages: string[]): string[] {
    const verbs: Record<PackageManager, [string[], string[]]> = {
        npm: [['install', '--save-dev'], ['uninstall']],
        pnpm: [['add', '-D'], ['remove']],
        yarn: [['add', '-D'], ['remove']],
        bun: [['add', '-d'], ['remove']],
    };
    return [pm, ...verbs[pm][action === 'install' ? 0 : 1], ...packages];
}

export type CommandRunner = (command: string[], cwd: string) => { ok: boolean; output: string };

/** Runs a command with its output on this terminal. */
export const inheritRunner: CommandRunner = ([cmd, ...args], cwd) => {
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    return { ok: result.status === 0, output: '' };
};

/** Runs a command and keeps its output (the MCP tools). */
export const captureRunner: CommandRunner = ([cmd, ...args], cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10 * 60_000 });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

export interface ApplyOptions {
    /** Skip installing or removing packages (print the command instead). */
    install?: boolean;
    runner?: CommandRunner;
}

export interface ApplyResult {
    ok: boolean;
    written: string[];
    deleted: string[];
    /** The package command run (or to run, with install: false), if any. */
    command?: string;
    output: string;
}

/** Writes the plan's files, then installs or removes its packages. Throws when the plan has blockers. */
export function applyPlan(root: string, plan: FixturePlan, options: ApplyOptions = {}): ApplyResult {
    if (plan.blockers.length) throw new Error(`can't remove ${plan.fixtures[0].entry.id}: tests still use it (${plan.blockers.join(', ')})`);
    const result: ApplyResult = { ok: true, written: [], deleted: [], output: '' };
    for (const [rel, content] of plan.files) {
        const full = path.join(root, rel);
        if (content === null) {
            if (fs.existsSync(full)) fs.rmSync(full);
            result.deleted.push(rel);
        } else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, 'utf-8');
            result.written.push(rel);
        }
    }
    const packages = plan.command === 'add' ? plan.install : plan.uninstall;
    if (packages.length) {
        const command = packageCommand(packageManager(root), plan.command === 'add' ? 'install' : 'uninstall', packages);
        result.command = command.join(' ');
        if (options.install !== false) {
            const run = (options.runner ?? inheritRunner)(command, root);
            result.ok = run.ok;
            result.output = run.output;
        }
    }
    return result;
}

/** A title and plan lines as text: `+ config    environments.json: ...`. */
export function formatPlanLines(title: string, lines: ReadonlyArray<{ sign: PlanLine['sign']; kind: string; text: string }>, color = false): string[] {
    const s = styleFor({ isTTY: color }, color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' });
    const paint = { '+': s.green, '-': s.red, '·': s.dim, '!': s.yellow } as const;
    return [s.bold(title), ...lines.map((line) => `  ${paint[line.sign](line.sign)} ${line.kind.padEnd(9)} ${line.sign === '·' ? s.dim(line.text) : line.text}`)];
}

/** The plan as lines of text, for the terminal and the MCP tools. */
export function formatFixturePlan(plan: FixturePlan, color = false): string[] {
    const s = styleFor({ isTTY: color }, color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' });
    const names = plan.fixtures.map(({ entry, variant }) => `${entry.id}${entry.variants.length > 1 ? ` (${variant.label})` : ''}`).join(', ');
    const out = formatPlanLines(`${plan.command === 'add' ? 'Add' : 'Remove'} ${names}`, plan.lines, color);
    if (plan.blockers.length) {
        out.push('', s.red(`Can't remove ${plan.fixtures[0].entry.id}: these tests still use ${plan.fixtures[0].entry.fixtures.join(', ')}:`));
        for (const file of plan.blockers) out.push(`  ${file}`);
        out.push('Change or delete them first.');
    }
    return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `
  Usage:
    npx propmaster fixture list [--json]
    npx propmaster fixture add [fixture[:variant]...] [--no-service] [--no-test] [--no-install] [--dry-run]
    npx propmaster fixture remove [fixture] [--no-install] [--dry-run]

  add      Install a fixture's driver and add its block to every environment in
           environments.json, its PW_* variables to .env.example, a service to
           compose.test.yaml and a starter test. Adds only what's missing.
           With no fixture, pick from a menu.
           Variants: database:postgresql|mysql|mssql|sqlite, kafka:kafkajs|confluent,
           search:elasticsearch|opensearch (the first is the default).
  remove   Undo add. Refuses while tests still use the fixture, and names them.
  list     The fixtures and which ones this project has.

  Options:
    --no-service   don't add a compose.test.yaml service
    --no-test      don't add a starter test
    --no-install   change the files only; print the package command to run
    --dry-run      show the plan and change nothing
    --root <dir>   the project (default: the nearest package.json)
`;

function option(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
}

function positionals(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') i++;
        else if (!argv[i].startsWith('-')) out.push(argv[i]);
    }
    return out;
}

function printList(root: string, json: boolean, log: (line?: string) => void): number {
    const states = fixtureStates(root);
    if (json) {
        log(
            JSON.stringify(
                states.map(({ entry, present, variant }) => ({
                    id: entry.id,
                    label: entry.label,
                    fixtures: entry.fixtures,
                    present,
                    variant: present && entry.variants.length > 1 ? variant!.id : undefined,
                    variants: entry.variants.length > 1 ? entry.variants.map((v) => v.id) : undefined,
                })),
                null,
                2,
            ),
        );
        return 0;
    }
    const s = styleFor();
    const width = Math.max(...states.map((x) => x.entry.id.length));
    for (const { entry, present, variant } of states) {
        const status = present ? s.green(`✓ added${entry.variants.length > 1 ? ` (${variant!.label})` : ''}`) : s.dim('· not added');
        log(`  ${entry.id.padEnd(width)}  ${entry.label.padEnd(34)} ${s.dim(entry.fixtures.join(', ').padEnd(16))} ${status}`);
    }
    return 0;
}

async function chooseAdd(root: string): Promise<{ requests: AddRequest[]; options: AddOptions }> {
    const states = fixtureStates(root);
    const choices: Choice<string>[] = states.map(({ entry, present }) => ({
        value: entry.id,
        label: entry.id,
        hint: `${entry.label} · ${entry.fixtures.join(', ')}`,
        search: entry.label,
        disabled: present ? 'already added' : false,
    }));
    const ids = await multiselect({ message: 'Fixtures to add', choices, flag: '<fixture>, e.g. `propmaster fixture add redis`' });
    const requests: AddRequest[] = [];
    for (const id of ids) {
        const entry = catalogEntry(id)!;
        const variant =
            entry.variants.length > 1
                ? await select({ message: `${entry.label}: which one?`, choices: entry.variants.map((v) => ({ value: v.id, label: v.label })), flag: `${id}:<variant>` })
                : undefined;
        requests.push({ id, variant });
    }
    const resolved = requests.map(resolveRequest);
    const options: AddOptions = {};
    if (resolved.some((r) => r.variant.services.length)) {
        options.service = await confirm({ message: `Add services to ${COMPOSE_FILE}, to run the backends locally?`, default: true, flag: '--no-service' });
    }
    options.test = await confirm({ message: 'Add a starter test for each?', default: true, flag: '--no-test' });
    return { requests, options };
}

/** `propmaster fixture ...` */
export async function runFixture(argv: string[], log: (line?: string) => void = console.log, runner: CommandRunner = inheritRunner): Promise<number> {
    const root = option(argv, '--root') ? path.resolve(option(argv, '--root')!) : findProjectRoot();
    let [sub, ...args] = positionals(argv);
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    if (flags.has('--help') || sub === 'help') {
        log(HELP);
        return 0;
    }
    if (!sub && isInteractive()) {
        sub = await select({
            message: 'Fixtures',
            choices: [
                { value: 'add', label: 'add', hint: 'set a fixture up in this project' },
                { value: 'remove', label: 'remove', hint: 'take one out again' },
                { value: 'list', label: 'list', hint: 'which ones this project has' },
            ],
            flag: 'add, remove or list',
        });
    }
    if (sub === 'list') return printList(root, flags.has('--json'), log);
    if (sub !== 'add' && sub !== 'remove') {
        log(HELP);
        return sub ? 2 : 0;
    }

    const asked = args.length === 0;
    let plan: FixturePlan;
    try {
        if (sub === 'add') {
            const chosen = asked ? await chooseAdd(root) : { requests: args.map(parseRequest), options: {} as AddOptions };
            if (flags.has('--no-service')) chosen.options.service = false;
            if (flags.has('--no-test')) chosen.options.test = false;
            plan = planAdd(root, chosen.requests, chosen.options);
        } else {
            const present = fixtureStates(root).filter((x) => x.present);
            let id = args[0];
            if (!id) {
                if (!present.length) {
                    log('  No fixtures from the catalog are set up in this project.');
                    return 0;
                }
                id = await select({
                    message: 'Fixture to remove',
                    choices: present.map(({ entry }) => ({ value: entry.id, label: entry.id, hint: entry.label })),
                    flag: '<fixture>, e.g. `propmaster fixture remove redis`',
                });
            }
            plan = planRemove(root, id);
        }
    } catch (error) {
        if (error instanceof Error && error.name !== 'NotInteractiveError' && error.name !== 'PromptCancelledError') {
            log(`  ${styleFor().red('✖')} ${error.message}`);
            return 2;
        }
        throw error;
    }

    const color = styleFor().enabled;
    log('');
    for (const line of formatFixturePlan(plan, color)) log(`  ${line}`);
    log('');
    if (plan.blockers.length) return 1;
    const changes = plan.files.size + plan.install.length + plan.uninstall.length;
    if (!changes) {
        log(`  Nothing to change.${plan.notes.length ? '' : ''}`);
        for (const note of plan.notes) log(`  ${note}`);
        return 0;
    }
    if (flags.has('--dry-run')) {
        log('  Dry run: nothing changed.');
        return 0;
    }
    if (asked && !(await confirm({ message: 'Apply these changes?', default: true, flag: '--yes' }))) return 0;

    const result = applyPlan(root, plan, { install: !flags.has('--no-install'), runner });
    const s = styleFor();
    if (!result.ok) {
        log(`  ${s.red('✖')} ${result.command} failed. The files were changed; run it again once the problem is fixed.`);
        return 1;
    }
    log(`  ${s.green('✔')} ${plan.command === 'add' ? 'Added' : 'Removed'} ${plan.fixtures.map((f) => f.entry.id).join(', ')}.`);
    if (result.command && flags.has('--no-install')) log(`  Run: ${result.command}`);
    for (const note of plan.notes) log(`  ${s.dim('→')} ${note}`);
    return 0;
}
