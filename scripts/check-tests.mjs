#!/usr/bin/env node
/**
 * Backwards-compatible entry point for the test convention checker.
 *
 * The checker now lives in `src/cli/check-tests.ts` and ships with the package
 * as `propmaster check` / `propmaster next-id`. This wrapper runs it from source
 * (via tsx, a devDependency) so it works in this repo without a build:
 *
 *   node scripts/check-tests.mjs                 # = propmaster check
 *   node scripts/check-tests.mjs --json          # = propmaster check --json
 *   node scripts/check-tests.mjs --list-ids      # = propmaster check --list-ids
 *   node scripts/check-tests.mjs --next-id API 3 # = propmaster next-id API 3
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const nextIdx = argv.indexOf('--next-id');
const args = nextIdx === -1 ? ['check', ...argv] : ['next-id', ...argv.slice(nextIdx + 1)];

const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/init.ts', ...args, '--root', root], {
    cwd: root,
    stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
