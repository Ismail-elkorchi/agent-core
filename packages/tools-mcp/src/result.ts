import * as z from 'zod';
import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from '@agent-core/json';
import type { ArtifactRepository } from '@agent-core/persistence';
import type { ToolContent } from '@agent-core/tools';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { jsonLimits, type McpLimits } from './limits.js';
import { hasCredential, McpCredentialContentError, type McpCredentialMatcher } from './credentials.js';

export interface McpResultOrigin {
  readonly sourceId: string;
  readonly toolId: string;
  readonly bindingRevision: string;
}
const originSchema = z.strictObject({
  sourceId: z.string(), toolId: z.string(), bindingRevision: z.string(),
  contentIndex: z.number().int().nonnegative(), uri: z.string().optional()
});
const artifactSchema = z.strictObject({
  artifactId: z.string(), sha256: z.string(), size: z.number().int().nonnegative(),
  mediaType: z.string(), visibility: z.literal('public'), label: z.string().optional(), description: z.string().optional()
});
const contentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string(), origin: originSchema }),
  z.strictObject({ type: z.literal('resource_link'), uri: z.string(), name: z.string(),
    mimeType: z.string().optional(), description: z.string().optional(), origin: originSchema }),
  z.strictObject({ type: z.literal('artifact'), artifact: artifactSchema,
    originalType: z.enum(['image', 'audio', 'resource']), origin: originSchema })
]);
export function mcpOutputSchema(structured?: z.ZodType): z.ZodType {
  return z.strictObject({
    content: z.array(contentSchema),
    structuredContent: structured ?? z.json().optional()
  });
}
export async function normalizeMcpResult(
  value: CallToolResult,
  origin: McpResultOrigin,
  limits: McpLimits,
  artifacts: ArtifactRepository | undefined,
  containsCredential?: McpCredentialMatcher
): Promise<{ readonly output: JsonObject; readonly content: readonly ToolContent[]; readonly isError: boolean }> {
  const captured = parseJsonObject(value, jsonLimits(limits.maxResultBytes));
  if (!Array.isArray(captured.content) || captured.content.length > limits.maxContentBlocks) {
    throw new Error('MCP content block limit exceeded.');
  }
  if (containsCredential) {
    if (hasCredential(captured, containsCredential)) throw new McpCredentialContentError(captured);
    let remaining = limits.maxBinaryBytes;
    // Preflight every block before storing any public artifact, including a
    // harmless earlier block preceding a credential-bearing binary block.
    for (const raw of captured.content) {
      const block = parseJsonObject(raw, jsonLimits(limits.maxResultBytes));
      const resource = block.type === 'resource' ? parseJsonObject(block.resource, jsonLimits(limits.maxResultBytes)) : block;
      const data = block.type === 'resource' ? resource.blob : block.type === 'image' || block.type === 'audio' ? block.data : undefined;
      if (typeof data === 'string') {
        const bytes = decodeBase64(data, remaining);
        remaining -= bytes.byteLength;
        if (containsCredential(bytes)) throw new McpCredentialContentError(captured);
      }
    }
  }
  const normalized: JsonValue[] = [];
  const presentation: ToolContent[] = [];
  let binaryBytes = 0;
  for (const [index, raw] of captured.content.entries()) {
    const block = parseJsonObject(raw, jsonLimits(limits.maxResultBytes));
    const blockOrigin = { ...origin, contentIndex: index };
    if (block.type === 'text' && typeof block.text === 'string') {
      normalized.push({ type: 'text', text: block.text, origin: blockOrigin });
      presentation.push({ type: 'text', text: block.text });
    } else if (block.type === 'resource_link' && typeof block.uri === 'string' && typeof block.name === 'string') {
      // Remote URIs remain untrusted descriptors. They never become local artifact authority.
      normalized.push({ type: 'resource_link', uri: block.uri, name: block.name,
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
        ...(typeof block.description === 'string' ? { description: block.description } : {}), origin: blockOrigin });
    } else if (block.type === 'image' || block.type === 'audio' || block.type === 'resource') {
      const resource = block.type === 'resource' ? parseJsonObject(block.resource, jsonLimits(limits.maxResultBytes)) : block;
      const uri = block.type === 'resource' && typeof resource.uri === 'string' ? resource.uri : undefined;
      if (block.type === 'resource' && uri === undefined) throw new Error('MCP resource has no URI.');
      if (block.type === 'resource' && typeof resource.text === 'string') {
        normalized.push({ type: 'text', text: resource.text, origin: { ...blockOrigin, ...(uri === undefined ? {} : { uri }) } });
        presentation.push({ type: 'text', text: resource.text });
        continue;
      }
      const data = block.type === 'resource' ? resource.blob : resource.data;
      if (typeof data !== 'string') throw new Error('Invalid MCP binary content.');
      const bytes = decodeBase64(data, limits.maxBinaryBytes - binaryBytes);
      binaryBytes += bytes.byteLength;
      if (!artifacts) throw new Error('MCP binary results require a host artifact repository.');
      const mediaType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
      const artifact = await artifacts.store({
        label: `mcp-${origin.sourceId}-${String(index)}`, content: bytes, mediaType,
        description: `MCP content from ${origin.sourceId}/${origin.toolId}`
      });
      const ownedArtifact = parseJsonObject(artifact);
      normalized.push({ type: 'artifact', artifact: ownedArtifact, originalType: block.type,
        origin: { ...blockOrigin, ...(uri === undefined ? {} : { uri }) } });
      presentation.push(block.type === 'image'
        ? { type: 'image', artifact, detail: 'original' }
        : { type: 'artifact', artifact });
    } else {
      throw new Error('Unsupported MCP content block.');
    }
  }
  const output = parseJsonObject({ content: normalized,
    ...(Object.hasOwn(captured, 'structuredContent') ? { structuredContent: parseJsonValue(captured.structuredContent) } : {})
  }, jsonLimits(limits.maxResultBytes));
  return { output, content: presentation, isError: captured.isError === true };
}
function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('Invalid or oversized MCP binary content.');
  }
  const decoded = atob(value);
  if (decoded.length > maxBytes) throw new Error('MCP binary limit exceeded.');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
