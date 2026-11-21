/**
 * Loads an OpenAPI document as a plain object, from a local JSON/YAML file or
 * a URL. Used by the tooling (generator, MCP server); the fixture hands the
 * spec to openapi-client-axios instead.
 */

import { loadOptional } from '../fixtures/optional-package.js';
import { isRemoteSpec, resolveSpecDefinition } from '../fixtures/openapi.fixture.js';

export type OpenApiDocument = Record<string, unknown>;

export async function loadOpenApiDocument(specPath: string, root: string = process.cwd()): Promise<OpenApiDocument> {
    if (!isRemoteSpec(specPath)) return (await resolveSpecDefinition(specPath, root)) as unknown as OpenApiDocument;
    const response = await fetch(specPath);
    if (!response.ok) throw new Error(`Couldn't fetch the OpenAPI spec from ${specPath}: HTTP ${response.status}`);
    const text = await response.text();
    try {
        return JSON.parse(text) as OpenApiDocument;
    } catch {
        const yaml = await loadOptional<typeof import('js-yaml')>('js-yaml', 'openApiClient (YAML specs)');
        const parsed = yaml.load(text);
        if (!parsed || typeof parsed !== 'object') throw new Error(`${specPath} doesn't contain an OpenAPI document`);
        return parsed as OpenApiDocument;
    }
}
