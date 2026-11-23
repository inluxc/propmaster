/**
 * MCP tools that change the project's setup, calling the same code as the
 * CLI. Each shows its plan unless called with `apply: true`, so the agent (and
 * the person approving its tool calls) sees what changes first. These change
 * project files, not backend data, so they don't need --allow-writes.
 */

import { FIXTURE_CATALOG } from '../cli/fixture-catalog.js';
import { applyPlan, captureRunner, fixtureStates, formatFixturePlan, parseRequest, planAdd, planRemove, type CommandRunner, type FixturePlan } from '../cli/fixture.js';
import { ToolInputError, type ToolDefinition } from './protocol.js';

const MAX_OUTPUT = 4000;

function planResult(plan: FixturePlan) {
    return {
        plan: formatFixturePlan(plan),
        files: [...plan.files.keys()],
        ...(plan.install.length ? { install: plan.install } : {}),
        ...(plan.uninstall.length ? { uninstall: plan.uninstall } : {}),
        ...(plan.blockers.length ? { blockedBy: plan.blockers } : {}),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
    };
}

function run(root: string, plan: FixturePlan, apply: boolean, install: boolean, runner: CommandRunner) {
    const result = planResult(plan);
    if (plan.blockers.length) return { ...result, applied: false, reason: 'Tests still use this fixture: change or delete them first.' };
    if (!plan.files.size && !plan.install.length && !plan.uninstall.length) return { ...result, applied: false, reason: 'Nothing to change.' };
    if (!apply) return { ...result, applied: false, reason: 'Dry run. Call again with apply: true to make these changes.' };
    const applied = applyPlan(root, plan, { install, runner });
    return {
        ...result,
        applied: true,
        ok: applied.ok,
        written: applied.written,
        deleted: applied.deleted,
        ...(applied.command ? { command: applied.command, ...(install ? {} : { run: 'install: false — run this command yourself' }) } : {}),
        ...(applied.output ? { output: applied.output.slice(-MAX_OUTPUT) } : {}),
    };
}

const bool = (args: Record<string, unknown>, key: string, fallback: boolean): boolean => {
    const v = args[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
    return v;
};

/** The project tools for the project at `root`. `runner` runs the package manager (injected by tests). */
export function projectTools(root: string, runner: CommandRunner = captureRunner): ToolDefinition[] {
    const ids = FIXTURE_CATALOG.map((e) => e.id);
    const variantNote = FIXTURE_CATALOG.filter((e) => e.variants.length > 1)
        .map((e) => `${e.id}:${e.variants.map((v) => v.id).join('|')}`)
        .join(', ');
    return [
        {
            name: 'fixtures_list',
            title: 'List fixtures',
            description: 'Lists the fixtures Propmaster can set up (id, label, the fixture names tests request) and which ones this project already has. Use the ids with fixture_add and fixture_remove.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async () => ({
                fixtures: fixtureStates(root).map(({ entry, present, variant }) => ({
                    id: entry.id,
                    label: entry.label,
                    fixtures: entry.fixtures,
                    present,
                    ...(entry.variants.length > 1 ? { variants: entry.variants.map((v) => v.id), ...(present ? { variant: variant!.id } : {}) } : {}),
                })),
            }),
        },
        {
            name: 'fixture_add',
            title: 'Add fixtures',
            description:
                'Sets fixtures up in the project: installs the driver, adds the config block to every environment in environments.json (CHANGE_ME outside local), the PW_* variables to .env.example, a compose.test.yaml service and a starter test with a fresh TestCaseID. Adds only what is missing. Returns the plan; nothing changes unless apply is true.',
            inputSchema: {
                type: 'object',
                properties: {
                    fixtures: { type: 'array', items: { type: 'string' }, minItems: 1, description: `Fixture ids (${ids.join(', ')}), optionally with a variant: ${variantNote}` },
                    service: { type: 'boolean', description: 'Add compose.test.yaml services (default true)' },
                    test: { type: 'boolean', description: 'Add a starter test (default true)' },
                    install: { type: 'boolean', description: 'Run the package manager (default true); false returns the command instead' },
                    apply: { type: 'boolean', description: 'Make the changes (default false: only show the plan)' },
                },
                required: ['fixtures'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            handler: async (args) => {
                const list = args.fixtures;
                if (!Array.isArray(list) || !list.length || !list.every((f) => typeof f === 'string')) throw new ToolInputError('fixtures must be a non-empty array of fixture ids');
                let plan: FixturePlan;
                try {
                    plan = planAdd(root, list.map(parseRequest), { service: bool(args, 'service', true), test: bool(args, 'test', true) });
                } catch (error) {
                    throw new ToolInputError(error instanceof Error ? error.message : String(error));
                }
                return run(root, plan, bool(args, 'apply', false), bool(args, 'install', true), runner);
            },
        },
        {
            name: 'fixture_remove',
            title: 'Remove a fixture',
            description:
                "Undoes fixture_add: uninstalls the driver, removes the config from every environment, the .env.example section, the compose service (if unchanged) and the unchanged starter test. Refuses while other tests still use the fixture and lists them. Returns the plan; nothing changes unless apply is true.",
            inputSchema: {
                type: 'object',
                properties: {
                    fixture: { type: 'string', description: `Fixture id: ${ids.join(', ')}` },
                    install: { type: 'boolean', description: 'Run the package manager (default true); false returns the command instead' },
                    apply: { type: 'boolean', description: 'Make the changes (default false: only show the plan)' },
                },
                required: ['fixture'],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
            handler: async (args) => {
                if (typeof args.fixture !== 'string') throw new ToolInputError('fixture must be a fixture id');
                let plan: FixturePlan;
                try {
                    plan = planRemove(root, args.fixture);
                } catch (error) {
                    throw new ToolInputError(error instanceof Error ? error.message : String(error));
                }
                return run(root, plan, bool(args, 'apply', false), bool(args, 'install', true), runner);
            },
        },
    ];
}
