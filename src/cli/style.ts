/**
 * Terminal colours for the CLI, with no dependency. Colour is on for a
 * terminal and off otherwise; NO_COLOR turns it off and FORCE_COLOR on
 * (https://no-color.org).
 */

export interface StyleStream {
    isTTY?: boolean;
}

/** Whether to colour output written to `stream`. */
export function colorEnabled(stream: StyleStream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false') return true;
    if (env.TERM === 'dumb') return false;
    return stream.isTTY === true;
}

export interface Style {
    readonly enabled: boolean;
    bold(text: string): string;
    dim(text: string): string;
    cyan(text: string): string;
    green(text: string): string;
    yellow(text: string): string;
    red(text: string): string;
    magenta(text: string): string;
    /** `text` coloured from magenta to cyan, one colour per character (256-colour palette). */
    gradient(text: string): string;
}

const wrap = (open: number, close: number) => (on: boolean) => (text: string) => (on ? `\x1b[${open}m${text}\x1b[${close}m` : text);

const codes = {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    magenta: wrap(35, 39),
};

/** Magenta → violet → blue → cyan in the 256-colour palette. */
const GRADIENT = [201, 165, 129, 93, 63, 33, 39, 45, 51];

export function createStyle(enabled: boolean): Style {
    return {
        enabled,
        bold: codes.bold(enabled),
        dim: codes.dim(enabled),
        cyan: codes.cyan(enabled),
        green: codes.green(enabled),
        yellow: codes.yellow(enabled),
        red: codes.red(enabled),
        magenta: codes.magenta(enabled),
        gradient(text) {
            if (!enabled) return text;
            const chars = [...text];
            const last = Math.max(1, chars.length - 1);
            return (
                chars.map((c, i) => (c === ' ' ? c : `\x1b[38;5;${GRADIENT[Math.round((i / last) * (GRADIENT.length - 1))]}m${c}`)).join('') +
                '\x1b[39m'
            );
        },
    };
}

/** The style for `stream` (stdout by default). */
export function styleFor(stream: StyleStream = process.stdout, env: NodeJS.ProcessEnv = process.env): Style {
    return createStyle(colorEnabled(stream, env));
}

/** `text` without ANSI escape codes. */
export function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
