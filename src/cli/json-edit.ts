/**
 * Edits JSON text in place: adds or removes one object member and leaves
 * every other byte as it was (formatting, key order, inline arrays). Adding a
 * member and removing it again gives back the original text.
 */

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
export function parseJsonSpans(text: string): JsonNode {
    let i = 0;
    const fail = (what: string): never => {
        const line = text.slice(0, i).split('\n').length;
        throw new SyntaxError(`invalid JSON at line ${line}: ${what}`);
    };
    const ws = () => {
        while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
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
export function addMember(text: string, path: readonly string[], key: string, value: unknown): string {
    const obj = objectAt(parseJsonSpans(text), path);
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
export function removeMember(text: string, path: readonly string[], key: string): string {
    const obj = objectAt(parseJsonSpans(text), path);
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
