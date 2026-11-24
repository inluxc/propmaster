/**
 * The reason a request failed, written the same way on Node.js and Bun.
 *
 * Node's fetch throws `TypeError: fetch failed` and puts what happened in
 * `cause` (`connect ECONNREFUSED 127.0.0.1:9200`). Bun's throws a TypeError
 * whose own `code` and message say it (`ECONNREFUSED: Unable to connect...`).
 * Both become `fetch failed: ECONNREFUSED (...)`, so error messages, and
 * the tests that check them, don't depend on the runtime.
 */

interface WithCode {
    code?: unknown;
    message?: string;
    errors?: Array<{ code?: unknown }>;
}

const codeOf = (value: WithCode | undefined): string | undefined => {
    const code = value?.code ?? value?.errors?.find((e) => typeof e.code === 'string')?.code;
    return typeof code === 'string' ? code : undefined;
};

export function errorReason(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = error.cause as WithCode | undefined;

    // Node.js (undici): the reason is in `cause`.
    if (error.message === 'fetch failed') {
        const code = codeOf(cause);
        const detail = cause?.message && cause.message !== code ? cause.message : undefined;
        if (code) return `fetch failed: ${code}${detail ? ` (${detail})` : ''}`;
        return detail ? `fetch failed: ${detail}` : error.message;
    }

    // Bun: a TypeError with its own code, e.g. "ECONNREFUSED: Unable to connect. ..."
    const own = codeOf(error as WithCode);
    if (error.name === 'TypeError' && own && cause === undefined) {
        const detail = error.message.startsWith(`${own}: `) ? error.message.slice(own.length + 2) : error.message;
        return `fetch failed: ${own}${detail && detail !== own ? ` (${detail})` : ''}`;
    }

    return error.message;
}
