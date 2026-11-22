/**
 * Quarantine: a list of TestCaseIDs whose failures don't fail the build.
 *
 * `quarantine.json` at the project root (or PW_QUARANTINE_FILE):
 *
 *   {
 *     "maxAgeDays": 30,
 *     "tests": [
 *       { "id": "TC-API-007", "owner": "payments-team", "issue": "https://github.com/acme/shop/issues/42",
 *         "since": "2026-11-20", "reason": "times out when the mock is slow" }
 *     ]
 *   }
 *
 * Quarantined tests still run and are reported (with a `quarantined`
 * annotation). The Propmaster reporter turns a failed run into a passed one
 * when every failure is quarantined. `propmaster check` warns about entries
 * older than `maxAgeDays` and IDs no test has.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_QUARANTINE_FILE = 'quarantine.json';
export const DEFAULT_QUARANTINE_MAX_AGE_DAYS = 30;

export interface QuarantineEntry {
    /** The TestCaseID, e.g. `TC-API-007`. */
    id: string;
    /** Who is fixing it: a person or team. */
    owner: string;
    /** Where the fix is tracked: an issue URL or key. */
    issue: string;
    /** When it was quarantined, `YYYY-MM-DD`. */
    since: string;
    reason?: string;
}

export interface QuarantineFile {
    /** Days after which `propmaster check` warns about an entry (default 30). */
    maxAgeDays?: number;
    tests: QuarantineEntry[];
}

export interface LoadedQuarantine {
    file: string;
    maxAgeDays: number;
    entries: Map<string, QuarantineEntry>;
}

const TEST_ID = /TC-[A-Z][A-Z0-9]{1,5}-\d{3,}/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The TestCaseID of a test: from its `@TC-…` tag, else the `[TC-…]` at the start of its title. */
export function testIdOf(title: string, tags: readonly string[] = []): string | undefined {
    for (const tag of tags) {
        const m = /^@?(TC-[A-Z][A-Z0-9]{1,5}-\d{3,})$/.exec(tag);
        if (m) return m[1];
    }
    const m = /^\[(TC-[A-Z][A-Z0-9]{1,5}-\d{3,})\]/.exec(title.trim());
    return m?.[1];
}

/** The quarantine file to use: an explicit path, else PW_QUARANTINE_FILE, else `quarantine.json` in `root`. */
export function quarantinePath(root: string, file?: string, env: NodeJS.ProcessEnv = process.env): string {
    return resolve(root, file ?? env.PW_QUARANTINE_FILE ?? DEFAULT_QUARANTINE_FILE);
}

/** Problems with the file's content, one per line; empty when it is valid. */
export function validateQuarantine(data: unknown): string[] {
    const problems: string[] = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file must be a JSON object with a "tests" array'];
    const { tests, maxAgeDays } = data as Partial<QuarantineFile>;
    if (maxAgeDays !== undefined && (typeof maxAgeDays !== 'number' || !(maxAgeDays > 0))) problems.push('"maxAgeDays" must be a number above 0');
    if (!Array.isArray(tests)) return [...problems, '"tests" must be an array'];
    const seen = new Set<string>();
    tests.forEach((entry: Partial<QuarantineEntry>, i) => {
        const where = `tests[${i}]${typeof entry?.id === 'string' ? ` (${entry.id})` : ''}`;
        if (!entry || typeof entry !== 'object') {
            problems.push(`${where}: must be an object`);
            return;
        }
        if (typeof entry.id !== 'string' || !TEST_ID.test(entry.id) || entry.id !== TEST_ID.exec(entry.id)?.[0]) {
            problems.push(`${where}: "id" must be a TestCaseID such as TC-API-007`);
        } else if (seen.has(entry.id)) {
            problems.push(`${where}: listed twice`);
        } else {
            seen.add(entry.id);
        }
        for (const field of ['owner', 'issue'] as const) {
            if (typeof entry[field] !== 'string' || !entry[field]!.trim()) problems.push(`${where}: "${field}" is required (who fixes it, and where that's tracked)`);
        }
        if (typeof entry.since !== 'string' || !DATE.test(entry.since) || Number.isNaN(Date.parse(`${entry.since}T00:00:00Z`))) {
            problems.push(`${where}: "since" must be a date, YYYY-MM-DD`);
        }
    });
    return problems;
}

/** Reads and validates a quarantine file. A missing file is an empty quarantine; an invalid one throws. */
export function loadQuarantine(file: string): LoadedQuarantine {
    const entries = new Map<string, QuarantineEntry>();
    if (!existsSync(file)) return { file, maxAgeDays: DEFAULT_QUARANTINE_MAX_AGE_DAYS, entries };
    let data: unknown;
    try {
        data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${file} isn't valid JSON: ${(error as Error).message}`);
    }
    const problems = validateQuarantine(data);
    if (problems.length) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
    const parsed = data as QuarantineFile;
    for (const entry of parsed.tests) entries.set(entry.id, entry);
    return { file, maxAgeDays: parsed.maxAgeDays ?? DEFAULT_QUARANTINE_MAX_AGE_DAYS, entries };
}

/** Whole days from `since` (YYYY-MM-DD) to `now`. */
export function ageInDays(since: string, now: Date = new Date()): number {
    return Math.floor((now.getTime() - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
}

/** Warnings for `propmaster check`: entries past their age, and IDs no test has. */
export function quarantineWarnings(quarantine: LoadedQuarantine, knownIds: ReadonlySet<string>, now: Date = new Date()): string[] {
    const warnings: string[] = [];
    for (const entry of quarantine.entries.values()) {
        const age = ageInDays(entry.since, now);
        if (age > quarantine.maxAgeDays) {
            warnings.push(`${entry.id} has been quarantined for ${age} days (more than ${quarantine.maxAgeDays}): fix it or remove the test. Owner: ${entry.owner}, ${entry.issue}`);
        }
        if (!knownIds.has(entry.id)) warnings.push(`${entry.id} is quarantined, but no test has that ID: remove the entry`);
    }
    return warnings;
}

/** The text of the `quarantined` annotation. */
export function describeEntry(entry: QuarantineEntry): string {
    return `owner ${entry.owner}, ${entry.issue}, since ${entry.since}${entry.reason ? `: ${entry.reason}` : ''}`;
}

const cache = new Map<string, { mtimeMs: number; quarantine: LoadedQuarantine | undefined }>();

/**
 * The quarantine entry of a test, for the annotation the test fixture adds.
 * Read once per worker (again when the file changes); an invalid file counts
 * as no quarantine here, and the reporter says it's invalid.
 */
export function quarantineEntryFor(root: string, title: string, tags: readonly string[]): QuarantineEntry | undefined {
    const id = testIdOf(title, tags);
    if (!id) return undefined;
    const file = quarantinePath(root);
    let mtimeMs = -1;
    try {
        mtimeMs = statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
    let cached = cache.get(file);
    if (!cached || cached.mtimeMs !== mtimeMs) {
        let quarantine: LoadedQuarantine | undefined;
        try {
            quarantine = loadQuarantine(file);
        } catch {
            quarantine = undefined;
        }
        cached = { mtimeMs, quarantine };
        cache.set(file, cached);
    }
    return cached.quarantine?.entries.get(id);
}
