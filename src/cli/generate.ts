/**
 * `propmaster generate openapi`: writes API test files from the OpenAPI spec,
 * one per tag, with real TestCaseIDs. Never overwrites a file and skips
 * operation/status pairs that already have a test.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { collect, findProjectRoot, loadConfig, nextIds, walk } from './check-tests.js';
import { ConfigLoader } from '../config/loader.js';
import { installedPackageDir, packageCommand, packageManager } from '../package-manager.js';
import { loadOpenApiDocument } from '../openapi/load.js';
import { coveredOperations, generateApiTests, type GenerateResult } from '../openapi/generate.js';

export const GENERATE_HELP = `
  propmaster generate openapi: scaffold API tests from the OpenAPI spec

  Usage:
    npx propmaster generate openapi [--spec <path|url>] [--tag <tag>]... [--operation <operationId>]...
                                    [--out <dir>] [--category API] [--prism] [--no-contract] [--dry-run]

  Writes one spec file per tag to tests/api/: a test per operation and
  documented status code, with TestCaseIDs from next-id and test.step() blocks.
  2xx tests send a request built from the schema examples; 400/422 tests send a
  body without its required fields; 404 tests use path parameters that don't
  exist. Other status codes get test.fixme with a TODO.

  Options:
    --spec <path|url>   OpenAPI spec (default: openapi.specPath from environments.json / PW_OPENAPI_SPEC_PATH)
    --tag <tag>         Only operations with this tag (repeatable, or comma-separated)
    --operation <id>    Only this operationId (repeatable, or comma-separated)
    --out <dir>         Output directory (default: tests/api)
    --category <CODE>   TestCaseID category (default: API)
    --prism             Every status code runs: requests send Prefer: code=<status>,
                        which a Prism mock (npx prism mock <spec>) answers with that response
    --no-contract       No step checking the response body against the spec
                        (default: on when ajv is installed)
    --import <module>   Where tests import test/expect from (default: @inluxc/propmaster)
    --environment, -e   Environment for the spec path (default: PW_ENVIRONMENT, else local)
    --dry-run           Print what would be written; write nothing
    --root <dir>        Project root (default: nearest package.json)
`;

export interface GenerateCliOptions {
    root: string;
    spec?: string;
    tags: string[];
    operations: string[];
    out: string;
    category: string;
    prism: boolean;
    contract?: boolean;
    importFrom: string;
    environment?: string;
    dryRun: boolean;
}

export function parseGenerateArgs(argv: string[], cwd: string = process.cwd()): GenerateCliOptions | { help: true } | { error: string } {
    const [target, ...rest] = argv;
    if (target === undefined || target === '--help' || target === '-h' || target === 'help') return { help: true };
    if (target !== 'openapi') return { error: `Unknown generator "${target}". Available: openapi` };

    const o: GenerateCliOptions = { root: '', tags: [], operations: [], out: 'tests/api', category: 'API', prism: false, importFrom: '@inluxc/propmaster', dryRun: false };
    let root: string | undefined;
    const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < rest.length; i++) {
        let arg = rest[i];
        let inline: string | undefined;
        const eq = arg.indexOf('=');
        if (arg.startsWith('--') && eq > 0) {
            inline = arg.slice(eq + 1);
            arg = arg.slice(0, eq);
        }
        const value = (): string => {
            const v = inline ?? rest[++i];
            if (v === undefined || (inline === undefined && v.startsWith('-'))) throw new Error(`${arg} needs a value`);
            return v;
        };
        try {
            switch (arg) {
                case '--help': case '-h': return { help: true };
                case '--spec': o.spec = value(); break;
                case '--tag': o.tags.push(...list(value())); break;
                case '--operation': o.operations.push(...list(value())); break;
                case '--out': o.out = value(); break;
                case '--category': o.category = value().toUpperCase(); break;
                case '--prism': o.prism = true; break;
                case '--contract': o.contract = true; break;
                case '--no-contract': o.contract = false; break;
                case '--import': o.importFrom = value(); break;
                case '--environment': case '-e': o.environment = value(); break;
                case '--dry-run': o.dryRun = true; break;
                case '--root': root = value(); break;
                default: return { error: `Unknown option: ${rest[i]}` };
            }
        } catch (error) {
            return { error: (error as Error).message };
        }
    }
    if (!/^[A-Z][A-Z0-9]{1,5}$/.test(o.category)) return { error: `--category must be 2–6 capital letters or digits, starting with a letter (got "${o.category}")` };
    o.root = root ? resolve(cwd, root) : findProjectRoot(cwd);
    return o;
}

function hasPackage(root: string, name: string): boolean {
    return installedPackageDir(root, name) !== undefined;
}

export interface GenerateRun {
    result: GenerateResult;
    outDir: string;
    written: string[];
    contract: boolean;
    contractNote?: string;
}

/** Plans and (unless dry-run) writes the files. */
export async function generateOpenApiTests(o: GenerateCliOptions): Promise<GenerateRun> {
    let specPath = o.spec;
    if (!specPath) {
        try {
            specPath = new ConfigLoader(o.root).load(o.environment).openapi?.specPath;
        } catch {
            // no environments.json: fall through to the error below
        }
    }
    if (!specPath) throw new Error('No OpenAPI spec: pass --spec <path|url>, or set openapi.specPath in environments.json or PW_OPENAPI_SPEC_PATH.');

    const doc = await loadOpenApiDocument(specPath, o.root);
    if (!doc.paths || (typeof doc.openapi !== 'string' && typeof doc.swagger !== 'string')) {
        throw new Error(`${specPath} isn't an OpenAPI document (no "openapi"/"swagger" version or no "paths").`);
    }

    // Existing IDs and operation/status pairs that already have a test
    const config = loadConfig(o.root);
    const { ids } = collect(o.root, config);
    const sources: string[] = [];
    for (const dir of config.testDirs) {
        for (const file of walk(join(o.root, dir))) {
            if (config.testFileSuffixes.some((s) => file.endsWith(s))) sources.push(readFileSync(file, 'utf8'));
        }
    }

    const outDir = resolve(o.root, o.out);
    const takenFiles = new Set(existsSync(outDir) ? readdirSync(outDir) : []);

    let contract = o.contract ?? true;
    let contractNote: string | undefined;
    if (o.contract === undefined && !(hasPackage(o.root, 'ajv') && hasPackage(o.root, 'ajv-formats'))) {
        contract = false;
        contractNote = `No response-schema steps: ajv and ajv-formats aren't installed (${packageCommand(packageManager(o.root), 'install', ['ajv', 'ajv-formats']).join(' ')}, then run again with --contract).`;
    }

    const result = generateApiTests(doc, {
        tags: o.tags.length > 0 ? o.tags : undefined,
        operations: o.operations.length > 0 ? o.operations : undefined,
        category: o.category,
        allocateIds: (n) => nextIds(o.category, ids, n),
        importFrom: o.importFrom,
        prism: o.prism,
        contract,
        existing: coveredOperations(sources),
        takenFiles,
    });

    const written: string[] = [];
    if (!o.dryRun && result.files.length > 0) {
        mkdirSync(outDir, { recursive: true });
        for (const file of result.files) {
            const full = join(outDir, file.fileName);
            // 'wx' fails if the file exists: never overwrite.
            writeFileSync(full, file.content, { encoding: 'utf8', flag: 'wx' });
            written.push(full);
        }
    }
    return { result, outDir, written, contract, contractNote };
}

/** `propmaster generate ...`. Returns the exit code. */
export async function runGenerate(argv: string[], log: (line?: string) => void = console.log): Promise<number> {
    const parsed = parseGenerateArgs(argv);
    if ('help' in parsed) {
        log(GENERATE_HELP);
        return 0;
    }
    if ('error' in parsed) {
        console.error(`propmaster generate: ${parsed.error}`);
        log(GENERATE_HELP);
        return 2;
    }

    let run: GenerateRun;
    try {
        run = await generateOpenApiTests(parsed);
    } catch (error) {
        console.error(`propmaster generate: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }

    const { result, outDir } = run;
    const rel = (p: string) => relative(process.cwd(), p) || '.';
    log('');
    if (result.files.length === 0) {
        log('  Nothing to generate.');
    } else {
        log(`  ${parsed.dryRun ? 'Would write' : 'Wrote'} ${result.files.length} file(s) to ${rel(outDir)}:`);
        for (const file of result.files) {
            const fixme = file.tests.filter((t) => t.kind === 'fixme').length;
            log(`    ${parsed.dryRun ? '·' : '✓'} ${file.fileName}: ${file.tests.length} test(s)${fixme ? `, ${fixme} test.fixme` : ''}  [${file.tests[0].id} – ${file.tests.at(-1)!.id}]`);
            if (parsed.dryRun) {
                for (const t of file.tests) log(`        ${t.id}  ${t.operationId} ${t.status}${t.kind === 'fixme' ? '  (fixme)' : ''}`);
            }
        }
    }
    if (result.alreadyCovered.length > 0) log(`  Skipped ${result.alreadyCovered.length} operation/status pair(s) that already have a test.`);
    for (const s of result.skipped) log(`  ! Skipped ${s.operation}: ${s.reason}`);
    if (run.contractNote) log(`  ${run.contractNote}`);
    if (!parsed.dryRun && result.files.length > 0) {
        log('');
        log('  Next steps:');
        log('    1. Replace the example values with data your API has; resolve the TODOs on test.fixme tests.');
        log('    2. npx propmaster check');
        log(`    3. npx playwright test ${rel(outDir)}`);
    }
    return 0;
}
