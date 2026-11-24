/**
 * Edits JSON text in place: adds or removes one object member and leaves
 * every other byte as it was (formatting, key order, inline arrays). Adding a
 * member and removing it again gives back the original text.
 *
 * `{ jsonc: true }` also accepts comments and trailing commas, as editors'
 * settings files (Zed's, VS Code's) have them; they're kept as they are.
 */

export interface JsonEditOptions {
    /** Accept `//` and `/* *\/` comments and trailing commas. */
    jsonc?: boolean;
}

interface Span {
    start: number;
    end: number;
}

export interface JsonObjectNode extends Span {
    kind: 'object';
    members: JsonMember[];
}

interface JsonOtherNode extends Span {
    kind: 'array' | 'value';
}

export type JsonNode = JsonObjectNode | JsonOtherNode;

export interface JsonMember {
    key: string;
    keyStart: number;
    value: JsonNode;
}

/** Parses `text` into nodes that know where they are. Throws on invalid JSON. */
export function parseJsonSpans(text: string, options: JsonEditOptions = {}): JsonNode {
    const jsonc = options.jsonc === true;
    let i = 0;
    const fail = (what: string): never => {
        const line = text.slice(0, i).split('\n').length;
        throw new SyntaxError(`invalid JSON at line ${line}: ${what}`);
    };
    const ws = () => {
        for (;;) {
            while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
            if (!jsonc || text[i] !== '/') return;
            if (text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') i++;
            } else if (text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                if (end === -1) fail('unterminated comment');
                i = end + 2;
            } else {
                return;
            }
        }
    };
    const str = (): string => {
        const start = i;
        i++; // opening quote
        while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        if (i >= text.length) fail('unterminated string');
        i++;
        return JSON.parse(text.slice(start, i)) as string;
    };
    const value = (): JsonNode => {
        ws();
        const start = i;
        const c = text[i];
        if (c === '{') {
            i++;
            const members: JsonMember[] = [];
            ws();
            if (text[i] === '}') {
                i++;
                return { kind: 'object', start, end: i, members };
            }
            for (;;) {
                ws();
                if (jsonc && text[i] === '}' && members.length) {
                    i++;
                    return { kind: 'object', start, end: i, members };
                }
                if (text[i] !== '"') fail('expected a key');
                const keyStart = i;
                const key = str();
                ws();
                if (text[i] !== ':') fail('expected ":"');
                i++;
                members.push({ key, keyStart, value: value() });
                ws();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                if (text[i] === '}') {
                    i++;
                    return { kind: 'object', start, end: i, members };
                }
                fail('expected "," or "}"');
            }
        }
        if (c === '[') {
            i++;
            ws();
            if (text[i] === ']') {
                i++;
                return { kind: 'array', start, end: i };
            }
            for (;;) {
                ws();
                if (jsonc && text[i] === ']') {
                    i++;
                    return { kind: 'array', start, end: i };
                }
                value();
                ws();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                if (text[i] === ']') {
                    i++;
                    return { kind: 'array', start, end: i };
                }
                fail('expected "," or "]"');
            }
        }
        if (c === '"') {
            str();
            return { kind: 'value', start, end: i };
        }
        const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
        if (!m) fail(`unexpected ${c === undefined ? 'end of file' : `"${c}"`}`);
        i += m![0].length;
        return { kind: 'value', start, end: i };
    };
    const root = value();
    ws();
    if (i < text.length) fail('text after the end');
    return root;
}

/** The object at `path` (keys from the root), or undefined when missing or not an object. */
export function objectAt(root: JsonNode, path: readonly string[]): JsonObjectNode | undefined {
    let node: JsonNode | undefined = root;
    for (const key of path) {
        if (node?.kind !== 'object') return undefined;
        node = node.members.find((m) => m.key === key)?.value;
    }
    return node?.kind === 'object' ? node : undefined;
}

/** The indent unit of `text`: the first indented line's leading whitespace (default four spaces). */
export function indentUnit(text: string): string {
    const m = /\n([ \t]+)\S/.exec(text);
    return m ? m[1] : '    ';
}

function lineIndent(text: string, pos: number): string {
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** `value` as JSON at `indent`: objects one member per line, arrays of plain values on one line. */
export function formatJson(value: unknown, indent: string, unit: string): string {
    if (Array.isArray(value)) {
        if (value.every((v) => v === null || typeof v !== 'object')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
        return `[\n${value.map((v) => `${indent}${unit}${formatJson(v, indent + unit, unit)}`).join(',\n')}\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (!entries.length) return '{}';
        return `{\n${entries.map(([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${formatJson(v, indent + unit, unit)}`).join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
}

/**
 * Adds `key: value` as the last member of the object at `path`. Returns the
 * new text, or the same text when the key is already there.
 */
export function addMember(text: string, path: readonly string[], key: string, value: unknown, options: JsonEditOptions = {}): string {
    const obj = objectAt(parseJsonSpans(text, options), path);
    if (!obj) throw new Error(`no object at ${path.join('.') || '(root)'}`);
    if (obj.members.some((m) => m.key === key)) return text;
    const unit = indentUnit(text);
    if (!obj.members.length) {
        const outer = lineIndent(text, obj.start);
        const inner = outer + unit;
        return `${text.slice(0, obj.start)}{\n${inner}${JSON.stringify(key)}: ${formatJson(value, inner, unit)}\n${outer}}${text.slice(obj.end)}`;
    }
    const last = obj.members[obj.members.length - 1];
    const inner = lineIndent(text, obj.members[0].keyStart);
    return `${text.slice(0, last.value.end)},\n${inner}${JSON.stringify(key)}: ${formatJson(value, inner, unit)}${text.slice(last.value.end)}`;
}

/** Removes the member `key` from the object at `path`. Returns the same text when it isn't there. */
export function removeMember(text: string, path: readonly string[], key: string, options: JsonEditOptions = {}): string {
    const obj = objectAt(parseJsonSpans(text, options), path);
    const index = obj?.members.findIndex((m) => m.key === key) ?? -1;
    if (!obj || index === -1) return text;
    const member = obj.members[index];
    if (obj.members.length === 1) {
        // The only member: what add() turned `{}` into goes back to `{}`.
        return `${text.slice(0, obj.start)}{}${text.slice(obj.end)}`;
    }
    if (index > 0) return text.slice(0, obj.members[index - 1].value.end) + text.slice(member.value.end);
    return text.slice(0, member.keyStart) + text.slice(obj.members[1].keyStart);
}

/** The parsed value at `path`, or undefined. */
export function valueAt(text: string, path: readonly string[]): unknown {
    let value: unknown = JSON.parse(text);
    for (const key of path) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

/**
 * Sets `key` in the object at `path` to `value`: added as the last member,
 * or its value replaced in place when it's there. Objects missing on the way
 * to `path` are added. Returns the same text when it already has that value.
 */
export function setMember(text: string, path: readonly string[], key: string, value: unknown, options: JsonEditOptions = {}): string {
    for (let depth = 0; depth < path.length; depth++) {
        if (!objectAt(parseJsonSpans(text, options), path.slice(0, depth + 1))) text = addMember(text, path.slice(0, depth), path[depth], {}, options);
    }
    const obj = objectAt(parseJsonSpans(text, options), path)!;
    const member = obj.members.find((m) => m.key === key);
    if (!member) return addMember(text, path, key, value, options);
    if (sameJson(memberValue(text, member), value)) return text;
    const unit = indentUnit(text);
    return `${text.slice(0, member.value.start)}${formatJson(value, lineIndent(text, member.keyStart), unit)}${text.slice(member.value.end)}`;
}

/** The parsed value of a member, or undefined when it can't be parsed as plain JSON (it has comments). */
export function memberValue(text: string, member: JsonMember): unknown {
    try {
        return JSON.parse(text.slice(member.value.start, member.value.end));
    } catch {
        return undefined;
    }
}

/** Whether two JSON values are equal, ignoring key order. */
export function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
    }
    return false;
}
