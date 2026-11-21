/**
 * Read/write guards for the MCP server.
 *
 * These stop an agent from changing data by accident through a read tool.
 * They are not a sandbox: point the server at a read-only database user when
 * the data matters.
 */

/** Environment names treated as production. */
const PRODUCTION_NAMES = new Set(['prod', 'production', 'prd', 'live']);

export function isProductionEnvironment(name: string): boolean {
    return PRODUCTION_NAMES.has(name.trim().toLowerCase());
}

const READ_START = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'PRAGMA']);

/**
 * Keywords that change data or schema. `INTO` covers `SELECT ... INTO new_table`,
 * `ANALYZE` covers `EXPLAIN ANALYZE` (which runs the statement), and `UPDATE`
 * also catches `SELECT ... FOR UPDATE` locks.
 */
const WRITE_WORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
    'GRANT', 'REVOKE', 'COPY', 'CALL', 'EXEC', 'EXECUTE', 'DO', 'LOCK', 'VACUUM', 'REINDEX', 'CLUSTER',
    'ATTACH', 'DETACH', 'INTO', 'ANALYZE', 'COMMENT', 'REFRESH', 'IMPORT', 'LOAD', 'HANDLER', 'RENAME',
];
const WRITE_RE = new RegExp(`\\b(${WRITE_WORDS.join('|')})\\b`, 'i');

/**
 * Removes comments, string literals and quoted identifiers, so keywords inside
 * them don't count. Each literal becomes a placeholder.
 */
export function stripSqlLiterals(sql: string): string {
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1];
        if (c === '-' && next === '-') {
            const end = sql.indexOf('\n', i);
            i = end < 0 ? sql.length : end;
            out += ' ';
        } else if (c === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 2;
            out += ' ';
        } else if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === c && sql[j + 1] === c) j += 2; // doubled quote escapes itself
                else if (sql[j] === '\\' && c === "'") j += 2;
                else if (sql[j] === c) break;
                else j++;
            }
            i = j + 1;
            out += c === "'" ? "''" : '_q';
        } else if (c === '[') {
            const end = sql.indexOf(']', i);
            i = end < 0 ? sql.length : end + 1;
            out += '_q';
        } else if (c === '$') {
            const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (tag) {
                const end = sql.indexOf(tag[0], i + tag[0].length);
                i = end < 0 ? sql.length : end + tag[0].length;
                out += "''";
            } else {
                out += c;
                i++;
            }
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 * Returns `undefined` when the SQL is a single read-only statement, otherwise
 * the reason it isn't.
 */
export function readOnlySqlProblem(sql: string): string | undefined {
    const stripped = stripSqlLiterals(sql);
    const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
    if (statements.length === 0) return 'the statement is empty';
    if (statements.length > 1) return 'only one statement is allowed';

    const statement = statements[0];
    const first = /^[(\s]*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();
    if (!first || !READ_START.has(first)) {
        return `a read must start with ${[...READ_START].join(', ')}, not ${first ?? 'that'}`;
    }
    if (first === 'PRAGMA' && statement.includes('=')) return 'PRAGMA with "=" changes a setting';
    const write = WRITE_RE.exec(statement);
    if (write) return `it contains ${write[1].toUpperCase()}`;
    return undefined;
}

/** Aggregation stages that write: `$out` and `$merge`. */
export function writingPipelineStage(pipeline: unknown[]): string | undefined {
    for (const stage of pipeline) {
        if (stage && typeof stage === 'object') {
            const key = Object.keys(stage).find((k) => k === '$out' || k === '$merge');
            if (key) return key;
        }
    }
    return undefined;
}
