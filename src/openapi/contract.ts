/**
 * Contract checks: validate API requests and responses against the OpenAPI spec.
 *
 *   const contract = await ContractValidator.create(api.document);
 *   const result = contract.checkResponse({ method: 'get', url: '/pet/1', status: 200, headers, data });
 *   result.violations  // [{ path: '$.id', message: 'must be integer', expected: 'integer', actual: 'abc' }]
 *
 * Works with Swagger 2.0, OpenAPI 3.0 and 3.1 documents. Each schema is
 * compiled once (Ajv) and `$ref`s resolve against the original document, so
 * recursive schemas are fine. Ajv and ajv-formats are optional peer
 * dependencies, loaded the first time a check runs.
 */

import { ContractError, type ContractViolation } from '../errors.js';
import { loadOptional } from '../fixtures/optional-package.js';

export type { ContractViolation } from '../errors.js';

/** `true`: a mismatch fails the call. `'warn'`: it's recorded on the test and the call goes on. */
export type ContractMode = boolean | 'warn';

/** An operation in the spec, as the validator sees it. */
export interface ContractOperation {
    operationId?: string;
    method: string;
    /** The path template from the spec, e.g. `/pet/{petId}`. */
    path: string;
}

export interface ContractResult {
    kind: 'request' | 'response';
    /** The operation the message was checked against; absent when no operation matched. */
    operation?: ContractOperation;
    status?: number;
    contentType?: string;
    /** Empty when the message matches the spec. */
    violations: ContractViolation[];
    /** Why nothing was checked (no matching operation, no schema, a non-JSON body). */
    skipped?: string;
}

/** What a response check needs: an Axios response has all of it (`checkAxiosResponse`). */
export interface ResponseInput {
    method: string;
    url: string;
    status: number;
    headers?: Record<string, unknown> | { get?: (name: string) => unknown };
    data: unknown;
    /** Check against this operation instead of matching `method` + `url`. */
    operationId?: string;
}

export interface RequestInput {
    method: string;
    url: string;
    contentType?: string;
    data: unknown;
    operationId?: string;
}

type Json = Record<string, any>;

interface IndexedOperation extends ContractOperation {
    /** JSON pointer to the operation object in the document. */
    pointer: string;
    /** The whole pathname is this template. */
    exact: RegExp;
    /** The pathname ends with this template (a server base path in front). */
    suffix: RegExp;
    params: number;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const SPEC_ID = 'openapi-spec';

/** Escapes one JSON pointer segment (`/` → `~1`, `~` → `~0`). */
function segment(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function get(doc: Json, pointer: string): any {
    if (!pointer) return doc;
    return pointer
        .slice(1)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<any>((node, key) => (node == null ? undefined : node[key]), doc);
}

/** Follows local `$ref`s (`#/components/responses/NotFound`) to the object and its pointer. */
function deref(doc: Json, pointer: string): { node: any; pointer: string } {
    let node = get(doc, pointer);
    for (let hops = 0; node && typeof node.$ref === 'string' && node.$ref.startsWith('#') && hops < 20; hops++) {
        pointer = node.$ref.slice(1);
        node = get(doc, pointer);
    }
    return { node, pointer };
}

function mediaType(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    return value.split(';')[0].trim().toLowerCase();
}

function isJson(type: string | undefined): boolean {
    return !!type && (type === 'application/json' || type.endsWith('+json') || type.includes('/json'));
}

function header(headers: ResponseInput['headers'], name: string): unknown {
    if (!headers) return undefined;
    if (typeof (headers as { get?: unknown }).get === 'function') {
        const v = (headers as { get: (n: string) => unknown }).get(name);
        if (v !== undefined && v !== null) return v;
    }
    const h = headers as Record<string, unknown>;
    const key = Object.keys(h).find((k) => k.toLowerCase() === name);
    return key ? h[key] : undefined;
}

/** `/tags/0/name` → `$.tags[0].name`. */
export function jsonPath(instancePath: string): string {
    if (!instancePath) return '$';
    return '$' + instancePath
        .slice(1)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .map((s) => (/^\d+$/.test(s) ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`))
        .join('');
}

/** Turns Ajv errors into violations with a JSON path and the expected/actual value. */
export function toViolations(errors: any[] | null | undefined, data: unknown): ContractViolation[] {
    const out: ContractViolation[] = [];
    const seen = new Set<string>();
    for (const e of errors ?? []) {
        const base = jsonPath(e.instancePath ?? '');
        let v: ContractViolation;
        switch (e.keyword) {
            case 'required':
                v = { path: base === '$' ? `$.${e.params.missingProperty}` : `${base}.${e.params.missingProperty}`, message: 'is required' };
                break;
            case 'additionalProperties': {
                const prop = e.params.additionalProperty;
                const path = `${base}${/^[A-Za-z_$][\w$]*$/.test(prop) ? `.${prop}` : `[${JSON.stringify(prop)}]`}`;
                v = { path, message: "isn't in the schema (additionalProperties: false)", actual: get(data as Json, `${e.instancePath}/${segment(prop)}`) };
                break;
            }
            case 'type': {
                const type = Array.isArray(e.params.type) ? e.params.type.join(' or ') : String(e.params.type).split(',').join(' or ');
                v = { path: base, message: `must be ${type}`, expected: type, actual: get(data as Json, e.instancePath) };
                break;
            }
                break;
            case 'enum':
                v = { path: base, message: 'must be one of the allowed values', expected: e.params.allowedValues, actual: get(data as Json, e.instancePath) };
                break;
            case 'const':
                v = { path: base, message: 'must be the constant value', expected: e.params.allowedValue, actual: get(data as Json, e.instancePath) };
                break;
            default:
                v = { path: base, message: e.message ?? e.keyword, actual: get(data as Json, e.instancePath) };
        }
        const key = `${v.path}|${v.message}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(v);
        }
    }
    return out;
}

/**
 * Rewrites the OpenAPI 3.0 / Swagger 2.0 schema dialect into what Ajv
 * (JSON Schema draft-07) understands, in a copy of the document:
 * boolean `exclusiveMinimum`/`exclusiveMaximum`, `nullable` and
 * `x-nullable`, and the OpenAPI-only formats.
 */
export function normalizeDocument(doc: Json): Json {
    const copy = structuredClone(doc);
    const legacy = !String(copy.openapi ?? '').startsWith('3.1');
    if (!legacy) return copy;
    const visit = (node: any): void => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (!node || typeof node !== 'object') return;
        for (const [bound, limit] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
            if (typeof node[bound] === 'boolean') {
                if (node[bound] && typeof node[limit] === 'number') {
                    node[bound] = node[limit];
                    delete node[limit];
                } else {
                    delete node[bound];
                }
            }
        }
        if (node['x-nullable'] === true) node.nullable = true;
        if (node.nullable === true) {
            if (typeof node.type === 'string') node.type = [node.type, 'null'];
            if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum = [...node.enum, null];
            delete node.nullable;
        }
        if (node.type === 'file') delete node.type; // Swagger 2.0 file responses: not checkable
        Object.values(node).forEach(visit);
    };
    visit(copy);
    return copy;
}

const OPENAPI_FORMATS: Record<string, any> = {
    // Integer-ness is the `type: integer` check's job; the formats only bound the range.
    int32: { type: 'number', validate: (n: number) => n >= -(2 ** 31) && n < 2 ** 31 },
    int64: { type: 'number', validate: () => true },
    float: { type: 'number', validate: () => true },
    double: { type: 'number', validate: () => true },
    byte: { type: 'string', validate: /^[A-Za-z0-9+/]*={0,2}$/ },
    binary: true,
    password: true,
};

type AjvModule = { default?: any };

function ctor(mod: AjvModule | any): any {
    return mod?.default?.default ?? mod?.default ?? mod;
}

/** Loads Ajv (2020-12 build for OpenAPI 3.1) and ajv-formats as optional peers. */
async function loadAjv(version31: boolean): Promise<{ Ajv: any; addFormats: (ajv: any) => void }> {
    const install = ['ajv', 'ajv-formats'];
    const mod = await loadOptional<AjvModule>(version31 ? 'ajv/dist/2020.js' : 'ajv', 'openApiClient (contract checks)', install);
    const formats = await loadOptional<AjvModule>('ajv-formats', 'openApiClient (contract checks)', install);
    return { Ajv: ctor(mod), addFormats: ctor(formats) };
}

/**
 * Checks requests and responses against an OpenAPI document. Build it with
 * `ContractValidator.create(document)`; use the unparsed document
 * (`api.document`), not a dereferenced one.
 */
export class ContractValidator {
    private readonly operations: IndexedOperation[];
    private readonly compiled = new Map<string, any>();
    private readonly swagger2: boolean;

    private constructor(private readonly doc: Json, private readonly ajv: any) {
        this.swagger2 = String(doc.swagger ?? '').startsWith('2');
        this.operations = ContractValidator.index(doc);
    }

    static async create(document: unknown): Promise<ContractValidator> {
        if (!document || typeof document !== 'object') {
            throw new TypeError('ContractValidator needs a parsed OpenAPI document');
        }
        const doc = normalizeDocument(document as Json);
        const { Ajv, addFormats } = await loadAjv(String(doc.openapi ?? '').startsWith('3.1'));
        const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, logger: false });
        addFormats(ajv);
        for (const [name, format] of Object.entries(OPENAPI_FORMATS)) ajv.addFormat(name, format);
        const { $id: _ignored, ...withoutId } = doc;
        ajv.addSchema(withoutId, SPEC_ID);
        return new ContractValidator(doc, ajv);
    }

    private static index(doc: Json): IndexedOperation[] {
        const out: IndexedOperation[] = [];
        for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
            for (const method of HTTP_METHODS) {
                const op = item?.[method];
                if (!op || typeof op !== 'object') continue;
                const params = (path.match(/\{[^}]+\}/g) ?? []).length;
                const pattern = (path.startsWith('/') ? path : `/${path}`)
                    .replace(/\/$/, '')
                    .split(/\{[^}]+\}/)
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('[^/]+');
                out.push({
                    operationId: op.operationId,
                    method,
                    path,
                    pointer: `/paths/${segment(path)}/${method}`,
                    exact: new RegExp(`^${pattern}/?$`),
                    suffix: new RegExp(`${pattern}/?$`),
                    params,
                });
            }
        }
        // Literal segments win over templates: /pet/findByStatus before /pet/{petId}.
        return out.sort((a, b) => a.params - b.params);
    }

    /** Every operation in the spec. */
    get allOperations(): ContractOperation[] {
        return this.operations.map(({ operationId, method, path }) => ({ operationId, method, path }));
    }

    /** The operation for a method and URL (absolute, or relative to the API base URL), if the spec has one. */
    findOperation(method: string, url: string, baseURL?: string): ContractOperation | undefined {
        return this.find(method, url, baseURL);
    }

    private find(method: string, url: string, baseURL?: string, operationId?: string): IndexedOperation | undefined {
        if (operationId) return this.operations.find((o) => o.operationId === operationId);
        const m = method.toLowerCase();
        let pathname = new URL(url, 'http://relative.invalid').pathname;
        if (baseURL && /^https?:\/\//i.test(url)) {
            const basePath = new URL(baseURL).pathname.replace(/\/$/, '');
            if (basePath && pathname.startsWith(basePath)) pathname = pathname.slice(basePath.length) || '/';
        }
        const candidates = this.operations.filter((o) => o.method === m);
        // An exact match first, then one where the spec path is a suffix (a server base path in front).
        return candidates.find((o) => o.exact.test(pathname)) ?? candidates.find((o) => o.path !== '/' && o.suffix.test(pathname));
    }

    private validator(pointer: string): any {
        let fn = this.compiled.get(pointer);
        if (!fn) {
            fn = this.ajv.compile({ $ref: `${SPEC_ID}#${pointer}` });
            this.compiled.set(pointer, fn);
        }
        return fn;
    }

    private validate(pointer: string, data: unknown): ContractViolation[] {
        const fn = this.validator(pointer);
        return fn(data) ? [] : toViolations(fn.errors, data);
    }

    /** Checks a response's status, content type and body against the spec. */
    checkResponse(input: ResponseInput, baseURL?: string): ContractResult {
        const op = this.find(input.method, input.url, baseURL, input.operationId);
        const contentType = mediaType(header(input.headers, 'content-type'));
        const result: ContractResult = { kind: 'response', status: input.status, contentType, violations: [] };
        if (!op) {
            result.skipped = input.operationId
                ? `no operation "${input.operationId}" in the spec`
                : `no operation in the spec matches ${input.method.toUpperCase()} ${input.url}`;
            return result;
        }
        result.operation = { operationId: op.operationId, method: op.method, path: op.path };

        const responsesPointer = `${op.pointer}/responses`;
        const responses: Json = get(this.doc, responsesPointer) ?? {};
        const code = String(input.status);
        const range = `${code[0]}XX`;
        const key = [code, range, range.toLowerCase(), 'default'].find((k) => k in responses);
        if (!key) {
            const documented = Object.keys(responses).join(', ') || 'none';
            result.violations.push({ path: '$', message: `status ${input.status} isn't documented for this operation`, expected: documented, actual: input.status });
            return result;
        }
        const { node: response, pointer } = deref(this.doc, `${responsesPointer}/${segment(key)}`);
        const empty = input.data === undefined || input.data === null || input.data === '';

        if (this.swagger2) {
            if (!response?.schema) return { ...result, skipped: `status ${key} has no schema` };
            if (typeof input.data === 'string' && !isJson(contentType)) return { ...result, skipped: `${contentType ?? 'untyped'} body isn't JSON` };
            result.violations = this.validate(`${pointer}/schema`, input.data);
            return result;
        }

        const content: Json | undefined = response?.content;
        if (!content || !Object.keys(content).length) {
            if (!empty) result.skipped = `status ${key} documents no body`;
            return result;
        }
        const media = this.pickMedia(content, contentType);
        if (!media) {
            if (empty) return result;
            result.violations.push({ path: '$', message: "content type isn't documented for this status", expected: Object.keys(content).join(', '), actual: contentType ?? null });
            return result;
        }
        if (!content[media]?.schema) return { ...result, skipped: `${media} has no schema` };
        if (!isJson(media) && !isJson(contentType) && typeof input.data === 'string') {
            return { ...result, skipped: `${media} body isn't JSON` };
        }
        result.violations = this.validate(`${pointer}/content/${segment(media)}/schema`, input.data);
        return result;
    }

    /** Checks a request body against the operation's request body schema. */
    checkRequest(input: RequestInput, baseURL?: string): ContractResult {
        const op = this.find(input.method, input.url, baseURL, input.operationId);
        const contentType = mediaType(input.contentType) ?? 'application/json';
        const result: ContractResult = { kind: 'request', contentType, violations: [] };
        if (!op) {
            result.skipped = `no operation in the spec matches ${input.method.toUpperCase()} ${input.url}`;
            return result;
        }
        result.operation = { operationId: op.operationId, method: op.method, path: op.path };
        const body = typeof input.data === 'string' && isJson(contentType) ? safeParse(input.data) : input.data;
        const absent = body === undefined || body === null || body === '';

        if (this.swagger2) {
            const params: Json[] = [
                ...(get(this.doc, `${op.pointer}/parameters`) ?? []).map((_: unknown, i: number) => `${op.pointer}/parameters/${i}`),
                ...(get(this.doc, `${op.pointer.replace(/\/[^/]+$/, '')}/parameters`) ?? []).map((_: unknown, i: number) => `${op.pointer.replace(/\/[^/]+$/, '')}/parameters/${i}`),
            ].map((p: string) => deref(this.doc, p));
            const param = params.find((p) => p.node?.in === 'body');
            if (!param) return { ...result, skipped: 'operation takes no body' };
            if (absent) {
                if (param.node.required) result.violations.push({ path: '$', message: 'request body is required' });
                return result;
            }
            result.violations = this.validate(`${param.pointer}/schema`, body);
            return result;
        }

        const { node: requestBody, pointer } = deref(this.doc, `${op.pointer}/requestBody`);
        if (!requestBody) return { ...result, skipped: 'operation takes no body' };
        if (absent) {
            if (requestBody.required) result.violations.push({ path: '$', message: 'request body is required' });
            return result;
        }
        const content: Json = requestBody.content ?? {};
        const media = this.pickMedia(content, contentType);
        if (!media) {
            result.violations.push({ path: '$', message: "content type isn't accepted by this operation", expected: Object.keys(content).join(', '), actual: contentType });
            return result;
        }
        if (!content[media]?.schema) return { ...result, skipped: `${media} has no schema` };
        if (!isJson(media) && typeof body !== 'object') return { ...result, skipped: `${media} body isn't JSON` };
        result.violations = this.validate(`${pointer}/content/${segment(media)}/schema`, body);
        return result;
    }

    /** The documented media type for `contentType`: exact, then `type/*`, then any; the JSON one when the response has no content type. */
    private pickMedia(content: Json, contentType: string | undefined): string | undefined {
        const keys = Object.keys(content);
        const lower = new Map(keys.map((k) => [mediaType(k)!, k]));
        if (!contentType) return keys.find((k) => isJson(mediaType(k))) ?? (keys.length === 1 ? keys[0] : undefined);
        return lower.get(contentType) ?? lower.get(`${contentType.split('/')[0]}/*`) ?? lower.get('*/*');
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** Throws a ContractError when `result` has violations. */
export function assertContract(result: ContractResult, cause?: Error): void {
    if (!result.violations.length) return;
    const op = result.operation ?? { method: '?', path: '?' };
    throw new ContractError(result.kind, op, result.violations, result.status, result.contentType, cause ? { cause } : undefined);
}

/** Parses `true` / `false` / `warn` (from an env var). */
export function parseContractMode(value: string | undefined): ContractMode | undefined {
    if (value === undefined) return undefined;
    const v = value.trim().toLowerCase();
    if (v === 'warn') return 'warn';
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off', ''].includes(v)) return false;
    return undefined;
}
