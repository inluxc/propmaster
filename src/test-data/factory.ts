/**
 * Test data factories.
 *
 *   // tests/factories.ts
 *   import { defineFactory } from '@inluxc/propmaster';
 *   export const user = defineFactory('user', (f) => ({
 *       email: f.email('user'),     // user-t3-9f2a1c0b-1@example.test — unique across workers
 *       name: `User ${f.seq}`,
 *       active: true,
 *   }));
 *
 *   // in a test
 *   const alice = testData.build(user, { name: 'Alice' });
 *   await databaseClient.insert('users', alice);   // deleted again after the test
 */

import { randomBytes } from 'node:crypto';
import { FixtureOperationError, MissingPackageError } from '../errors.js';
import { CleanupRegistry } from './registry.js';

/** The Faker instance from `@faker-js/faker` (typed loosely so the package stays optional). */
export type FakerLike = any;

export interface FactoryContext {
    /** 1, 2, 3, ... per test; shared by every factory and `unique()` in the test. */
    readonly seq: number;
    /** The test's run ID, unique across workers and runs (e.g. `t3-9f2a1c0b`). */
    readonly runId: string;
    /** `<prefix>-<runId>-<n>`: unique across parallel workers and runs. */
    unique(prefix?: string): string;
    /** `<prefix>-<runId>-<n>@example.test` (or another domain). */
    email(prefix?: string, domain?: string): string;
    /** Faker, when `@faker-js/faker` is installed. Its values aren't unique: combine with `unique()` for keys. */
    readonly faker: FakerLike;
}

export interface Factory<T extends object> {
    readonly name: string;
    readonly build: (f: FactoryContext) => T;
}

/** Defines a factory. `build` returns one object; overrides are merged over it. */
export function defineFactory<T extends object>(name: string, build: (f: FactoryContext) => T): Factory<T> {
    return { name, build };
}

export type Overrides<T> = Partial<T> | ((built: T, index: number) => Partial<T>);

/** A run ID unique across workers and runs: `t<worker>-<8 hex>`. */
export function newRunId(workerIndex: number | string = process.env.TEST_WORKER_INDEX ?? 0): string {
    return `t${workerIndex}-${randomBytes(4).toString('hex')}`;
}

/**
 * The `testData` fixture: factories, unique values and the test's cleanup
 * stack. Everything it hands out is scoped to one test.
 */
export class TestData {
    readonly runId: string;
    private counter = 0;
    private readonly factories = new Map<string, Factory<object>>();

    constructor(
        private readonly registry: CleanupRegistry = new CleanupRegistry(),
        options: { runId?: string; faker?: FakerLike; fakerError?: Error } = {},
    ) {
        this.runId = options.runId ?? newRunId();
        this.fakerInstance = options.faker;
        this.fakerError = options.fakerError;
    }

    private readonly fakerInstance: FakerLike;
    private readonly fakerError: Error | undefined;

    /** Faker, when `@faker-js/faker` is installed (MissingPackageError otherwise). */
    get faker(): FakerLike {
        if (this.fakerInstance) return this.fakerInstance;
        throw this.fakerError ?? new MissingPackageError('testData (faker)', '@faker-js/faker', ['@faker-js/faker']);
    }

    /** `<prefix>-<runId>-<n>`: unique across parallel workers and runs. */
    unique(prefix = 'id'): string {
        return `${prefix}-${this.runId}-${++this.counter}`;
    }

    /** `<prefix>-<runId>-<n>@example.test`. */
    email(prefix = 'user', domain = 'example.test'): string {
        return `${this.unique(prefix)}@${domain}`;
    }

    /** Registers a factory under a name, for `build('user')`. Returns it. */
    define<T extends object>(name: string, build: (f: FactoryContext) => T): Factory<T> {
        const factory = defineFactory(name, build);
        this.factories.set(name, factory as Factory<object>);
        return factory;
    }

    /** Builds one object: the factory's, with `overrides` merged over it. Nothing is stored. */
    build<T extends object>(factory: Factory<T> | string, overrides?: Overrides<T>): T {
        return this.buildAt(this.resolve(factory), overrides, 0);
    }

    /** Builds `count` objects. `overrides` may be a function of the built object and its index. */
    buildMany<T extends object>(factory: Factory<T> | string, count: number, overrides?: Overrides<T>): T[] {
        const f = this.resolve(factory);
        return Array.from({ length: count }, (_, i) => this.buildAt(f, overrides, i));
    }

    /**
     * Adds an undo action, run when the test ends (pass or fail), newest first,
     * before the clients disconnect. Use it for data made by other means: an
     * API call, raw SQL, a browser flow.
     */
    cleanup(label: string, run: () => unknown): void;
    cleanup(run: () => unknown): void;
    cleanup(labelOrRun: string | (() => unknown), run?: () => unknown): void {
        if (typeof labelOrRun === 'function') this.registry.add('testData.cleanup', labelOrRun);
        else this.registry.add(labelOrRun, run!);
    }

    /** Undo actions still waiting to run, newest last. */
    get pendingCleanups(): readonly string[] {
        return this.registry.pending;
    }

    /** Runs the pending undo actions now, instead of when the test ends. */
    async flushCleanups(): Promise<void> {
        await this.registry.flush();
    }

    private resolve<T extends object>(factory: Factory<T> | string): Factory<T> {
        if (typeof factory !== 'string') return factory;
        const found = this.factories.get(factory);
        if (!found) {
            throw new FixtureOperationError('testData', 'build', {
                factory,
                reason: `no factory named "${factory}"; defined: ${[...this.factories.keys()].join(', ') || 'none'}. Use testData.define("${factory}", ...) or pass the factory itself.`,
            });
        }
        return found as unknown as Factory<T>;
    }

    private buildAt<T extends object>(factory: Factory<T>, overrides: Overrides<T> | undefined, index: number): T {
        const seq = ++this.counter;
        const getFaker = () => this.faker; // only when the factory reads f.faker
        const ctx: FactoryContext = {
            seq,
            runId: this.runId,
            unique: (prefix) => this.unique(prefix),
            email: (prefix, domain) => this.email(prefix, domain),
            get faker() {
                return getFaker();
            },
        };
        const built = factory.build(ctx);
        const extra = typeof overrides === 'function' ? overrides(built, index) : overrides;
        return { ...built, ...extra };
    }
}
