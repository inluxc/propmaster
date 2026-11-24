/**
 * Tests in other languages: the application under test can be written in
 * anything, and its own unit (and integration) tests belong in the coverage
 * picture. Each language has the file names its test runners pick up and the
 * way a test is declared; everything is read statically, as for the
 * Playwright tests.
 *
 * Layers: the path decides (an `integration/` or `e2e/` folder, Maven's
 * `*IT.java`, Rust's `tests/` folder, a Go `integration` build tag), then a
 * marker on the test itself (`@pytest.mark.integration`, `@Tag("e2e")`,
 * `[Trait("Category", "Integration")]`), else unit.
 */

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'kotlin' | 'scala' | 'groovy' | 'csharp' | 'ruby' | 'php' | 'rust' | 'swift' | 'elixir';

export interface FoundOtherTest {
    title: string;
    /** Offset of the declaration in the source. */
    index: number;
    skipped: boolean;
    /** The text before the declaration that belongs to it: decorators, annotations, attributes. */
    markers: string;
}

interface LanguageSpec {
    language: Language;
    /** Whether a path (relative, forward slashes) is a test file of this language. */
    file: (path: string, name: string) => boolean;
    /** Test declarations: the title is the first capture group that matched. */
    test: RegExp;
    /** Markers (decorators, annotations, attributes) that skip the test. */
    skip?: RegExp;
    /** A declaration that is itself skipped (`xit`, `it.skip`). */
    skippedDeclaration?: RegExp;
}

const JVM = /\.(java|kt|kts|scala|groovy)$/;
const JVM_LANGUAGE: Record<string, Language> = { java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy' };

/** A line that is only a decorator, annotation or attribute: `@pytest.mark.skip(...)`, `@Disabled`, `@tag :skip`, `#[ignore]`, `[Fact(Skip = "x")]`. */
const MARKER_LINE = /^[ \t]*(?:@[\w.]+(?:\(.*\)|[ \t]+[:\w].*)?|#\[.*\]|\[[A-Z][\w.]*(?:\(.*\))?\])[ \t]*$/;

/** The marker lines right above `index`, nearest last. */
function markersAbove(src: string, index: number): string {
    const lines = src.slice(Math.max(0, index - 2000), index).split(/\r?\n/);
    lines.pop(); // the declaration's own line, up to the declaration
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0 && MARKER_LINE.test(lines[i]); i--) out.unshift(lines[i]);
    return out.join('\n');
}

const SPECS: LanguageSpec[] = [
    {
        language: 'python',
        file: (_p, n) => /^test_.*\.py$|_test\.py$/.test(n),
        test: /^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gm,
        skip: /@(?:pytest\.mark\.skip|pytest\.mark\.xfail|unittest\.skip)\b/,
    },
    {
        language: 'go',
        file: (_p, n) => n.endsWith('_test.go'),
        test: /^func[ \t]+(Test\w*)[ \t]*\([ \t]*\w+[ \t]+\*testing\.T[ \t]*\)/gm,
    },
    {
        language: 'java',
        file: (p, n) => JVM.test(n) && (/(Test|Tests|IT|ITCase|Spec)\.\w+$/.test(n) || p.includes('/src/test/') || p.startsWith('src/test/')),
        // JUnit 4/5, TestNG; Kotlin `fun`, Java methods; Spock / Kotest / ScalaTest string specs
        test: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b[^\n]*\n(?:[ \t]*@[^\n]*\n)*[ \t]*(?:(?:public|private|protected|internal|static|final|suspend|override|open|void|fun|def|[\w<>[\],? ]+?)[ \t]+)*`?([\w $]+?)`?[ \t]*\(|^[ \t]*(?:def|test|it|should|scenario)[ \t]*\(?[ \t]*["']([^"'\n]+)["']/gm,
        skip: /@(?:Disabled|Ignore|Ignored|Pending)\b/,
    },
    {
        language: 'csharp',
        file: (_p, n) => /Tests?\.cs$|Specs?\.cs$/.test(n),
        test: /\[(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod|SkippableFact)\b[^\]]*\][\s\S]{0,300}?\b(?:public|internal)[ \t]+(?:async[ \t]+)?(?:static[ \t]+)?[\w<>]+[ \t]+(\w+)[ \t]*\(/g,
        skip: /\[(?:Fact|Theory)\([^)]*\bSkip\s*=|\[Ignore\b/,
    },
    {
        language: 'ruby',
        file: (_p, n) => /_spec\.rb$|_test\.rb$/.test(n),
        test: /^[ \t]*(?:x?it|x?specify|scenario|test)[ \t]*\(?[ \t]*["']([^"'\n]+)["']|^[ \t]*def[ \t]+(test_\w+)/gm,
        skippedDeclaration: /^[ \t]*x(?:it|specify)\b/,
    },
    {
        language: 'php',
        file: (_p, n) => /Test\.php$/.test(n),
        test: /function[ \t]+(test\w*)[ \t]*\(|(?:#\[Test\]|@test\b)[\s\S]{0,200}?function[ \t]+(\w+)[ \t]*\(|^[ \t]*(?:it|test)[ \t]*\([ \t]*["']([^"'\n]+)["']/gm,
        skip: /#\[(?:Group\(['"]skip|Ignore)|@group[ \t]+skip/,
    },
    {
        language: 'rust',
        file: (_p, n) => n.endsWith('.rs'),
        test: /#\[(?:tokio::|async_std::|actix_rt::|rstest|test_case|sqlx::)?test(?:\([^\n]*\))?\][\s\S]{0,300}?\bfn[ \t]+(\w+)/g,
        skip: /#\[ignore\b/,
    },
    {
        language: 'swift',
        file: (_p, n) => /Tests?\.swift$/.test(n),
        test: /\bfunc[ \t]+(test\w*)[ \t]*\(|@Test(?:\([^\n]*\))?[\s\S]{0,200}?\bfunc[ \t]+(\w+)[ \t]*\(/g,
        skip: /@Test\([^)]*\.disabled/,
    },
    {
        language: 'elixir',
        file: (_p, n) => n.endsWith('_test.exs'),
        test: /^[ \t]*test[ \t]+"([^"\n]+)"/gm,
        skip: /@tag[ \t]+:skip|@tag[ \t]+skip:/,
    },
];

/** The language of a test file in a language other than JavaScript/TypeScript, or null. */
export function languageOf(path: string): Language | null {
    const name = path.split('/').pop() ?? '';
    const spec = SPECS.find((s) => s.file(path, name));
    if (!spec) return null;
    if (spec.language === 'java') return JVM_LANGUAGE[name.split('.').pop() ?? 'java'] ?? 'java';
    return spec.language;
}

function specFor(language: Language): LanguageSpec | undefined {
    if (['java', 'kotlin', 'scala', 'groovy'].includes(language)) return SPECS.find((s) => s.language === 'java');
    return SPECS.find((s) => s.language === language);
}

/** The tests declared in a source file of `language`. */
export function findOtherTests(src: string, language: Language): FoundOtherTest[] {
    const spec = specFor(language);
    if (!spec) return [];
    const out: FoundOtherTest[] = [];
    for (const m of src.matchAll(new RegExp(spec.test.source, spec.test.flags))) {
        const title = m.slice(1).find((g) => g !== undefined)?.trim();
        if (!title) continue;
        const index = m.index ?? 0;
        // A declaration that starts with its markers (C#, Rust, JUnit) carries them; otherwise look at the lines above.
        const markers = `${markersAbove(src, index)}\n${m[0].slice(0, m[0].indexOf(title))}`;
        const skipped = (spec.skip?.test(markers) ?? false) || (spec.skippedDeclaration?.test(m[0]) ?? false);
        out.push({ title, index, skipped, markers });
    }
    return out;
}

/** The layer a test's own markers name (`@pytest.mark.integration`, `@Tag("e2e")`, `[Category("Integration")]`). */
export function layerFromMarkers(markers: string): 'integration' | 'e2e' | null {
    if (/\b(e2e|end[-_ ]?to[-_ ]?end|acceptance|ui)\b/i.test(markers)) return 'e2e';
    if (/\b(integration|integration_?tests?)\b/i.test(markers)) return 'integration';
    return null;
}

/** The layer a whole file says, beyond its folder: Maven/Gradle `*IT`, Rust's `tests/`, Go build tags. */
export function layerFromFile(path: string, src: string, language: Language): 'integration' | 'e2e' | null {
    const name = path.split('/').pop() ?? '';
    if (['java', 'kotlin', 'scala', 'groovy'].includes(language) && /(IT|ITCase|IntegrationTests?)\.\w+$/.test(name)) return 'integration';
    if (language === 'rust' && /^(?:.*\/)?tests\/[^/]+\.rs$/.test(path)) return 'integration';
    if (language === 'go') {
        const tag = /^\/\/go:build\s+(.+)$/m.exec(src)?.[1] ?? '';
        if (/\be2e\b/.test(tag)) return 'e2e';
        if (/\bintegration\b/.test(tag)) return 'integration';
    }
    return null;
}
