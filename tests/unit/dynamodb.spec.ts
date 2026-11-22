/**
 * Unit tests for the DynamoDB fixture: expressions from plain objects, table
 * definitions, item keys and PW_AWS_DYNAMODB_* variables. The service
 * behaviour itself is covered by tests/examples/dynamodb.spec.ts (Moto).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDynamoDbClient, createTableInput, ExpressionBuilder, keyOf, preview, DEFAULT_DYNAMODB_TABLE_PREFIX } from '../../src/fixtures/dynamodb.fixture';
import { ConfigLoader } from '../../src/config/loader';
import { FixtureInitError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _ddb = AssertHasKey<FixtureTypes, 'dynamoDbClient'>;

test.describe('dynamodb — expressions from plain objects', () => {
    test('plain values are equality, joined with AND, with placeholders for every name and value', () => {
        const b = new ExpressionBuilder();
        expect(b.conditions({ customerId: 'c-1', status: 'open' })).toBe('#n0 = :v0 AND #n1 = :v1');
        expect(b.expressionAttributes).toEqual({
            ExpressionAttributeNames: { '#n0': 'customerId', '#n1': 'status' },
            ExpressionAttributeValues: { ':v0': 'c-1', ':v1': 'open' },
        });
    });

    test('every operator', () => {
        const b = new ExpressionBuilder();
        const expression = b.conditions({
            a: { '=': 1 },
            b: { '<>': 2 },
            c: { '<': 3 },
            d: { '<=': 4 },
            e: { '>': 5 },
            f: { '>=': 6 },
            g: { between: [7, 8] },
            h: { beginsWith: 'x' },
            i: { contains: 'y' },
            j: { exists: true },
            k: { exists: false },
            l: { in: ['p', 'q'] },
        });
        expect(b.readable(expression)).toBe(
            'a = 1 AND b <> 2 AND c < 3 AND d <= 4 AND e > 5 AND f >= 6 AND g BETWEEN 7 AND 8 AND begins_with(h, "x") AND contains(i, "y")'
            + ' AND attribute_exists(j) AND attribute_not_exists(k) AND l IN ("p", "q")',
        );
    });

    test('a map value is compared whole unless its only field is an operator name', () => {
        const b = new ExpressionBuilder();
        b.conditions({ address: { city: 'Porto', zip: '4000' }, flags: { '=': { between: true } } });
        expect(Object.values(b.values)).toEqual([{ city: 'Porto', zip: '4000' }, { between: true }]);
    });

    test('dotted names are paths into maps, and a name used twice keeps one placeholder', () => {
        const b = new ExpressionBuilder();
        expect(b.conditions({ 'address.city': 'Porto', 'address.zip': { beginsWith: '40' } })).toBe('#n0.#n1 = :v0 AND begins_with(#n0.#n2, :v1)');
        expect(b.names).toEqual({ '#n0': 'address', '#n1': 'city', '#n2': 'zip' });
    });

    test('one builder for the key condition and the filter never reuses a placeholder', () => {
        const b = new ExpressionBuilder();
        const key = b.conditions({ customerId: 'c-1' });
        const filter = b.conditions({ status: 'open', customerId: { exists: true } });
        expect(key).toBe('#n0 = :v0');
        expect(filter).toBe('#n1 = :v1 AND attribute_exists(#n0)');
    });

    test('a hand-written expression is passed through with its names and values', () => {
        const b = new ExpressionBuilder();
        b.conditions({ pk: 'a' });
        expect(b.conditions({ expression: 'size(#tags) > :n', names: { '#tags': 'tags' }, values: { ':n': 2 } })).toBe('size(#tags) > :n');
        expect(b.expressionAttributes).toEqual({
            ExpressionAttributeNames: { '#n0': 'pk', '#tags': 'tags' },
            ExpressionAttributeValues: { ':v0': 'a', ':n': 2 },
        });
        expect(b.readable('#n0 = :v0 AND size(#tags) > :n')).toBe('pk = "a" AND size(tags) > 2');
    });

    test('bad operands and empty conditions say what is wrong', () => {
        expect(() => new ExpressionBuilder().conditions({})).toThrow(/at least one attribute/);
        expect(() => new ExpressionBuilder().conditions({ a: { between: [1] } })).toThrow(/between takes \[low, high\]/);
        expect(() => new ExpressionBuilder().conditions({ a: { in: [] } })).toThrow(/non-empty array/);
        const b = new ExpressionBuilder();
        b.conditions({ expression: '#a = :x', names: { '#a': 'one' } });
        expect(() => b.conditions({ expression: '#a = :y', names: { '#a': 'two' } })).toThrow(/used twice/);
    });

    test('an update sets fields, removes others, and never touches the key', () => {
        const b = new ExpressionBuilder();
        expect(b.readable(b.update({ customerId: 'c-1', status: 'shipped', skipped: undefined, total: 3 }, ['draft'], { customerId: 'c-1' })))
            .toBe('SET status = "shipped", total = 3 REMOVE draft');
        expect(() => new ExpressionBuilder().update({ customerId: 'c-1' }, [], { customerId: 'c-1' })).toThrow(/nothing to change/);
        expect(new ExpressionBuilder().update({ expression: 'ADD #c :one', names: { '#c': 'count' }, values: { ':one': 1 } })).toBe('ADD #c :one');
        expect(() => new ExpressionBuilder().update({ expression: 'SET a = :b' }, ['x'])).toThrow(/remove goes in the expression/);
    });

    test('no names or values: no empty maps (DynamoDB rejects them)', () => {
        const b = new ExpressionBuilder();
        b.conditions({ expression: 'attribute_exists(pk)' });
        expect(b.expressionAttributes).toEqual({});
    });
});

test.describe('dynamodb — table definitions', () => {
    test('the first key attribute is the partition key, the second the sort key; on demand', () => {
        expect(createTableInput('orders', { key: { customerId: 'S', orderedAt: 'N' } })).toEqual({
            TableName: 'orders',
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }, { AttributeName: 'orderedAt', KeyType: 'RANGE' }],
            AttributeDefinitions: [{ AttributeName: 'customerId', AttributeType: 'S' }, { AttributeName: 'orderedAt', AttributeType: 'N' }],
        });
    });

    test('global and local indexes project everything; shared attributes are defined once; streams', () => {
        const input = createTableInput('orders', {
            key: { customerId: 'S', orderedAt: 'N' },
            indexes: { byStatus: { status: 'S', orderedAt: 'N' } },
            localIndexes: { byTotal: { customerId: 'S', total: 'N' } },
            stream: 'NEW_AND_OLD_IMAGES',
        });
        expect(input.AttributeDefinitions).toEqual([
            { AttributeName: 'customerId', AttributeType: 'S' },
            { AttributeName: 'orderedAt', AttributeType: 'N' },
            { AttributeName: 'status', AttributeType: 'S' },
            { AttributeName: 'total', AttributeType: 'N' },
        ]);
        expect(input.GlobalSecondaryIndexes).toEqual([{
            IndexName: 'byStatus',
            KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'orderedAt', KeyType: 'RANGE' }],
            Projection: { ProjectionType: 'ALL' },
        }]);
        expect(input.LocalSecondaryIndexes).toMatchObject([{ IndexName: 'byTotal' }]);
        expect(input.StreamSpecification).toEqual({ StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' });
    });

    test('mistakes in a definition are explained', () => {
        expect(() => createTableInput('t', { key: {} })).toThrow(/partition key and at most one sort key/);
        expect(() => createTableInput('t', { key: { a: 'S', b: 'N', c: 'S' } })).toThrow(/at most one sort key/);
        expect(() => createTableInput('t', { key: { a: 'string' as never } })).toThrow(/use 'S', 'N' or 'B'/);
        expect(() => createTableInput('t', { key: { a: 'S' }, indexes: { x: { a: 'N' } } })).toThrow(/a is S in one key and N in another/);
        expect(() => createTableInput('t', { key: { a: 'S', b: 'N' }, localIndexes: { x: { c: 'S', d: 'N' } } })).toThrow(/table's partition key \(a\)/);
    });
});

test.describe('dynamodb — keys and messages', () => {
    test('keyOf takes the key attributes of an item and names missing ones', () => {
        expect(keyOf({ customerId: 'c', orderedAt: 1, total: 3 }, { partitionKey: 'customerId', sortKey: 'orderedAt' }, 'orders')).toEqual({ customerId: 'c', orderedAt: 1 });
        expect(keyOf({ id: 'x', other: 1 }, { partitionKey: 'id' }, 't')).toEqual({ id: 'x' });
        expect(() => keyOf({ customerId: 'c' }, { partitionKey: 'customerId', sortKey: 'orderedAt' }, 'orders')).toThrow('the item has no orderedAt, the key of orders (customerId, orderedAt)');
    });

    test('preview shows sets as arrays and cuts long values', () => {
        expect(preview({ tags: new Set(['a', 'b']), n: 1n })).toBe('{"tags":["a","b"],"n":"1"}');
        expect(preview('x'.repeat(400), 10)).toBe(`"${'x'.repeat(9)}…`);
    });

    test('the per-test table prefix is the root plus the run ID; tableName() adds the name', async () => {
        const client = await createDynamoDbClient({ endpoint: 'http://127.0.0.1:1' }, { runId: 't3-abcd1234' });
        expect(client.tablePrefix).toBe(`${DEFAULT_DYNAMODB_TABLE_PREFIX}t3-abcd1234-`);
        expect(client.tableName('orders')).toBe('propmaster-tests-t3-abcd1234-orders');
        client.close();
        const custom = await createDynamoDbClient({ endpoint: 'http://127.0.0.1:1', dynamodb: { tablePrefix: 'ci_' } }, { runId: 'r' });
        expect(custom.tableName('x')).toBe('ci_r-x');
        custom.close();
    });

    test('no region says what to set', async () => {
        const saved = { ...process.env };
        delete process.env.AWS_REGION;
        delete process.env.AWS_DEFAULT_REGION;
        try {
            await expect(createDynamoDbClient({})).rejects.toThrow(FixtureInitError);
        } finally {
            process.env = saved;
        }
    });
});

test.describe('dynamodb — configuration', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-ddb-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { aws: { region: 'eu-west-1', dynamodb: { tablePrefix: 'file-' } } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('environments.json sets the table prefix; PW_AWS_DYNAMODB_TABLE_PREFIX overrides it', () => {
        expect(new ConfigLoader(dir).load('local').aws?.dynamodb).toEqual({ tablePrefix: 'file-' });
        process.env.PW_AWS_DYNAMODB_TABLE_PREFIX = 'env-';
        expect(new ConfigLoader(dir).load('local').aws).toEqual({ region: 'eu-west-1', dynamodb: { tablePrefix: 'env-' } });
    });
});
