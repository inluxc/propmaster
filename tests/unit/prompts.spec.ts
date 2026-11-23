/**
 * Unit tests for the CLI's interactive prompts, colours and banner. Keys are
 * written to a fake terminal (a PassThrough that says it's a TTY), the same
 * bytes a real terminal sends.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
    NotInteractiveError,
    PromptCancelledError,
    confirm,
    isInteractive,
    matchRank,
    multiselect,
    select,
    text,
    truncate,
    type PromptIO,
} from '../../src/cli/prompts';
import { colorEnabled, createStyle, stripAnsi } from '../../src/cli/style';
import { banner, logoLines, packageVersion, shouldShowBanner } from '../../src/cli/banner';
import { main } from '../../src/cli/init';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', space: ' ', backspace: '\x7f', escape: '\x1b', ctrlC: '\x03' };

class FakeInput extends PassThrough {
    isTTY = true;
    isRaw = false;
    setRawMode(mode: boolean) {
        this.isRaw = mode;
        return this;
    }
}

function terminal(env: NodeJS.ProcessEnv = {}) {
    const input = new FakeInput();
    const output = { isTTY: true, columns: 80, written: '', write(chunk: string) { this.written += chunk; } };
    const io: PromptIO = { input, output, env };
    /** Sends keys one at a time, each after the prompt has drawn. */
    const press = async (...keys: string[]) => {
        for (const key of keys) {
            await new Promise((r) => setImmediate(r));
            input.write(key);
        }
    };
    /** What the screen ends with: the last frame drawn, without colours. */
    const lastFrame = () => stripAnsi(output.written.split('\x1b[0J').at(-1) ?? '').trim();
    return { io, input, output, press, lastFrame };
}

const fruits = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana', search: 'yellow' },
    { value: 'cherry', label: 'Cherry', disabled: 'out of season' },
    { value: 'grape', label: 'Grape' },
];

test.describe('select', () => {
    test('arrow keys move, Enter picks, and the prompt becomes a one-line summary', async () => {
        const t = terminal();
        const answer = select({ message: 'Fruit', choices: fruits, flag: '--fruit' }, t.io);
        await t.press(KEY.down, KEY.enter);
        expect(await answer).toBe('banana');
        expect(t.lastFrame()).toBe('✔ Fruit Banana');
        expect(t.input.isRaw).toBe(false);
        expect(t.output.written.endsWith('\x1b[?25h')).toBe(true);
    });

    test("starts on the default, wraps around, and won't pick a disabled choice", async () => {
        const t = terminal();
        const answer = select({ message: 'Fruit', choices: fruits, default: 'apple', flag: '--fruit' }, t.io);
        await t.press(KEY.up, KEY.up, KEY.enter); // apple → grape → cherry (disabled): Enter does nothing
        await t.press(KEY.up, KEY.enter); // → banana
        expect(await answer).toBe('banana');
    });

    test('typing filters: label prefix first, then label or value, then the search text; Backspace widens again', async () => {
        const t = terminal();
        const answer = select({ message: 'Fruit', choices: fruits, flag: '--fruit' }, t.io);
        await t.press('a');
        expect(t.lastFrame()).toContain('❯ Apple'); // starts with "a"; Banana and Grape contain it
        await t.press('p', 'p');
        expect(t.lastFrame().split('\n')).toHaveLength(2);
        await t.press(KEY.backspace, KEY.backspace, KEY.backspace, 'y', 'e', 'l');
        expect(t.lastFrame()).toContain('❯ Banana');
        await t.press('x');
        expect(t.lastFrame()).toContain('no match for "yelx"');
        await t.press(KEY.backspace, KEY.enter);
        expect(await answer).toBe('banana');
    });

    test('long lists scroll and say how many rows are hidden', async () => {
        const t = terminal();
        const choices = Array.from({ length: 30 }, (_, i) => ({ value: i, label: `item ${i}` }));
        const answer = select({ message: 'Item', choices, pageSize: 5, flag: '--item' }, t.io);
        await t.press(KEY.up);
        expect(t.lastFrame()).toContain('↑ 25 more');
        expect(t.lastFrame()).toContain('❯ item 29');
        await t.press(KEY.enter);
        expect(await answer).toBe(29);
    });

    test('matchRank orders matches', () => {
        expect(matchRank('', fruits[0])).toBe(0);
        expect(matchRank('ap', fruits[0])).toBe(0);
        expect(matchRank('nan', fruits[1])).toBe(1);
        expect(matchRank('yell', fruits[1])).toBe(2);
        expect(matchRank('zz', fruits[1])).toBe(-1);
    });
});

test.describe('multiselect', () => {
    test('space toggles, defaults start selected, values come back in the choices\' order', async () => {
        const t = terminal();
        const answer = multiselect({ message: 'Fruits', choices: fruits, defaults: ['grape'], flag: '--fruit' }, t.io);
        await t.press(KEY.space, KEY.down, KEY.space, KEY.down, KEY.space, KEY.enter); // apple, banana; cherry is disabled
        expect(await answer).toEqual(['apple', 'banana', 'grape']);
        expect(t.lastFrame()).toBe('✔ Fruits Apple, Banana, Grape');
    });

    test('Enter with nothing picked asks again when an answer is required, and is fine when it isn\'t', async () => {
        const t = terminal();
        const answer = multiselect({ message: 'Fruits', choices: fruits, flag: '--fruit' }, t.io);
        await t.press(KEY.enter);
        expect(t.lastFrame()).toContain('✖ Pick at least one');
        await t.press(KEY.space, KEY.space, KEY.down, KEY.space, KEY.enter);
        expect(await answer).toEqual(['banana']);

        const optional = terminal();
        const none = multiselect({ message: 'Fruits', choices: fruits, required: false, flag: '--fruit' }, optional.io);
        await optional.press(KEY.enter);
        expect(await none).toEqual([]);
        expect(optional.lastFrame()).toBe('✔ Fruits none');
    });
});

test.describe('confirm and text', () => {
    test('confirm: y, n, and Enter for the default', async () => {
        for (const [keys, fallback, expected] of [[['y'], false, true], [['N'], true, false], [[KEY.enter], true, true], [[KEY.enter], undefined, false]] as const) {
            const t = terminal();
            const answer = confirm({ message: 'Production?', default: fallback, flag: '--prod' }, t.io);
            await t.press(...keys);
            expect(await answer).toBe(expected);
        }
    });

    test('text: typing and Backspace, the default for an empty answer, and validation that asks again', async () => {
        const t = terminal();
        const answer = text({ message: 'Name', flag: '--name', validate: (v) => (/^[a-z]+$/.test(v) ? undefined : 'lowercase letters only') }, t.io);
        await t.press('s', 't', 'g', '1', KEY.enter);
        expect(t.lastFrame()).toContain('✖ lowercase letters only');
        await t.press(KEY.backspace, KEY.enter);
        expect(await answer).toBe('stg');

        const withDefault = terminal();
        const fallback = text({ message: 'Name', default: 'dev', flag: '--name' }, withDefault.io);
        expect(withDefault.lastFrame()).toContain('(dev)');
        await withDefault.press(KEY.enter);
        expect(await fallback).toBe('dev');
    });
});

test.describe('no one to answer, and cancelling', () => {
    test('without a terminal, or in CI, every prompt throws NotInteractiveError naming the flag', async () => {
        const piped: PromptIO = { input: new PassThrough(), output: { write: () => true }, env: {} };
        expect(isInteractive(piped)).toBe(false);
        expect(isInteractive(terminal({ CI: 'true' }).io)).toBe(false);
        expect(isInteractive(terminal({ CI: 'false' }).io)).toBe(true);

        const error = await select({ message: 'Client', choices: fruits, flag: '--client <name>' }, piped).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotInteractiveError);
        expect((error as Error).message).toBe('Client: no terminal to ask in. Pass --client <name>.');
        await expect(multiselect({ message: 'm', choices: fruits, flag: '--x' }, terminal({ CI: '1' }).io)).rejects.toBeInstanceOf(NotInteractiveError);
        await expect(confirm({ message: 'c', flag: '--yes' }, piped)).rejects.toBeInstanceOf(NotInteractiveError);
        await expect(text({ message: 't', flag: '--name' }, piped)).rejects.toBeInstanceOf(NotInteractiveError);
    });

    test('Escape and Ctrl+C reject with PromptCancelledError and give the terminal back', async () => {
        for (const key of [KEY.escape, KEY.ctrlC]) {
            const t = terminal();
            const answer = select({ message: 'Fruit', choices: fruits, flag: '--fruit' }, t.io);
            await t.press(key);
            await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
            expect(t.lastFrame()).toBe('✖ Fruit cancelled');
            expect(t.input.isRaw).toBe(false);
        }
    });

    test('rows wider than the terminal are cut, colours kept', () => {
        const s = createStyle(true);
        const cut = truncate(s.cyan('abcdefghij'), 6);
        expect(stripAnsi(cut)).toBe('abcde…');
        expect(cut.startsWith('\x1b[36m')).toBe(true);
        expect(truncate('short', 10)).toBe('short');
    });
});

test.describe('colours', () => {
    test('on for a terminal; NO_COLOR turns it off, FORCE_COLOR on, TERM=dumb off', () => {
        expect(colorEnabled({ isTTY: true }, {})).toBe(true);
        expect(colorEnabled({ isTTY: false }, {})).toBe(false);
        expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
        expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
        expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(true);
        expect(colorEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    });

    test('a disabled style returns text unchanged', () => {
        const s = createStyle(false);
        expect(s.gradient('propmaster')).toBe('propmaster');
        expect(s.bold('x') + s.red('y')).toBe('xy');
        expect(stripAnsi(createStyle(true).gradient('propmaster'))).toBe('propmaster');
    });
});

test.describe('banner and version', () => {
    test('the logo is three rows of the same width, and the banner adds the version and environment', () => {
        const rows = logoLines();
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => r.length)).size).toBe(1);
        const plain = banner({ version: '9.9.9', environment: 'stg', style: createStyle(false) });
        expect(plain).toContain(rows[0]);
        expect(plain).toContain('v9.9.9 · environment: stg');
        expect(banner({ version: '1.0.0', style: createStyle(false) })).not.toContain('environment');
    });

    test('shown only on a terminal, outside CI, and not with --json or --quiet', () => {
        expect(shouldShowBanner(['init'], { isTTY: true }, {})).toBe(true);
        expect(shouldShowBanner(['init'], { isTTY: false }, {})).toBe(false);
        expect(shouldShowBanner(['init'], { isTTY: true }, { CI: 'true' })).toBe(false);
        expect(shouldShowBanner(['init'], { isTTY: true }, { PROPMASTER_NO_BANNER: '1' })).toBe(false);
        for (const flag of ['--json', '--quiet', '-q']) expect(shouldShowBanner(['organize', flag], { isTTY: true }, {})).toBe(false);
    });

    test('the version is the package\'s, and --version / -v print only that', async () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
        expect(packageVersion()).toBe(pkg.version);
        const lines: unknown[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => void lines.push(args.join(' '));
        try {
            expect(await main(['--version'])).toBe(0);
            expect(await main(['-v'])).toBe(0);
        } finally {
            console.log = log;
        }
        expect(lines).toEqual([pkg.version, pkg.version]);
    });

    test('next-id with no category and no terminal prints the usage and exits 2, as before', async () => {
        const errors: unknown[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => void errors.push(args.join(' '));
        try {
            expect(await main(['next-id'])).toBe(2);
        } finally {
            console.error = error;
        }
        expect(String(errors[0])).toContain('Usage: propmaster next-id <CATEGORY>');
    });
});
