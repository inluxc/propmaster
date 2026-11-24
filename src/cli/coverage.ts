/**
 * `propmaster coverage`: what the tests cover, per layer (unit, integration,
 * e2e). Read from the test sources, the test history, the OpenAPI spec and
 * any code-coverage reports already in the project; runs nothing.
 *
 *   npx propmaster coverage                       summary and gaps
 *   npx propmaster coverage --layer e2e           one layer
 *   npx propmaster coverage --report app/coverage/lcov.info
 *   npx propmaster coverage --json --tests        everything, with each test and what it touches
 */

import { resolve } from 'node:path';
import { ConfigLoader } from '../config/loader.js';
import type { FrameworkConfig } from '../config/schema.js';
import { coverageReport, formatCoverageReport } from '../coverage/report.js';
import { LAYERS, type Layer } from '../coverage/inventory.js';
import { findProjectRoot } from './check-tests.js';

export const COVERAGE_HELP = `
  npx propmaster coverage [--layer unit|integration|e2e] [--spec <path|url>] [--no-spec]
                          [--report <file>]... [--runs <n>] [--tests] [--json] [-e <env>] [--root <dir>]

  What the tests cover, per layer of the pyramid:
    unit         no service, browser or device (plain logic, property tests, Vitest/Jest files,
                 and the application's own tests in Python, Go, Java/Kotlin, C#, Ruby, PHP, Rust, ...)
    integration  API clients and backend clients (tests/api, tests/integration)
    e2e          browser and device tests (tests/e2e, tests/mobile)

  For each layer: tests, their state in the code (skip/fixme) and in the test
  history (last run, pass rate), the fixtures they use and what they touch
  (operations, tables, topics, queues, routes, ...). Then the OpenAPI
  operations and documented status codes no test asserts, backends that are
  configured but untested, and the code-coverage reports already in the
  project, from any language's tools (LCOV, Istanbul, Cobertura, JaCoCo,
  Clover, OpenCover, Go cover profiles, coverage.py JSON, SimpleCov). Reads
  files only.

  --layer     Only this layer
  --spec      OpenAPI spec (default: openapi.specPath of the environment); --no-spec to skip it
  --report    A code-coverage report file (default: the ones found in the project); repeatable
  --runs      Newest test-history runs to read (default 30)
  --tests     With --json: every test and what it touches
  --json      The whole report as JSON
`;

function option(argv: string[], ...names: string[]): string[] {
    const values: string[] = [];
    argv.forEach((a, i) => {
        for (const name of names) {
            if (a === name && argv[i + 1] !== undefined) values.push(argv[i + 1]);
            else if (a.startsWith(`${name}=`)) values.push(a.slice(name.length + 1));
        }
    });
    return values;
}

/** Runs the command; returns the exit code. */
export async function runCoverage(argv: string[], log: (line?: string) => void = console.log, cwd: string = process.cwd()): Promise<number> {
    if (argv.includes('--help') || argv.includes('-h')) {
        log(COVERAGE_HELP);
        return 0;
    }
    try {
        const rootOption = option(argv, '--root')[0];
        const root = rootOption ? resolve(cwd, rootOption) : findProjectRoot(cwd);
        const layer = option(argv, '--layer')[0];
        if (layer !== undefined && !LAYERS.includes(layer as Layer)) throw new Error(`--layer must be one of ${LAYERS.join(', ')}, not "${layer}"`);
        const runsValue = option(argv, '--runs')[0];
        const runs = runsValue === undefined ? undefined : Number(runsValue);
        if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) throw new Error(`--runs must be a whole number of 1 or more, not "${runsValue}"`);
        const environment = option(argv, '--environment', '-e')[0];
        let config: FrameworkConfig | undefined;
        try {
            config = new ConfigLoader(root).load(environment);
        } catch {
            // No environments.json: the report still covers the tests.
        }
        const reports = option(argv, '--report');
        const report = await coverageReport({
            root,
            config,
            spec: argv.includes('--no-spec') ? false : option(argv, '--spec')[0],
            layer: layer as Layer | undefined,
            reports: reports.length ? reports : undefined,
            runs,
            tests: argv.includes('--tests'),
            limit: argv.includes('--json') ? 100_000 : 1000,
        });
        log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatCoverageReport(report));
        return 0;
    } catch (error) {
        log(`propmaster coverage: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
}
