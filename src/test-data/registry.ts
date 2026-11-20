/**
 * Cleanup registry: a per-test stack of undo actions.
 *
 * The client fixtures record an undo for each insert they make (a Mongo
 * insert, a Redis set, a SQL `insert`, a Neo4j write tagged with a run ID),
 * and tests add their own with `testData.cleanup()`. The stack runs in
 * reverse order when the test ends, pass or fail, while every client the
 * test used is still connected.
 */

import { FixtureOperationError } from '../errors.js';

/** Per-call opt-out: leave this call's data in place after the test. */
export interface KeepOption {
    keep?: boolean;
}

export interface CleanupEntry {
    /** What the undo removes, shown when it fails (e.g. `mongodb users: 2 documents`). */
    label: string;
    run: () => unknown;
}

export class CleanupRegistry {
    private readonly entries: CleanupEntry[] = [];

    /**
     * @param autoCleanup when false, the client fixtures record nothing; undo
     *   actions added with `add()` (testData.cleanup) still run.
     */
    constructor(public readonly autoCleanup = true) {}

    /** Adds an undo action. Actions run last-in, first-out. */
    add(label: string, run: () => unknown): void {
        this.entries.push({ label, run });
    }

    /** Undo actions not yet run. */
    get pending(): readonly string[] {
        return this.entries.map((e) => e.label);
    }

    /**
     * Runs every pending undo action, newest first. All of them run even when
     * one fails; then a FixtureOperationError lists the ones that failed.
     */
    async flush(): Promise<void> {
        const failures: string[] = [];
        let first: Error | undefined;
        for (let entry = this.entries.pop(); entry; entry = this.entries.pop()) {
            try {
                await entry.run();
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                first ??= err;
                failures.push(`${entry.label}: ${err.message}`);
            }
        }
        if (failures.length) {
            throw new FixtureOperationError(
                'testData',
                'cleanup',
                { failed: failures.length, reason: failures.join('; ') },
                first,
            );
        }
    }
}
