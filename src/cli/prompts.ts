/**
 * Interactive prompts for the CLI, built on node:readline with no dependency:
 * `select` (arrow keys), `multiselect` (space to toggle), `confirm` and
 * `text`. Typing in a list filters it.
 *
 * Prompts are drawn on stderr, so a command's own output on stdout can still
 * be piped (`propmaster next-id | pbcopy` asks, then prints only the ID).
 *
 * With no one to answer (stdin or stderr isn't a terminal, or CI is set) a
 * prompt never waits: it throws NotInteractiveError naming the flag to pass
 * instead. Ctrl+C or Escape throws PromptCancelledError.
 */

import * as readline from 'node:readline';
import { createStyle, colorEnabled, stripAnsi, type Style } from './style.js';

export interface PromptInput extends NodeJS.EventEmitter {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
}

export interface PromptOutput {
    write(chunk: string): unknown;
    isTTY?: boolean;
    columns?: number;
}

export interface PromptIO {
    input: PromptInput;
    output: PromptOutput;
    env?: NodeJS.ProcessEnv;
}

/** A prompt had no one to answer it. `flag` is what to pass instead. */
export class NotInteractiveError extends Error {
    constructor(
        readonly question: string,
        readonly flag: string,
    ) {
        super(`${question}: no terminal to ask in. Pass ${flag}.`);
        this.name = 'NotInteractiveError';
    }
}

/** The user pressed Ctrl+C or Escape. */
export class PromptCancelledError extends Error {
    constructor() {
        super('Cancelled.');
        this.name = 'PromptCancelledError';
    }
}

export interface Choice<T> {
    value: T;
    label: string;
    /** Dimmed text after the label. */
    hint?: string;
    /** Shown but can't be picked; a string says why. */
    disabled?: boolean | string;
    /** More text that typing matches (the label and value always match; the hint doesn't). */
    search?: string;
}

interface Common {
    message: string;
    /** The flag that answers this prompt, for the error when there's no terminal (e.g. `--client <name>`). */
    flag: string;
}

export interface SelectOptions<T> extends Common {
    choices: Choice<T>[];
    /** The value the cursor starts on. */
    default?: T;
    /** Rows shown at once (default 10); the list scrolls. */
    pageSize?: number;
}

export interface MultiselectOptions<T> extends Common {
    choices: Choice<T>[];
    /** Values selected to start with. */
    defaults?: T[];
    /** At least one must be picked (default true). */
    required?: boolean;
    pageSize?: number;
}

export interface ConfirmOptions extends Common {
    /** What Enter answers (default false). */
    default?: boolean;
}

export interface TextOptions extends Common {
    /** What Enter answers with nothing typed. */
    default?: string;
    /** Dimmed example shown while nothing is typed. */
    placeholder?: string;
    /** An error message for a value that won't do, else undefined. */
    validate?: (value: string) => string | undefined;
}

/** stdin for keys, stderr for drawing. */
export function defaultIO(): PromptIO {
    return { input: process.stdin, output: process.stderr, env: process.env };
}

function truthy(value: string | undefined): boolean {
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/** Whether there's someone to answer a prompt: both ends are terminals and CI isn't set. */
export function isInteractive(io: PromptIO = defaultIO()): boolean {
    const env = io.env ?? process.env;
    if (truthy(env.CI)) return false;
    return io.input.isTTY === true && io.output.isTTY === true && typeof io.input.setRawMode === 'function';
}

// ─── Drawing ────────────────────────────────────────────────────────────────

interface Key {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    sequence?: string;
}

type Step<T> = { done: T } | undefined;

/** `text` cut to `width` visible characters, escape codes kept. */
export function truncate(text: string, width: number): string {
    if (stripAnsi(text).length <= width) return text;
    let visible = 0;
    let out = '';
    // eslint-disable-next-line no-control-regex
    const parts = text.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
    for (const part of parts) {
        if (part.startsWith('\x1b[')) {
            out += part;
            continue;
        }
        for (const ch of part) {
            if (visible >= width - 1) return `${out}…\x1b[0m`;
            out += ch;
            visible++;
        }
    }
    return out;
}

/**
 * Runs one prompt: draws `render()`, feeds keys to `onKey` until it returns
 * `{ done }`, then replaces the prompt with `summary(value)`.
 */
function run<T>(
    io: PromptIO,
    render: () => string[],
    onKey: (str: string | undefined, key: Key) => Step<T>,
    summary: (value: T) => string,
    cancelled: string,
): Promise<T> {
    const { input, output } = io;
    return new Promise<T>((resolve, reject) => {
        let lines = 0;
        const width = () => Math.max(20, (output.columns || 80) - 1);
        const draw = (rows: string[]) => {
            const up = lines > 0 ? `\x1b[${lines}A` : '';
            output.write(`${up}\r\x1b[0J${rows.map((r) => truncate(r, width())).join('\n')}\n`);
            lines = rows.length;
        };
        const wasRaw = input.isRaw === true;
        const finish = () => {
            input.removeListener('keypress', handler);
            input.setRawMode?.(wasRaw);
            input.pause();
            output.write('\x1b[?25h');
        };
        const handler = (str: string | undefined, key: Key = {}) => {
            if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
                draw([cancelled]);
                finish();
                reject(new PromptCancelledError());
                return;
            }
            let step: Step<T>;
            try {
                step = onKey(str, key);
            } catch (error) {
                finish();
                reject(error);
                return;
            }
            if (step) {
                draw([summary(step.done)]);
                finish();
                resolve(step.done);
            } else {
                draw(render());
            }
        };
        readline.emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
        input.setRawMode?.(true);
        input.on('keypress', handler);
        input.resume();
        output.write('\x1b[?25l');
        draw(render());
    });
}

function styleOf(io: PromptIO): Style {
    return createStyle(colorEnabled(io.output, io.env ?? process.env));
}

function printable(str: string | undefined, key: Key): str is string {
    return str !== undefined && str.length === 1 && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f';
}

/**
 * How well `choice` matches `filter`, lower is better: 0 label starts with
 * it, 1 label or value contains it, 2 only `search` does; -1 no match.
 */
export function matchRank(filter: string, choice: Choice<unknown>): number {
    if (filter === '') return 0;
    const f = filter.toLowerCase();
    const label = choice.label.toLowerCase();
    if (label.startsWith(f)) return 0;
    if (label.includes(f) || String(choice.value).toLowerCase().includes(f)) return 1;
    if (choice.search?.toLowerCase().includes(f)) return 2;
    return -1;
}

/** A scrolling, filterable list shared by select and multiselect. */
class ListState<T> {
    filter = '';
    cursor = 0;
    offset = 0;

    constructor(
        readonly choices: Choice<T>[],
        readonly pageSize: number,
        start: number,
    ) {
        this.cursor = Math.max(0, start);
        this.scroll();
    }

    /** The choices matching the filter, best matches first (stable within a rank). */
    get visible(): Choice<T>[] {
        if (!this.filter) return this.choices;
        return this.choices
            .map((choice) => ({ choice, rank: matchRank(this.filter, choice) }))
            .filter((m) => m.rank >= 0)
            .sort((a, b) => a.rank - b.rank)
            .map((m) => m.choice);
    }

    get current(): Choice<T> | undefined {
        return this.visible[this.cursor];
    }

    /** Handles movement and filtering; true when the key was used. */
    key(str: string | undefined, key: Key, typing: boolean): boolean {
        const count = this.visible.length;
        if (key.name === 'up') this.cursor = count ? (this.cursor - 1 + count) % count : 0;
        else if (key.name === 'down' || (key.name === 'tab' && !key.shift)) this.cursor = count ? (this.cursor + 1) % count : 0;
        else if (key.name === 'home') this.cursor = 0;
        else if (key.name === 'end') this.cursor = Math.max(0, count - 1);
        else if (key.name === 'pageup') this.cursor = Math.max(0, this.cursor - this.pageSize);
        else if (key.name === 'pagedown') this.cursor = Math.min(Math.max(0, count - 1), this.cursor + this.pageSize);
        else if (key.name === 'backspace' && this.filter) this.setFilter(this.filter.slice(0, -1));
        else if (typing && printable(str, key)) this.setFilter(this.filter + str);
        else return false;
        this.scroll();
        return true;
    }

    private setFilter(filter: string): void {
        this.filter = filter;
        this.cursor = 0;
        this.offset = 0;
    }

    private scroll(): void {
        if (this.cursor < this.offset) this.offset = this.cursor;
        if (this.cursor >= this.offset + this.pageSize) this.offset = this.cursor - this.pageSize + 1;
    }

    rows(s: Style, mark: (choice: Choice<T>, current: boolean) => string): string[] {
        const visible = this.visible;
        if (!visible.length) return [s.dim(`  no match for "${this.filter}"`)];
        const page = visible.slice(this.offset, this.offset + this.pageSize);
        const rows = page.map((choice, i) => {
            const current = this.offset + i === this.cursor;
            const pointer = current ? s.cyan('❯') : ' ';
            const why = typeof choice.disabled === 'string' ? ` (${choice.disabled})` : '';
            const label = choice.disabled ? s.dim(`${choice.label}${why}`) : current ? s.cyan(choice.label) : choice.label;
            const hint = choice.hint ? `  ${s.dim(choice.hint)}` : '';
            return `${pointer} ${mark(choice, current)}${label}${hint}`;
        });
        const above = this.offset;
        const below = visible.length - this.offset - page.length;
        if (above > 0) rows.unshift(s.dim(`  ↑ ${above} more`));
        if (below > 0) rows.push(s.dim(`  ↓ ${below} more`));
        return rows;
    }
}

function header(s: Style, message: string, extra: string): string {
    return `${s.cyan('?')} ${s.bold(message)} ${extra}`;
}

function done(s: Style, message: string, answer: string): string {
    return `${s.green('✔')} ${s.bold(message)} ${answer}`;
}

function cancelLine(s: Style, message: string): string {
    return `${s.red('✖')} ${s.bold(message)} ${s.dim('cancelled')}`;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

/** One of `choices`, picked with the arrow keys and Enter. */
export async function select<T>(options: SelectOptions<T>, io: PromptIO = defaultIO()): Promise<T> {
    if (!options.choices.length) throw new Error(`select "${options.message}": no choices`);
    if (!isInteractive(io)) throw new NotInteractiveError(options.message, options.flag);
    const s = styleOf(io);
    const start = options.default === undefined ? 0 : options.choices.findIndex((c) => c.value === options.default);
    const list = new ListState(options.choices, options.pageSize ?? 10, start);
    return run<Choice<T>>(
        io,
        () => [header(s, options.message, list.filter ? s.cyan(list.filter) : s.dim('↑/↓ move · enter pick · type to filter')), ...list.rows(s, () => '')],
        (str, key) => {
            if (key.name === 'return' || key.name === 'enter') {
                const choice = list.current;
                return choice && !choice.disabled ? { done: choice } : undefined;
            }
            list.key(str, key, true);
            return undefined;
        },
        (choice) => done(s, options.message, s.cyan(choice.label)),
        cancelLine(s, options.message),
    ).then((choice) => choice.value);
}

/** Any of `choices`: space toggles, Enter confirms. Returns values in the choices' order. */
export async function multiselect<T>(options: MultiselectOptions<T>, io: PromptIO = defaultIO()): Promise<T[]> {
    if (!options.choices.length) throw new Error(`multiselect "${options.message}": no choices`);
    if (!isInteractive(io)) throw new NotInteractiveError(options.message, options.flag);
    const s = styleOf(io);
    const required = options.required ?? true;
    const picked = new Set<T>(options.defaults ?? []);
    const list = new ListState(options.choices, options.pageSize ?? 10, 0);
    let error = '';
    return run<T[]>(
        io,
        () => [
            header(s, options.message, list.filter ? s.cyan(list.filter) : s.dim('space select · enter confirm · type to filter')),
            ...list.rows(s, (choice) => (picked.has(choice.value) ? s.green('◉ ') : s.dim('◯ '))),
            ...(error ? [s.red(`  ✖ ${error}`)] : []),
        ],
        (str, key) => {
            error = '';
            if (key.name === 'return' || key.name === 'enter') {
                const values = options.choices.filter((c) => picked.has(c.value)).map((c) => c.value);
                if (required && !values.length) {
                    error = 'Pick at least one (space selects).';
                    return undefined;
                }
                return { done: values };
            }
            if (key.name === 'space') {
                const choice = list.current;
                if (choice && !choice.disabled) {
                    if (picked.has(choice.value)) picked.delete(choice.value);
                    else picked.add(choice.value);
                }
                return undefined;
            }
            list.key(str, key, true);
            return undefined;
        },
        (values) => {
            const labels = options.choices.filter((c) => values.includes(c.value)).map((c) => c.label);
            return done(s, options.message, labels.length ? s.cyan(labels.join(', ')) : s.dim('none'));
        },
        cancelLine(s, options.message),
    );
}

/** Yes or no: y, n, or Enter for the default. */
export async function confirm(options: ConfirmOptions, io: PromptIO = defaultIO()): Promise<boolean> {
    if (!isInteractive(io)) throw new NotInteractiveError(options.message, options.flag);
    const s = styleOf(io);
    const fallback = options.default ?? false;
    return run<boolean>(
        io,
        () => [header(s, options.message, s.dim(fallback ? '(Y/n)' : '(y/N)'))],
        (str, key) => {
            if (key.name === 'return' || key.name === 'enter') return { done: fallback };
            if (str?.toLowerCase() === 'y') return { done: true };
            if (str?.toLowerCase() === 'n') return { done: false };
            return undefined;
        },
        (value) => done(s, options.message, s.cyan(value ? 'Yes' : 'No')),
        cancelLine(s, options.message),
    );
}

/** Free text, checked by `validate` on Enter. */
export async function text(options: TextOptions, io: PromptIO = defaultIO()): Promise<string> {
    if (!isInteractive(io)) throw new NotInteractiveError(options.message, options.flag);
    const s = styleOf(io);
    let value = '';
    let error = '';
    return run<string>(
        io,
        () => {
            const shown = value ? s.cyan(value) : s.dim(options.placeholder ?? '');
            const fallback = options.default !== undefined && !value ? s.dim(` (${options.default})`) : '';
            return [`${header(s, options.message, '›')} ${shown}${s.cyan('▌')}${fallback}`, ...(error ? [s.red(`  ✖ ${error}`)] : [])];
        },
        (str, key) => {
            if (key.name === 'return' || key.name === 'enter') {
                const answer = value === '' && options.default !== undefined ? options.default : value;
                const problem = options.validate?.(answer);
                if (problem) {
                    error = problem;
                    return undefined;
                }
                return { done: answer };
            }
            error = '';
            if (key.name === 'backspace') value = value.slice(0, -1);
            else if (key.ctrl && key.name === 'u') value = '';
            else if (printable(str, key)) value += str;
            return undefined;
        },
        (answer) => done(s, options.message, answer ? s.cyan(answer) : s.dim('(empty)')),
        cancelLine(s, options.message),
    );
}
