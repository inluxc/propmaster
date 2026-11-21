/**
 * Generates Propmaster API test files from an OpenAPI document (2.0, 3.0, 3.1):
 * one spec file per tag, one test per operation and documented status code,
 * following the conventions `propmaster check` enforces (TestCaseID in title
 * and tag, `test.step()` bodies, framework imports).
 *
 * Pure: takes the document and the IDs already in use, returns file contents.
 * The CLI (`propmaster generate openapi`) does the I/O.
 *
 * Which tests run and which are `test.fixme`:
 *   - 2xx: a valid request built from the schema examples.
 *   - 400 / 422 with a JSON body that has required fields: the body is sent
 *     without them.
 *   - 404 with path parameters: the path parameters get values that don't exist.
 *   - Anything else (401, 403, 409, 5xx, ...): `test.fixme` with a TODO, since
 *     only the API's own data can provoke it.
 *   - With `prism: true`, every status runs: the request carries
 *     `Prefer: code=<status>`, which a Prism mock answers with that response.
 *   - `default` responses get no test.
 */

import type { OpenApiDocument } from './load.js';

export interface GenerateOptions {
    /** Only operations with one of these tags. */
    tags?: string[];
    /** Only these operationIds. */
    operations?: string[];
    /** TestCaseID category (default API). */
    category?: string;
    /** Allocates `count` fresh TestCaseIDs, in order. */
    allocateIds: (count: number) => string[];
    /** Module the tests import `test` and `expect` from (default '@inluxc/propmaster'). */
    importFrom?: string;
    /** Every status runs, through Prism's `Prefer: code=<status>` header. */
    prism?: boolean;
    /** Add a step that checks the response against the spec (needs ajv). Default true. */
    contract?: boolean;
    /** `"<operationId> <status>"` pairs that already have a test. */
    existing?: Set<string>;
    /** File names already taken in the output directory. */
    takenFiles?: Set<string>;
}

export type TestKind = 'success' | 'invalid-body' | 'not-found' | 'mock' | 'fixme';

export interface GeneratedTest {
    id: string;
    operationId: string;
    method: string;
    path: string;
    status: string;
    kind: TestKind;
}

export interface GeneratedFile {
    /** File name, e.g. `pet.spec.ts`. */
    fileName: string;
    tag: string;
    tests: GeneratedTest[];
    content: string;
}

export interface SkippedItem {
    operation: string;
    reason: string;
}

export interface GenerateResult {
    files: GeneratedFile[];
    skipped: SkippedItem[];
    /** `"<operationId> <status>"` pairs left out because a test already exists. */
    alreadyCovered: string[];
}

// ─── Spec traversal ─────────────────────────────────────────────────────────

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function resolvePointer(doc: OpenApiDocument, ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let node: unknown = doc;
    for (const raw of ref.slice(2).split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isObj(node) && !Array.isArray(node)) return undefined;
        node = (node as Obj)[key];
    }
    return node;
}

/** Follows `$ref`s (local only) until a non-reference object. */
function deref(doc: OpenApiDocument, value: unknown, depth = 0): Obj | undefined {
    if (!isObj(value)) return undefined;
    if (typeof value.$ref === 'string' && depth < 20) return deref(doc, resolvePointer(doc, value.$ref), depth + 1);
    return value;
}

interface Param {
    name: string;
    in: string;
    required: boolean;
    schema?: Obj;
    example?: unknown;
}

interface Body {
    contentType: string;
    schema?: Obj;
    example?: unknown;
    json: boolean;
}

interface Operation {
    operationId?: string;
    method: string;
    path: string;
    summary?: string;
    tags: string[];
    params: Param[];
    body?: Body;
    bodyRequired: boolean;
    /** status → JSON schema of the response (undefined when it has none). */
    responses: Map<string, Obj | undefined>;
    formData: boolean;
    /** Security schemes of the first requirement that needs any (empty when none). */
    security: SecurityScheme[];
}

interface SecurityScheme {
    name: string;
    type: string;
    in?: string;
    paramName?: string;
    scheme?: string;
}

const isJson = (contentType: string) => /^application\/(.+\+)?json\b/i.test(contentType) || contentType === '*/*';

function readOperations(doc: OpenApiDocument): Operation[] {
    const swagger2 = typeof doc.swagger === 'string';
    const consumesTop = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : undefined;
    const out: Operation[] = [];
    for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
        const item = deref(doc, rawItem);
        if (!item) continue;
        for (const method of METHODS) {
            const op = deref(doc, item[method]);
            if (!op) continue;

            // Operation parameters override path-level ones with the same name and location.
            const byKey = new Map<string, Obj>();
            for (const list of [item.parameters, op.parameters]) {
                if (!Array.isArray(list)) continue;
                for (const p of list) {
                    const param = deref(doc, p);
                    if (param && typeof param.name === 'string') byKey.set(`${param.in}:${param.name}`, param);
                }
            }
            const rawParams = [...byKey.values()];

            const params: Param[] = rawParams
                .filter((p) => ['path', 'query', 'header'].includes(String(p.in)))
                .map((p) => ({
                    name: String(p.name),
                    in: String(p.in),
                    required: p.in === 'path' || p.required === true,
                    // Swagger 2 puts the type on the parameter itself.
                    schema: deref(doc, p.schema) ?? (swagger2 ? p : undefined),
                    example: p.example ?? (isObj(p.examples) ? firstExample(doc, p.examples) : undefined) ?? p['x-example'],
                }));

            let body: Body | undefined;
            let bodyRequired = false;
            if (swagger2) {
                const bodyParam = rawParams.find((p) => p.in === 'body');
                if (bodyParam) {
                    const consumes = (Array.isArray(op.consumes) ? (op.consumes as string[]) : consumesTop) ?? ['application/json'];
                    const contentType = consumes.find(isJson) ?? consumes[0] ?? 'application/json';
                    body = { contentType, schema: deref(doc, bodyParam.schema), json: isJson(contentType), example: bodyParam['x-example'] };
                    bodyRequired = bodyParam.required === true;
                }
            } else {
                const requestBody = deref(doc, op.requestBody);
                const content = requestBody && isObj(requestBody.content) ? requestBody.content : undefined;
                if (content) {
                    const types = Object.keys(content);
                    const contentType = types.find(isJson) ?? types[0];
                    if (contentType) {
                        const media = deref(doc, content[contentType]) ?? {};
                        body = {
                            contentType,
                            schema: deref(doc, media.schema) ? (media.schema as Obj) : undefined,
                            json: isJson(contentType),
                            example: media.example ?? (isObj(media.examples) ? firstExample(doc, media.examples) : undefined),
                        };
                        bodyRequired = requestBody?.required === true;
                    }
                }
            }

            const responses = new Map<string, Obj | undefined>();
            for (const [status, rawResponse] of Object.entries(isObj(op.responses) ? op.responses : {})) {
                const response = deref(doc, rawResponse);
                let schema: Obj | undefined;
                if (swagger2) {
                    schema = isObj(response?.schema) ? (response!.schema as Obj) : undefined;
                } else if (response && isObj(response.content)) {
                    const type = Object.keys(response.content).find(isJson);
                    const media = type ? deref(doc, response.content[type]) : undefined;
                    schema = isObj(media?.schema) ? (media!.schema as Obj) : undefined;
                }
                responses.set(status, schema);
            }

            out.push({
                operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
                method: method.toUpperCase(),
                path,
                summary: typeof op.summary === 'string' ? op.summary : undefined,
                tags: Array.isArray(op.tags) && op.tags.length > 0 ? op.tags.map(String) : ['default'],
                params,
                body,
                bodyRequired,
                responses,
                formData: rawParams.some((p) => p.in === 'formData'),
                security: securityFor(doc, Array.isArray(op.security) ? op.security : doc.security),
            });
        }
    }
    return out;
}

function securityFor(doc: OpenApiDocument, requirements: unknown): SecurityScheme[] {
    if (!Array.isArray(requirements) || requirements.length === 0) return [];
    // An empty requirement ({}) makes credentials optional.
    if (requirements.some((r) => isObj(r) && Object.keys(r).length === 0)) return [];
    const first = requirements.find(isObj);
    if (!first) return [];
    const components = isObj(doc.components) ? doc.components : {};
    const defs = (isObj(components.securitySchemes) ? components.securitySchemes : isObj(doc.securityDefinitions) ? doc.securityDefinitions : {}) as Obj;
    return Object.keys(first).map((name) => {
        const def = deref(doc, defs[name]) ?? {};
        return {
            name,
            type: String(def.type ?? 'unknown'),
            in: typeof def.in === 'string' ? def.in : undefined,
            paramName: typeof def.name === 'string' ? def.name : undefined,
            scheme: typeof def.scheme === 'string' ? def.scheme.toLowerCase() : undefined,
        };
    });
}

/** Placeholder credentials for a Prism mock, which only checks they're present. */
function mockCredentials(schemes: SecurityScheme[]): { headers: Obj; query: Obj } {
    const headers: Obj = {};
    const query: Obj = {};
    for (const s of schemes) {
        if (s.type === 'apiKey' && s.paramName) {
            if (s.in === 'query') query[s.paramName] = 'example-api-key';
            else if (s.in === 'header') headers[s.paramName] = 'example-api-key';
        } else if ((s.type === 'http' || s.type === 'basic') && (s.scheme === 'basic' || s.type === 'basic')) {
            headers.Authorization = 'Basic ZXhhbXBsZTpleGFtcGxl';
        } else if (s.type === 'http' || s.type === 'oauth2' || s.type === 'openIdConnect') {
            headers.Authorization = 'Bearer example-token';
        }
    }
    return { headers, query };
}

function firstExample(doc: OpenApiDocument, examples: Obj): unknown {
    const first = Object.values(examples)[0];
    const ex = deref(doc, first);
    return ex && 'value' in ex ? ex.value : undefined;
}

// ─── Example values ─────────────────────────────────────────────────────────

const MAX_DEPTH = 5;

/**
 * Builds an example value for a schema: its own `example` / `examples` /
 * `default` / `const` / first `enum` value when it has one, else a value of the
 * right type and format. `readOnly` properties are left out (it's a request).
 * Returns `undefined` for a recursive reference it has already expanded.
 */
export function exampleFor(doc: OpenApiDocument, schema: unknown, key = '', depth = 0, seen: ReadonlySet<string> = new Set()): unknown {
    if (!isObj(schema)) return undefined;
    if (typeof schema.$ref === 'string') {
        if (seen.has(schema.$ref) || depth > MAX_DEPTH) return undefined;
        return exampleFor(doc, resolvePointer(doc, schema.$ref), key, depth, new Set([...seen, schema.$ref]));
    }
    if ('example' in schema && schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
    if ('default' in schema && schema.default !== undefined) return schema.default;
    if ('const' in schema) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.find((v) => v !== null) ?? schema.enum[0];

    if (Array.isArray(schema.allOf)) {
        const merged: Obj = {};
        for (const part of schema.allOf) {
            const value = exampleFor(doc, part, key, depth, seen);
            if (isObj(value)) Object.assign(merged, value);
            else if (value !== undefined && schema.allOf.length === 1) return value;
        }
        return merged;
    }
    for (const alt of ['oneOf', 'anyOf'] as const) {
        const options = schema[alt];
        if (Array.isArray(options)) {
            for (const option of options) {
                const value = exampleFor(doc, option, key, depth, seen);
                if (value !== undefined) return value;
            }
        }
    }

    const declared = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    const type = declared ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
    switch (type) {
        case 'string':
            return exampleString(schema, key);
        case 'integer': {
            const min = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : undefined;
            return min !== undefined ? Math.ceil(min) : 1;
        }
        case 'number':
            return typeof schema.minimum === 'number' ? schema.minimum : 1.5;
        case 'boolean':
            return true;
        case 'array': {
            if (depth >= MAX_DEPTH) return [];
            const item = exampleFor(doc, schema.items, key, depth + 1, seen);
            return item === undefined ? [] : [item];
        }
        case 'object':
        case undefined: {
            if (type === undefined && !isObj(schema.properties)) return undefined;
            const out: Obj = {};
            if (depth >= MAX_DEPTH) return out;
            const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
            for (const [name, prop] of Object.entries(isObj(schema.properties) ? schema.properties : {})) {
                const resolved = deref(doc, prop);
                if (resolved?.readOnly === true) continue;
                // Optional properties only near the top, to keep bodies readable.
                if (!required.has(name) && depth >= 2) continue;
                const value = exampleFor(doc, prop, name, depth + 1, seen);
                if (value !== undefined) out[name] = value;
            }
            return out;
        }
        default:
            return undefined;
    }
}

function exampleString(schema: Obj, key: string): string {
    const byFormat: Record<string, string> = {
        'date-time': '2024-01-15T10:30:00Z',
        date: '2024-01-15',
        time: '10:30:00',
        email: 'user@example.test',
        uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        uri: 'https://example.test',
        url: 'https://example.test',
        hostname: 'example.test',
        ipv4: '192.0.2.10',
        ipv6: '2001:db8::10',
        byte: 'ZXhhbXBsZQ==',
        password: 'example-password',
    };
    const format = typeof schema.format === 'string' ? schema.format : '';
    let value = byFormat[format] ?? (key ? `example ${key}` : 'example');
    const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
    const max = typeof schema.maxLength === 'number' ? schema.maxLength : Infinity;
    while (value.length < min) value += 'x';
    if (value.length > max) value = value.slice(0, Math.max(max, min));
    return value;
}

/**
 * A path parameter value that shouldn't match anything, for a 404 test, or
 * undefined when the schema leaves no value that's both valid and unlikely to
 * exist (a small `maximum`, an enum).
 */
function missingValue(param: Param): string | number | undefined {
    const schema = param.schema ?? {};
    if (Array.isArray(schema.enum)) return undefined;
    const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
    if (type === 'integer' || type === 'number') {
        const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
        if (max !== undefined && max < 1_000_000) return undefined;
        return 999999999;
    }
    if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
    if (typeof schema.maxLength === 'number' && schema.maxLength < 'does-not-exist'.length) return undefined;
    if (typeof schema.pattern === 'string') return undefined;
    return 'does-not-exist';
}

function paramValue(doc: OpenApiDocument, param: Param): unknown {
    const value = param.example ?? exampleFor(doc, param.schema, param.name) ?? (param.in === 'path' ? 1 : 'example');
    // Axios would send a one-item array as `name[]=value`; a single value works
    // for csv and multi (repeated) query arrays alike.
    if (Array.isArray(value) && param.in !== 'body') return value.length > 0 ? value[0] : 'example';
    return value;
}

// ─── Planning ───────────────────────────────────────────────────────────────

interface PlannedTest {
    op: Operation & { operationId: string };
    status: string;
    kind: TestKind;
}

function kindFor(doc: OpenApiDocument, op: Operation, status: string, prism: boolean): TestKind | undefined {
    if (status === 'default') return undefined;
    if (/^2(\d\d|XX)$/i.test(status)) return 'success';
    if (prism && /^\d{3}$/.test(status)) return 'mock';
    if ((status === '400' || status === '422') && op.body?.json && hasRequiredFields(doc, op.body.schema)) return 'invalid-body';
    const pathParams = op.params.filter((p) => p.in === 'path');
    if (status === '404' && pathParams.length > 0 && pathParams.every((p) => missingValue(p) !== undefined)) return 'not-found';
    return 'fixme';
}

function hasRequiredFields(doc: OpenApiDocument, schema: Obj | undefined, depth = 0): boolean {
    const s = deref(doc, schema);
    if (!s || depth > 10) return false;
    if (Array.isArray(s.required) && s.required.length > 0) return true;
    return Array.isArray(s.allOf) && s.allOf.some((part) => hasRequiredFields(doc, part as Obj, depth + 1));
}

/** 2XX sorts as 200, default last. */
function statusOrder(status: string): number {
    if (status === 'default') return 1000;
    const n = Number(status.replace(/X/gi, '0'));
    return Number.isNaN(n) ? 999 : n;
}

/** File name for a tag: lower-case, dashes. */
export function tagFileName(tag: string): string {
    const slug = tag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug || 'default';
}

function freeFileName(base: string, taken: Set<string>): string {
    let name = `${base}.spec.ts`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}.spec.ts`;
    taken.add(name);
    return name;
}

export function generateApiTests(doc: OpenApiDocument, options: GenerateOptions): GenerateResult {
    const prism = options.prism ?? false;
    const existing = options.existing ?? new Set<string>();
    const tagFilter = options.tags?.map((t) => t.toLowerCase());
    const opFilter = options.operations;
    const skipped: SkippedItem[] = [];
    const alreadyCovered: string[] = [];
    const byTag = new Map<string, PlannedTest[]>();

    const operations = readOperations(doc);
    if (opFilter) {
        for (const wanted of opFilter) {
            if (!operations.some((o) => o.operationId === wanted)) skipped.push({ operation: wanted, reason: 'no operation with this operationId in the spec' });
        }
    }

    for (const op of operations) {
        const label = `${op.method} ${op.path}`;
        if (tagFilter && !op.tags.some((t) => tagFilter.includes(t.toLowerCase()))) continue;
        if (opFilter && (!op.operationId || !opFilter.includes(op.operationId))) continue;
        if (!op.operationId) {
            skipped.push({ operation: label, reason: "it has no operationId, so openApiClient.client has no method for it" });
            continue;
        }
        const named = op as Operation & { operationId: string };
        if (op.responses.size === 0) {
            skipped.push({ operation: `${op.operationId} (${label})`, reason: 'it documents no responses' });
            continue;
        }
        if ([...op.responses.keys()].every((status) => status === 'default')) {
            skipped.push({ operation: `${op.operationId} (${label})`, reason: 'it only documents a default response, so there is no status to assert' });
            continue;
        }
        const statuses = [...op.responses.keys()].sort((a, b) => statusOrder(a) - statusOrder(b));
        for (const status of statuses) {
            const kind = kindFor(doc, op, status, prism);
            if (!kind) continue;
            if (existing.has(`${op.operationId} ${status}`)) {
                alreadyCovered.push(`${op.operationId} ${status}`);
                continue;
            }
            // Non-JSON bodies (multipart, form data) need hand-written requests.
            const nonJson = op.formData || (op.body !== undefined && !op.body.json);
            const tag = op.tags[0];
            const list = byTag.get(tag) ?? [];
            list.push({ op: named, status, kind: nonJson ? 'fixme' : kind });
            byTag.set(tag, list);
        }
    }

    const total = [...byTag.values()].reduce((n, list) => n + list.length, 0);
    const ids = total > 0 ? options.allocateIds(total) : [];
    let next = 0;
    const taken = new Set(options.takenFiles ?? []);
    const files: GeneratedFile[] = [];
    const info = isObj(doc.info) ? doc.info : {};
    const source = [info.title, info.version].filter(Boolean).join(' ');

    for (const [tag, planned] of byTag) {
        const tests: GeneratedTest[] = planned.map((p) => ({
            id: ids[next++],
            operationId: p.op.operationId,
            method: p.op.method,
            path: p.op.path,
            status: p.status,
            kind: p.kind,
        }));
        const fileName = freeFileName(tagFileName(tag), taken);
        files.push({
            fileName,
            tag,
            tests,
            content: renderFile(doc, tag, planned, tests, {
                importFrom: options.importFrom ?? '@inluxc/propmaster',
                contract: options.contract ?? true,
                prism,
                source,
            }),
        });
    }

    return { files, skipped, alreadyCovered };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A JSON value as an indented TypeScript literal. */
function literal(value: unknown, indent: string): string {
    const json = JSON.stringify(value, null, 4);
    return json.split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n')
        // keys that are valid identifiers don't need quotes
        .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:')
        .replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => q(JSON.parse(`"${inner}"`) as string));
}

interface RenderContext {
    importFrom: string;
    contract: boolean;
    prism: boolean;
    source: string;
}

function renderFile(doc: OpenApiDocument, tag: string, planned: PlannedTest[], tests: GeneratedTest[], ctx: RenderContext): string {
    const body = planned.map((p, i) => renderTest(doc, p, tests[i], ctx)).join('\n\n');
    return `/**
 * API tests for the "${tag.replace(/\*\//g, '*\\/')}" operations${ctx.source ? ` of ${ctx.source.replace(/\*\//g, '*\\/')}` : ''}.
 * Generated by \`propmaster generate openapi\`.
 *
 * Replace the example values with data your API has, add assertions on the
 * response bodies, and register cleanups for what the tests create
 * (testData.cleanup()). Running the generator again adds tests for new
 * operations and status codes in a new file; it never changes this one.
 */

import { test, expect } from ${q(ctx.importFrom)};

test.describe(${q(tag)}, () => {
${body}
});
`;
}

function titleFor(p: PlannedTest): string {
    const what = `${p.op.operationId}: ${p.op.method} ${p.op.path}`;
    switch (p.kind) {
        case 'invalid-body':
            return `${what} returns ${p.status} for a body without its required fields`;
        case 'not-found': {
            const names = p.op.params.filter((x) => x.in === 'path').map((x) => x.name).join(', ');
            return `${what} returns ${p.status} for an unknown ${names}`;
        }
        default:
            return `${what} returns ${p.status}`;
    }
}

function renderTest(doc: OpenApiDocument, p: PlannedTest, t: GeneratedTest, ctx: RenderContext): string {
    const { op, status, kind } = p;
    const I = '        ';
    const lines: string[] = [];

    // Parameters
    const params: Obj = {};
    for (const param of op.params) {
        if (!param.required) continue;
        if (param.in === 'header' && /^authorization$/i.test(param.name)) continue;
        params[param.name] = kind === 'not-found' && param.in === 'path' ? missingValue(param)! : paramValue(doc, param);
    }

    // Body
    let data: unknown;
    let sendsBody = false;
    if (op.body?.json) {
        sendsBody = true;
        if (kind === 'invalid-body') {
            data = {};
        } else {
            data = op.body.example ?? exampleFor(doc, op.body.schema) ?? {};
        }
    }

    // Axios request config
    const config: string[] = ['validateStatus: () => true'];
    if (kind === 'invalid-body') config.push('contract: { request: false }');
    const headers: Obj = {};
    if (ctx.prism && op.security.length > 0) {
        const creds = mockCredentials(op.security);
        Object.assign(headers, creds.headers);
        Object.assign(params, creds.query);
    }
    if (kind === 'mock') headers.Prefer = `code=${status}`;
    if (Object.keys(headers).length > 0) {
        config.push(`headers: { ${Object.entries(headers).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${q(String(v))}`).join(', ')} }`);
    }

    const paramsArg = Object.keys(params).length > 0 ? literal(params, `${I}    `) : 'null';
    const dataArg = sendsBody ? literal(data, `${I}    `) : 'undefined';
    const call = `client.${/^[A-Za-z_$][\w$]*$/.test(op.operationId) ? op.operationId : `[${q(op.operationId)}]`}`;

    const fn = kind === 'fixme' ? 'test.fixme' : 'test';
    if (!ctx.prism && op.security.length > 0) {
        const names = op.security.map((x) => `${x.name} (${x.type}${x.in ? ` in ${x.in}` : ''})`).join(', ');
        lines.push(`    // Needs credentials: ${names}. openApiClient sends the auth token when the auth helpers are configured (authRole, PW_AUTH_*).`);
    }
    if (kind === 'fixme') {
        const why = op.formData || (op.body && !op.body.json)
            ? `send a ${op.formData ? 'form-data' : op.body!.contentType} body, which needs a hand-written request`
            : `make the API answer ${status} (for example with data or credentials that cause it)`;
        lines.push(`    // TODO: ${why}, then change test.fixme to test.`);
    }
    lines.push(`    ${fn}(${q(`[${t.id}] ${titleFor(p)}`)}, {`);
    lines.push(`        tag: [${q(`@${t.id}`)}],`);
    lines.push(`        annotation: { type: 'openapi', description: ${q(`${op.operationId} ${status}`)} },`);
    lines.push(`    }, async ({ openApiClient }) => {`);
    lines.push(`${I}const client = openApiClient.client as any;`);
    lines.push(`${I}let response: any;`);
    lines.push('');
    const sendLabel = kind === 'invalid-body' ? `Send ${op.method} ${op.path} without the required body fields`
        : kind === 'not-found' ? `Send ${op.method} ${op.path} for a resource that doesn't exist`
            : `Send ${op.method} ${op.path}`;
    lines.push(`${I}await test.step(${q(`Step 1: ${sendLabel}`)}, async () => {`);
    lines.push(`${I}    response = await ${call}(${paramsArg}, ${dataArg}, { ${config.join(', ')} });`);
    lines.push(`${I}});`);
    lines.push('');
    lines.push(`${I}await test.step(${q(`Step 2: Verify the response status is ${status}`)}, async () => {`);
    if (/^\dXX$/i.test(status)) {
        const first = Number(status[0]);
        lines.push(`${I}    expect(response.status).toBeGreaterThanOrEqual(${first * 100});`);
        lines.push(`${I}    expect(response.status).toBeLessThan(${first * 100 + 100});`);
    } else {
        lines.push(`${I}    expect(response.status).toBe(${Number(status)});`);
    }
    lines.push(`${I}});`);

    if (ctx.contract && op.responses.get(status)) {
        lines.push('');
        lines.push(`${I}await test.step('Step 3: Verify the response body matches the OpenAPI spec', async () => {`);
        lines.push(`${I}    const { violations } = await openApiClient.checkResponse(response, ${q(op.operationId)});`);
        lines.push(`${I}    expect(violations).toEqual([]);`);
        lines.push(`${I}});`);
    }
    lines.push('    });');
    return lines.join('\n');
}

// ─── Existing tests ─────────────────────────────────────────────────────────

/** `"<operationId> <status>"` pairs from `annotation: { type: 'openapi', description: '...' }` in test sources. */
export function coveredOperations(sources: string[]): Set<string> {
    const out = new Set<string>();
    const re = /type:\s*['"`]openapi['"`]\s*,\s*description:\s*['"`]([^'"`\s]+)\s+([0-9A-Za-z]+)['"`]/g;
    for (const src of sources) {
        for (const m of src.matchAll(re)) out.add(`${m[1]} ${m[2]}`);
    }
    return out;
}
