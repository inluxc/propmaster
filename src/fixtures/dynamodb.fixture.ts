/**
 * DynamoDB fixture.
 *
 * `dynamoDbClient` reads and writes DynamoDB items as plain objects, against
 * an emulator (Moto, LocalStack, DynamoDB Local) or a real test account:
 *
 * - `put`, `get`, `update`, `delete`, `query` and `scan` take and return plain
 *   objects; conditions and filters are plain objects too
 *   (`{ status: 'open', total: { '>': 10 } }`), so no expression strings,
 *   placeholder names or `{ S: '...' }` values.
 * - What a test writes is undone afterwards: a new item is deleted, an
 *   overwritten or updated one gets its previous content back.
 * - `waitForItem()` and `waitForQuery()` poll until the application has
 *   written what the test expects, and fail with what is there instead.
 * - `createTable()` makes a table from a short definition for local runs and
 *   deletes it after the test; `tableName()` gives a per-test name.
 *
 * Uses @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb (the document
 * client), optional peer dependencies loaded on first use.
 */

import type { DynamoDBClient as SdkDynamoDbClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AwsFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { newRunId } from '../test-data/factory.js';
import { loadOptional } from './optional-package.js';
import { awsClientOptions, DEFAULT_AWS_TIMEOUT, reasonOf, resolveAwsConfig, sleep } from './aws.js';

type DynamoSdk = typeof import('@aws-sdk/client-dynamodb');
type DocSdk = typeof import('@aws-sdk/lib-dynamodb');

export const DEFAULT_DYNAMODB_TABLE_PREFIX = 'propmaster-tests-';

/** An item: a plain object. Numbers come back as JS numbers, sets as `Set`, binary as `Uint8Array`. */
export type DynamoItem = Record<string, unknown>;

/** The key of an item: its partition key, and its sort key if the table has one. */
export type DynamoKey = Record<string, unknown>;

/**
 * A comparison for one attribute. A plain value means "equals". To compare a
 * whole map that has one of these operator names as its only field, wrap it:
 * `{ '=': { between: 1 } }`.
 */
export type DynamoComparison =
    | unknown
    | { '=': unknown }
    | { '<>': unknown }
    | { '<': unknown }
    | { '<=': unknown }
    | { '>': unknown }
    | { '>=': unknown }
    | { between: [unknown, unknown] }
    | { beginsWith: string }
    | { contains: unknown }
    | { exists: boolean }
    | { in: unknown[] };

/**
 * Conditions on attributes, all of which must hold: `{ status: 'open', total: { '>': 10 } }`.
 * A dotted name is a path into a map (`'address.city'`).
 */
export type DynamoConditions = Record<string, DynamoComparison>;

/** A hand-written expression, for anything the object form can't say. */
export interface DynamoExpression {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
}

export interface DynamoPutOptions extends KeepOption {
    /** Only write when there is no item with this key yet; fails otherwise. */
    ifNotExists?: boolean;
    /** Only write when the existing item matches. */
    condition?: DynamoConditions | DynamoExpression;
}

export interface DynamoUpdateOptions extends KeepOption {
    /** Attributes to remove. */
    remove?: string[];
    /** Only update when the existing item matches (e.g. `{ version: 3 }`). */
    condition?: DynamoConditions | DynamoExpression;
}

export interface DynamoDeleteOptions {
    condition?: DynamoConditions | DynamoExpression;
}

export interface DynamoGetOptions {
    /** Strongly consistent read (default: true, so a test reads its own writes). */
    consistent?: boolean;
}

export interface DynamoQueryOptions {
    /** A global or local secondary index to query instead of the table. */
    index?: string;
    /** Conditions on non-key attributes, applied after the key condition. */
    filter?: DynamoConditions | DynamoExpression;
    /** Stop after this many items (default: every page). */
    limit?: number;
    /** Newest (highest sort key) first. */
    descending?: boolean;
    /** Strongly consistent read (default: true; ignored on a global index, which can't be read consistently). */
    consistent?: boolean;
}

export interface DynamoScanOptions {
    index?: string;
    filter?: DynamoConditions | DynamoExpression;
    limit?: number;
    /** Strongly consistent read (default: true; ignored on a global index). */
    consistent?: boolean;
}

export interface DynamoWaitOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
}

export interface DynamoWaitForItemOptions<T> extends DynamoWaitOptions {
    /** Keep waiting until the item also satisfies this (e.g. `(o) => o.status === 'shipped'`). */
    until?: (item: T) => boolean;
}

export interface DynamoWaitForQueryOptions extends DynamoWaitOptions, Omit<DynamoQueryOptions, 'limit'> {
    /** How many matching items to wait for (default: 1). */
    count?: number;
}

/** An attribute type in a table definition: string, number or binary. */
export type DynamoKeyType = 'S' | 'N' | 'B';

/** An index: its key attributes in order (partition key first, then the sort key). */
export type DynamoKeyDefinition = Record<string, DynamoKeyType>;

/**
 * A table: `{ key: { customerId: 'S', orderedAt: 'N' } }`. The first key
 * attribute is the partition key, the second (if any) the sort key. Tables are
 * on-demand (pay per request); indexes project every attribute.
 */
export interface DynamoTableDefinition {
    key: DynamoKeyDefinition;
    /** Global secondary indexes by name, e.g. `{ byStatus: { status: 'S', orderedAt: 'N' } }`. */
    indexes?: Record<string, DynamoKeyDefinition>;
    /** Local secondary indexes by name: the table's partition key plus another sort key, e.g. `{ byTotal: { customerId: 'S', total: 'N' } }`. */
    localIndexes?: Record<string, DynamoKeyDefinition>;
    /** Attribute holding an expiry time (epoch seconds) to turn on TTL. */
    ttl?: string;
    /** Turn on a stream with this view of the changed items. */
    stream?: 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES' | 'KEYS_ONLY';
}

/** The key attributes of a table, as DynamoDB reports them. */
export interface DynamoTableKey {
    partitionKey: string;
    sortKey?: string;
}

export interface DynamoDbClient {
    /** This test's table-name prefix, e.g. `propmaster-tests-t0-9f2a1c0b-`. */
    readonly tablePrefix: string;
    /** `tablePrefix + name`: a table name of this test's own, for `createTable()`. */
    tableName(name: string): string;
    /** Writes an item (replacing one with the same key). Undone after the test unless `{ keep: true }`. */
    put(table: string, item: DynamoItem, options?: DynamoPutOptions): Promise<void>;
    /** Writes several items; each is undone like `put()`. */
    putMany(table: string, items: DynamoItem[], options?: KeepOption): Promise<void>;
    /** Reads an item by its key, or null when there is none. */
    get<T extends DynamoItem = DynamoItem>(table: string, key: DynamoKey, options?: DynamoGetOptions): Promise<T | null>;
    /**
     * Sets attributes of an item (creating it if it's missing) and returns the
     * item after the change. `changes` is `{ status: 'shipped' }` or an
     * expression. Undone after the test unless `{ keep: true }`.
     */
    update<T extends DynamoItem = DynamoItem>(table: string, key: DynamoKey, changes: DynamoItem | DynamoExpression, options?: DynamoUpdateOptions): Promise<T>;
    /** Deletes an item and returns it, or null when there was none (not undone). */
    delete<T extends DynamoItem = DynamoItem>(table: string, key: DynamoKey, options?: DynamoDeleteOptions): Promise<T | null>;
    /**
     * Items whose key matches, in sort-key order: `{ customerId: 'c-1' }`, or
     * with a sort-key condition `{ customerId: 'c-1', orderedAt: { '>=': 1700000000 } }`.
     */
    query<T extends DynamoItem = DynamoItem>(table: string, keyCondition: DynamoConditions | DynamoExpression, options?: DynamoQueryOptions): Promise<T[]>;
    /** Every item in the table (or index), optionally filtered. Reads the whole table: fine for a test table, slow for a big one. */
    scan<T extends DynamoItem = DynamoItem>(table: string, options?: DynamoScanOptions): Promise<T[]>;
    /** Number of items matching a key condition. */
    count(table: string, keyCondition: DynamoConditions | DynamoExpression, options?: Omit<DynamoQueryOptions, 'limit' | 'descending'>): Promise<number>;
    /** Polls until the item exists (and passes `until`). Throws on timeout with what was there. */
    waitForItem<T extends DynamoItem = DynamoItem>(table: string, key: DynamoKey, options?: DynamoWaitForItemOptions<T>): Promise<T>;
    /** Polls a query until it returns at least `count` items (default 1), then returns them. */
    waitForQuery<T extends DynamoItem = DynamoItem>(table: string, keyCondition: DynamoConditions | DynamoExpression, options?: DynamoWaitForQueryOptions): Promise<T[]>;
    /** Creates a table and waits until it and its indexes are active. Deleted after the test unless `{ keep: true }` or it already existed. */
    createTable(table: string, definition: DynamoTableDefinition, options?: KeepOption): Promise<void>;
    /** Deletes a table (not undone). */
    deleteTable(table: string): Promise<void>;
    /** True when the table exists. */
    tableExists(table: string): Promise<boolean>;
    /** The table's key attributes. */
    tableKey(table: string): Promise<DynamoTableKey>;
    /** The low-level AWS SDK client, for anything else. */
    readonly sdk: SdkDynamoDbClient;
    /** The document client (plain objects in and out), for anything else. */
    readonly documentClient: DynamoDBDocumentClient;
    close(): void;
}

export interface CreateDynamoDbClientOptions {
    /** Undo stack for writes and tables; without one nothing is cleaned up. */
    registry?: CleanupRegistry;
    /** Run ID in the per-test table prefix (default: a new one). */
    runId?: string;
}

const OPERATORS = new Set(['=', '<>', '<', '<=', '>', '>=', 'between', 'beginsWith', 'contains', 'exists', 'in']);

/** True for `{ '>': 3 }` and the like: an object whose only field is an operator. */
function operatorOf(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Set || value instanceof Uint8Array) return undefined;
    const keys = Object.keys(value);
    return keys.length === 1 && OPERATORS.has(keys[0]) ? keys[0] : undefined;
}

const isExpression = (value: unknown): value is DynamoExpression =>
    value !== null && typeof value === 'object' && typeof (value as DynamoExpression).expression === 'string'
    && Object.keys(value).every((k) => k === 'expression' || k === 'names' || k === 'values');

/**
 * Builds expression strings with `#n0`/`:v0` placeholders. One builder per
 * request, so the key condition, filter and condition never reuse a name.
 */
export class ExpressionBuilder {
    readonly names: Record<string, string> = {};
    readonly values: Record<string, unknown> = {};
    private readonly nameIds = new Map<string, string>();
    private valueCount = 0;

    /** `#n0` for `status`, `#n1.#n2` for `address.city`. */
    path(attribute: string): string {
        return attribute.split('.').map((part) => {
            let id = this.nameIds.get(part);
            if (!id) {
                id = `#n${this.nameIds.size}`;
                this.nameIds.set(part, id);
                this.names[id] = part;
            }
            return id;
        }).join('.');
    }

    value(v: unknown): string {
        const id = `:v${this.valueCount++}`;
        this.values[id] = v;
        return id;
    }

    /** One `AND`-joined condition from an object, or a hand-written expression with its names and values merged in. */
    conditions(conditions: DynamoConditions | DynamoExpression): string {
        if (isExpression(conditions)) {
            for (const [k, v] of Object.entries(conditions.names ?? {})) {
                if (k in this.names && this.names[k] !== v) throw new Error(`expression name ${k} is used twice with different attributes`);
                this.names[k] = v;
            }
            for (const [k, v] of Object.entries(conditions.values ?? {})) this.values[k] = v;
            return conditions.expression;
        }
        const parts = Object.entries(conditions).map(([attribute, comparison]) => this.comparison(attribute, comparison));
        if (parts.length === 0) throw new Error('empty condition: give at least one attribute');
        return parts.join(' AND ');
    }

    private comparison(attribute: string, comparison: unknown): string {
        const path = this.path(attribute);
        const op = operatorOf(comparison);
        if (!op) return `${path} = ${this.value(comparison)}`;
        const operand = (comparison as Record<string, unknown>)[op];
        switch (op) {
            case 'between': {
                if (!Array.isArray(operand) || operand.length !== 2) throw new Error(`${attribute}: between takes [low, high]`);
                return `${path} BETWEEN ${this.value(operand[0])} AND ${this.value(operand[1])}`;
            }
            case 'beginsWith':
                return `begins_with(${path}, ${this.value(operand)})`;
            case 'contains':
                return `contains(${path}, ${this.value(operand)})`;
            case 'exists':
                return operand ? `attribute_exists(${path})` : `attribute_not_exists(${path})`;
            case 'in': {
                if (!Array.isArray(operand) || operand.length === 0) throw new Error(`${attribute}: in takes a non-empty array`);
                return `${path} IN (${operand.map((v) => this.value(v)).join(', ')})`;
            }
            default:
                return `${path} ${op} ${this.value(operand)}`;
        }
    }

    /** `SET #n0 = :v0, ... REMOVE #n1` for an update. */
    update(changes: DynamoItem | DynamoExpression, remove: string[] = [], key: DynamoKey = {}): string {
        if (isExpression(changes)) {
            if (remove.length) throw new Error('remove goes in the expression when changes is an expression');
            return this.conditions(changes);
        }
        const sets = Object.entries(changes)
            .filter(([attribute, value]) => value !== undefined && !(attribute in key))
            .map(([attribute, value]) => `${this.path(attribute)} = ${this.value(value)}`);
        const removes = remove.map((attribute) => this.path(attribute));
        if (sets.length === 0 && removes.length === 0) throw new Error('nothing to change: give at least one attribute (key attributes can\'t be changed)');
        return [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ');
    }

    /** An expression with its placeholders filled in, for messages: `status = "open" AND total > 10`. */
    readable(expression: string): string {
        return expression
            .replace(/#[A-Za-z0-9_]+/g, (id) => this.names[id] ?? id)
            .replace(/:[A-Za-z0-9_]+/g, (id) => (id in this.values ? preview(this.values[id], 60) : id));
    }

    /** The names and values, or undefined when empty (DynamoDB rejects empty maps). */
    get expressionAttributes(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
        return {
            ...(Object.keys(this.names).length ? { ExpressionAttributeNames: this.names } : {}),
            ...(Object.keys(this.values).length ? { ExpressionAttributeValues: this.values } : {}),
        };
    }
}

/** The `CreateTable` input for a definition. */
export function createTableInput(table: string, definition: DynamoTableDefinition): Record<string, unknown> {
    const attributes = new Map<string, DynamoKeyType>();
    const keySchema = (key: DynamoKeyDefinition, what: string) => {
        const entries = Object.entries(key);
        if (entries.length < 1 || entries.length > 2) throw new Error(`${what} needs a partition key and at most one sort key, e.g. { customerId: 'S', orderedAt: 'N' }`);
        return entries.map(([name, type], i) => {
            if (type !== 'S' && type !== 'N' && type !== 'B') throw new Error(`${what}: ${name} has type ${String(type)}; use 'S', 'N' or 'B'`);
            const known = attributes.get(name);
            if (known && known !== type) throw new Error(`${name} is ${known} in one key and ${type} in another`);
            attributes.set(name, type);
            return { AttributeName: name, KeyType: i === 0 ? 'HASH' : 'RANGE' };
        });
    };
    const tableKey = keySchema(definition.key, 'key');
    const index = (name: string, key: DynamoKeyDefinition, what: string) => ({ IndexName: name, KeySchema: keySchema(key, `${what} ${name}`), Projection: { ProjectionType: 'ALL' } });
    const globals = Object.entries(definition.indexes ?? {}).map(([name, key]) => index(name, key, 'index'));
    const locals = Object.entries(definition.localIndexes ?? {}).map(([name, key]) => {
        const built = index(name, key, 'local index');
        if (built.KeySchema[0].AttributeName !== tableKey[0].AttributeName || built.KeySchema.length !== 2) {
            throw new Error(`local index ${name} needs the table's partition key (${tableKey[0].AttributeName}) and a sort key`);
        }
        return built;
    });
    return {
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: tableKey,
        AttributeDefinitions: [...attributes].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
        ...(globals.length ? { GlobalSecondaryIndexes: globals } : {}),
        ...(locals.length ? { LocalSecondaryIndexes: locals } : {}),
        ...(definition.stream ? { StreamSpecification: { StreamEnabled: true, StreamViewType: definition.stream } } : {}),
    };
}

/** The key attributes of an item, or an error naming the ones it lacks. */
export function keyOf(item: DynamoItem, key: DynamoTableKey, table: string): DynamoKey {
    const names = [key.partitionKey, ...(key.sortKey ? [key.sortKey] : [])];
    const missing = names.filter((n) => item[n] === undefined || item[n] === null);
    if (missing.length) throw new Error(`the item has no ${missing.join(' or ')}, the key of ${table} (${names.join(', ')})`);
    return Object.fromEntries(names.map((n) => [n, item[n]]));
}

/** Short JSON for error messages. */
export function preview(value: unknown, max = 300): string {
    const text = JSON.stringify(value, (_k, v: unknown) => (v instanceof Set ? [...v] : typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

const errorName = (error: unknown): string => (error as { name?: string } | null)?.name ?? '';
const isTableMissing = (error: unknown) => errorName(error) === 'ResourceNotFoundException';
const isConditionFailed = (error: unknown) => errorName(error) === 'ConditionalCheckFailedException';

/** Builds the client. */
export async function createDynamoDbClient(config: AwsFixtureConfig, options: CreateDynamoDbClientOptions = {}): Promise<DynamoDbClient> {
    const { registry } = options;
    const sdkOptions = awsClientOptions(config);
    const dynamo = await loadOptional<DynamoSdk>('@aws-sdk/client-dynamodb', 'dynamoDbClient');
    const doc = await loadOptional<DocSdk>('@aws-sdk/lib-dynamodb', 'dynamoDbClient');
    const { forcePathStyle: _unused, ...clientOptions } = sdkOptions;
    const sdk = new dynamo.DynamoDBClient(clientOptions);
    const documentClient = doc.DynamoDBDocumentClient.from(sdk, { marshallOptions: { removeUndefinedValues: true } });
    const tablePrefix = `${config.dynamodb?.tablePrefix ?? DEFAULT_DYNAMODB_TABLE_PREFIX}${options.runId ?? newRunId()}-`;
    const timeoutDefault = config.timeout ?? DEFAULT_AWS_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;
    const keys = new Map<string, Promise<DynamoTableKey>>();
    // Tables this client created: dropped whole after the test, so their items need no undo.
    const ownTables = new Set<string>();

    const fail = (operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        let reason = reasonOf(error);
        if (isTableMissing(error) && details.table) {
            reason = `table ${String(details.table)} doesn't exist in ${sdkOptions.region}${sdkOptions.endpoint ? ` at ${sdkOptions.endpoint}` : ''} (${reason})`;
        } else if (isConditionFailed(error)) {
            reason = `ConditionalCheckFailedException: the condition didn't hold for the item ${details.condition ? 'already there' : 'in the table'}`;
        }
        throw new FixtureOperationError('dynamodb', operation, { ...details, reason }, error instanceof Error ? error : undefined);
    };

    const describe = async (table: string) => (await sdk.send(new dynamo.DescribeTableCommand({ TableName: table }))).Table;

    const tableKey = (table: string): Promise<DynamoTableKey> => {
        let known = keys.get(table);
        if (!known) {
            known = describe(table).then((t) => {
                const schema = t?.KeySchema ?? [];
                const partitionKey = schema.find((k) => k.KeyType === 'HASH')?.AttributeName;
                if (!partitionKey) throw new Error(`DynamoDB returned no key schema for ${table}`);
                const sortKey = schema.find((k) => k.KeyType === 'RANGE')?.AttributeName;
                return { partitionKey, ...(sortKey ? { sortKey } : {}) };
            });
            known.catch(() => keys.delete(table));
            keys.set(table, known);
        }
        return known;
    };

    const rawGet = async (table: string, key: DynamoKey, consistent = true): Promise<DynamoItem | null> =>
        ((await documentClient.send(new doc.GetCommand({ TableName: table, Key: key, ConsistentRead: consistent }))).Item as DynamoItem | undefined) ?? null;

    /** Records how to put an item's key back the way it is now. */
    const recordUndo = async (table: string, key: DynamoKey) => {
        const previous = await rawGet(table, key);
        registry!.add(`dynamodb ${previous ? 'restore ' : ''}${table} ${preview(key, 120)}`, async () => {
            try {
                if (previous) await documentClient.send(new doc.PutCommand({ TableName: table, Item: previous }));
                else await documentClient.send(new doc.DeleteCommand({ TableName: table, Key: key }));
            } catch (error) {
                if (!isTableMissing(error)) throw error;
            }
        });
    };
    const undoNeeded = (table: string, o?: KeepOption) => track(o) && !ownTables.has(table);

    const paginate = async (
        operation: 'query' | 'scan',
        input: Record<string, unknown>,
        limit: number | undefined,
    ): Promise<{ items: DynamoItem[]; count: number }> => {
        const items: DynamoItem[] = [];
        let count = 0;
        let start: Record<string, unknown> | undefined;
        do {
            const command = operation === 'query'
                ? new doc.QueryCommand({ ...input, ExclusiveStartKey: start } as never)
                : new doc.ScanCommand({ ...input, ExclusiveStartKey: start } as never);
            const page = await documentClient.send(command as never) as { Items?: DynamoItem[]; Count?: number; LastEvaluatedKey?: Record<string, unknown> };
            items.push(...(page.Items ?? []));
            count += page.Count ?? 0;
            start = page.LastEvaluatedKey;
        } while (start && (limit === undefined || items.length < limit));
        return { items: limit === undefined ? items : items.slice(0, limit), count };
    };

    const queryInput = async (table: string, keyCondition: DynamoConditions | DynamoExpression, o: Omit<DynamoQueryOptions, 'limit'> = {}) => {
        const builder = new ExpressionBuilder();
        const KeyConditionExpression = builder.conditions(keyCondition);
        const FilterExpression = o.filter ? builder.conditions(o.filter) : undefined;
        const consistent = o.consistent ?? true;
        return {
            input: {
                TableName: table,
                KeyConditionExpression,
                ...(FilterExpression ? { FilterExpression } : {}),
                ...(o.index ? { IndexName: o.index } : {}),
                ...(o.descending ? { ScanIndexForward: false } : {}),
                // A global index can't be read consistently; a local one can.
                ConsistentRead: consistent && !(o.index && (await isGlobalIndex(table, o.index))),
                ...builder.expressionAttributes,
            },
            expression: builder.readable(FilterExpression ? `${KeyConditionExpression} (filter: ${FilterExpression})` : KeyConditionExpression),
        };
    };

    const globalIndexes = new Map<string, Promise<Set<string>>>();
    const isGlobalIndex = async (table: string, index: string): Promise<boolean> => {
        let known = globalIndexes.get(table);
        if (!known) {
            known = describe(table).then((t) => new Set((t?.GlobalSecondaryIndexes ?? []).map((i) => i.IndexName ?? '')));
            known.catch(() => globalIndexes.delete(table));
            globalIndexes.set(table, known);
        }
        return (await known).has(index);
    };

    const client: DynamoDbClient = {
        tablePrefix,
        sdk,
        documentClient,
        tableName: (name) => `${tablePrefix}${name}`,
        tableKey: async (table) => {
            try {
                return await tableKey(table);
            } catch (error) {
                return fail('get', { table }, error);
            }
        },

        async put(table, item, o) {
            const details: Record<string, unknown> = { table, item: preview(item, 200) };
            try {
                const builder = new ExpressionBuilder();
                const conditions: string[] = [];
                if (o?.ifNotExists) conditions.push(`attribute_not_exists(${builder.path((await tableKey(table)).partitionKey)})`);
                if (o?.condition) conditions.push(builder.conditions(o.condition));
                const ConditionExpression = conditions.length ? conditions.join(' AND ') : undefined;
                if (ConditionExpression) details.condition = builder.readable(ConditionExpression);
                if (undoNeeded(table, o)) await recordUndo(table, keyOf(item, await tableKey(table), table));
                await documentClient.send(new doc.PutCommand({ TableName: table, Item: item, ...(ConditionExpression ? { ConditionExpression } : {}), ...builder.expressionAttributes }));
            } catch (error) {
                return fail('put', details, error);
            }
        },

        async putMany(table, items, o) {
            for (let i = 0; i < items.length; i += 10) {
                await Promise.all(items.slice(i, i + 10).map((item) => client.put(table, item, o)));
            }
        },

        async get<T extends DynamoItem>(table: string, key: DynamoKey, o?: DynamoGetOptions) {
            try {
                return (await rawGet(table, key, o?.consistent ?? true)) as T | null;
            } catch (error) {
                return fail('get', { table, key: preview(key) }, error);
            }
        },

        async update<T extends DynamoItem>(table: string, key: DynamoKey, changes: DynamoItem | DynamoExpression, o?: DynamoUpdateOptions) {
            const details: Record<string, unknown> = { table, key: preview(key) };
            try {
                const builder = new ExpressionBuilder();
                const UpdateExpression = builder.update(changes, o?.remove, key);
                details.update = builder.readable(UpdateExpression);
                const ConditionExpression = o?.condition ? builder.conditions(o.condition) : undefined;
                if (ConditionExpression) details.condition = builder.readable(ConditionExpression);
                if (undoNeeded(table, o)) await recordUndo(table, key);
                const result = await documentClient.send(new doc.UpdateCommand({
                    TableName: table,
                    Key: key,
                    UpdateExpression,
                    ...(ConditionExpression ? { ConditionExpression } : {}),
                    ...builder.expressionAttributes,
                    ReturnValues: 'ALL_NEW',
                }));
                return (result.Attributes ?? {}) as T;
            } catch (error) {
                return fail('update', details, error);
            }
        },

        async delete<T extends DynamoItem>(table: string, key: DynamoKey, o?: DynamoDeleteOptions) {
            const details: Record<string, unknown> = { table, key: preview(key) };
            try {
                const builder = new ExpressionBuilder();
                const ConditionExpression = o?.condition ? builder.conditions(o.condition) : undefined;
                if (ConditionExpression) details.condition = builder.readable(ConditionExpression);
                const result = await documentClient.send(new doc.DeleteCommand({
                    TableName: table,
                    Key: key,
                    ...(ConditionExpression ? { ConditionExpression } : {}),
                    ...builder.expressionAttributes,
                    ReturnValues: 'ALL_OLD',
                }));
                return (result.Attributes as T | undefined) ?? null;
            } catch (error) {
                return fail('delete', details, error);
            }
        },

        async query<T extends DynamoItem>(table: string, keyCondition: DynamoConditions | DynamoExpression, o: DynamoQueryOptions = {}) {
            const details: Record<string, unknown> = { table, ...(o.index ? { index: o.index } : {}) };
            try {
                const { input, expression } = await queryInput(table, keyCondition, o);
                details.keyCondition = expression;
                return (await paginate('query', input, o.limit)).items as T[];
            } catch (error) {
                return fail('query', details, error);
            }
        },

        async scan<T extends DynamoItem>(table: string, o: DynamoScanOptions = {}) {
            const details: Record<string, unknown> = { table, ...(o.index ? { index: o.index } : {}) };
            try {
                const builder = new ExpressionBuilder();
                const FilterExpression = o.filter ? builder.conditions(o.filter) : undefined;
                if (FilterExpression) details.filter = builder.readable(FilterExpression);
                const consistent = (o.consistent ?? true) && !(o.index && (await isGlobalIndex(table, o.index)));
                const input = {
                    TableName: table,
                    ConsistentRead: consistent,
                    ...(o.index ? { IndexName: o.index } : {}),
                    ...(FilterExpression ? { FilterExpression } : {}),
                    ...builder.expressionAttributes,
                };
                return (await paginate('scan', input, o.limit)).items as T[];
            } catch (error) {
                return fail('scan', details, error);
            }
        },

        async count(table, keyCondition, o = {}) {
            const details: Record<string, unknown> = { table };
            try {
                const { input, expression } = await queryInput(table, keyCondition, o);
                details.keyCondition = expression;
                return (await paginate('query', { ...input, Select: 'COUNT' }, undefined)).count;
            } catch (error) {
                return fail('count', details, error);
            }
        },

        async waitForItem<T extends DynamoItem>(table: string, key: DynamoKey, o: DynamoWaitForItemOptions<T> = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const deadline = Date.now() + timeout;
            let last: T | null = null;
            for (;;) {
                try {
                    last = (await rawGet(table, key)) as T | null;
                } catch (error) {
                    return fail('waitForItem', { table, key: preview(key) }, error);
                }
                if (last && (!o.until || o.until(last))) return last;
                if (Date.now() >= deadline) break;
                await sleep(Math.min(250, Math.max(deadline - Date.now(), 0)));
            }
            return fail('waitForItem', { table, key: preview(key), timeout }, new Error(last
                ? `the item is there but didn't pass the check within ${timeout} ms; it is now ${preview(last)}`
                : `no item with this key appeared within ${timeout} ms`));
        },

        async waitForQuery<T extends DynamoItem>(table: string, keyCondition: DynamoConditions | DynamoExpression, o: DynamoWaitForQueryOptions = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const wanted = o.count ?? 1;
            const deadline = Date.now() + timeout;
            let items: DynamoItem[] = [];
            let expression = '';
            for (;;) {
                try {
                    const built = await queryInput(table, keyCondition, o);
                    expression = built.expression;
                    items = (await paginate('query', built.input, undefined)).items;
                } catch (error) {
                    return fail('waitForItem', { table, keyCondition: expression || preview(keyCondition) }, error);
                }
                if (items.length >= wanted) return items as T[];
                if (Date.now() >= deadline) break;
                await sleep(Math.min(250, Math.max(deadline - Date.now(), 0)));
            }
            return fail('waitForItem', { table, keyCondition: expression, timeout }, new Error(
                `waited ${timeout} ms for ${wanted} item(s), found ${items.length}${items.length ? `: ${preview(items.slice(0, 5))}` : ''}`,
            ));
        },

        async tableExists(table) {
            try {
                await describe(table);
                return true;
            } catch (error) {
                if (isTableMissing(error)) return false;
                return fail('createTable', { table }, error);
            }
        },

        async createTable(table, definition, o) {
            if (await client.tableExists(table)) return;
            let input: Record<string, unknown>;
            try {
                input = createTableInput(table, definition);
            } catch (error) {
                return fail('createTable', { table }, error);
            }
            try {
                await sdk.send(new dynamo.CreateTableCommand(input as never));
            } catch (error) {
                // Another worker created it first: fine.
                if (errorName(error) !== 'ResourceInUseException') return fail('createTable', { table }, error);
            }
            if (track(o)) {
                ownTables.add(table);
                registry!.add(`dynamodb table ${table}`, async () => {
                    keys.delete(table);
                    globalIndexes.delete(table);
                    try {
                        await sdk.send(new dynamo.DeleteTableCommand({ TableName: table }));
                    } catch (error) {
                        if (!isTableMissing(error)) throw error;
                    }
                });
            }
            const deadline = Date.now() + 60_000;
            for (;;) {
                const t = await describe(table).catch(() => undefined);
                const indexesActive = (t?.GlobalSecondaryIndexes ?? []).every((i) => i.IndexStatus === undefined || i.IndexStatus === 'ACTIVE');
                if (t?.TableStatus === 'ACTIVE' && indexesActive) break;
                if (Date.now() >= deadline) return fail('createTable', { table }, new Error(`still ${t?.TableStatus ?? 'missing'} after 60 s`));
                await sleep(500);
            }
            if (definition.ttl) {
                try {
                    await sdk.send(new dynamo.UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: definition.ttl, Enabled: true } }));
                } catch (error) {
                    return fail('createTable', { table, ttl: definition.ttl }, error);
                }
            }
        },

        async deleteTable(table) {
            try {
                keys.delete(table);
                globalIndexes.delete(table);
                await sdk.send(new dynamo.DeleteTableCommand({ TableName: table }));
            } catch (error) {
                return fail('deleteTable', { table }, error);
            }
        },

        close() {
            documentClient.destroy();
            sdk.destroy();
        },
    };
    return client;
}

/**
 * Fixture definition for test.extend(). The undo actions run before the
 * SDK client is destroyed.
 */
export const dynamoDbFixture = {
    dynamoDbClient: async (
        { aws, stagehandContainers, dataCleanup }: { aws: AwsFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: DynamoDbClient) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        const config = await stagehandContainers.aws(await resolveAwsConfig(aws));
        let client: DynamoDbClient;
        try {
            client = await createDynamoDbClient(config, { registry: dataCleanup, runId: newRunId(testInfo.workerIndex) });
        } catch (error) {
            if (error instanceof FixtureInitError || (error as Error).name === 'MissingPackageError') throw error;
            throw new FixtureInitError('dynamodb', 'connect', { reason: reasonOf(error) }, error instanceof Error ? error : undefined);
        }
        let cleanupError: unknown;
        try {
            await use(client);
            await dataCleanup.flush();
        } catch (error) {
            cleanupError = error;
        }
        client.close();
        if (cleanupError) throw cleanupError;
    },
};
