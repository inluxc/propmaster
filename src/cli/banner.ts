/**
 * The logo and version the CLI shows at the start of commands people run
 * themselves. Never for `propmaster mcp` (stdout is the protocol), `--json`,
 * `--quiet`, output that isn't a terminal, or CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleFor, type Style, type StyleStream } from './style.js';

const LETTERS: Record<string, [string, string, string]> = {
    p: ['┌─┐', '├─┘', '┴  '],
    r: ['┬─┐', '├┬┘', '┴└─'],
    o: ['┌─┐', '│ │', '└─┘'],
    m: ['┌┬┐', '│││', '┴ ┴'],
    a: ['┌─┐', '├─┤', '┴ ┴'],
    s: ['┌─┐', '└─┐', '└─┘'],
    t: ['┌┬┐', ' │ ', ' ┴ '],
    e: ['┌─┐', '├┤ ', '└─┘'],
};

/** "propmaster" in box-drawing letters, three rows. */
export function logoLines(): string[] {
    return [0, 1, 2].map((row) => [...'propmaster'].map((c) => LETTERS[c][row]).join(''));
}

let cachedVersion: string | undefined;

/** The installed package's version, from the nearest package.json named @inluxc/propmaster. */
export function packageVersion(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
    if (cachedVersion) return cachedVersion;
    for (let dir = from; ; dir = path.dirname(dir)) {
        const file = path.join(dir, 'package.json');
        if (fs.existsSync(file)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { name?: string; version?: string };
                if (pkg.name === '@inluxc/propmaster' && pkg.version) return (cachedVersion = pkg.version);
            } catch {
                // not JSON: keep looking
            }
        }
        if (path.dirname(dir) === dir) return 'unknown';
    }
}

export interface BannerOptions {
    version?: string;
    /** Shown after the version, for commands that use an environment. */
    environment?: string;
    style?: Style;
}

/** The banner: the logo, then `v1.0.0 · environment: local`. */
export function banner(options: BannerOptions = {}): string {
    const s = options.style ?? styleFor();
    const version = options.version ?? packageVersion();
    const details = [s.bold(`v${version}`), ...(options.environment ? [`environment: ${s.cyan(options.environment)}`] : [])].join(s.dim(' · '));
    return ['', ...logoLines().map((line) => `  ${s.gradient(line)}`), `  ${details}`, ''].join('\n');
}

/** Whether a command run with `argv` should show the banner on `stream`. */
export function shouldShowBanner(argv: readonly string[], stream: StyleStream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
    if (stream.isTTY !== true) return false;
    if (env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false') return false;
    if (env.PROPMASTER_NO_BANNER) return false;
    return !argv.some((a) => a === '--json' || a === '--quiet' || a === '-q');
}

/** Prints the banner when `shouldShowBanner` says so. */
export function printBanner(argv: readonly string[], options: BannerOptions = {}, stream: NodeJS.WriteStream = process.stdout): void {
    if (shouldShowBanner(argv, stream)) stream.write(`${banner({ style: styleFor(stream), ...options })}\n`);
}
