import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { InMemoryArtifactRepository } from '@agent-core/evidence';
import { filterToolResultContentForModel } from '@agent-core/runtime';
import { defineTool, parseToolObservation } from '@agent-core/tools';
import { DEFAULT_LOCAL_TOOL_CONFIGURATION, readArtifactTool } from '@agent-core/tools-local';
import { invokeToolCall, jsonToolCall } from '../tool-call-helpers.js';

const mixedContentTool = defineTool({
  name: 'mixed_content', implementationId: 'tests/mixed-content@1', description: 'Mixed content fixture.',
  schema: z.strictObject({}), outputSchema: z.strictObject({ status: z.literal('complete') }),
  effectEnvelope: { accesses: [], lockScopes: [] }, canonicalizeInput: input => input,
  deriveEffects: () => ({ accesses: [], lockScopes: [], idempotency: 'pure' }),
  invoke: async () => ({ kind: 'result', ok: true, summary: 'unused', scope: { resources: [], coverage: 'complete' }, output: { status: 'complete' } })
});

test('read_artifact image content is retained for multimodal models and projected as metadata for text-only models', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await artifacts.store({ label: 'pixel', mediaType: 'image/png', content: new Uint8Array([137, 80, 78, 71]) });
  const observation = await invokeToolCall(jsonToolCall('read_artifact', { artifactId: artifact.artifactId, byteCount: artifact.size }), [readArtifactTool], {
    policy: { allowedRisks: ['read'] },
    services: { artifactRepository: artifacts, localToolConfiguration: DEFAULT_LOCAL_TOOL_CONFIGURATION }
  });
  assert.equal(observation.content[0].type, 'image');

  const multimodal = filterToolResultContentForModel(observation, ['text', 'image']);
  assert.equal(multimodal.content[0].type, 'image');

  const textOnly = filterToolResultContentForModel(observation, ['text']);
  assert.equal(textOnly.content[0].type, 'artifact');
  assert.equal(textOnly.content[0].artifact.artifactId, artifact.artifactId);
  assert.match(textOnly.summary, /image.*not attached/iu);
  assert.deepEqual(textOnly.metadata.modelContentFilter.convertedToArtifactMetadata.map(ref => ref.artifactId), [artifact.artifactId]);
});

test('the generic result-content filter preserves supported members of mixed text and image content', async () => {
  const artifacts = new InMemoryArtifactRepository();
  const artifact = await artifacts.store({ label: 'mixed', mediaType: 'image/png', content: new Uint8Array([1, 2, 3]) });
  const observation = parseToolObservation(mixedContentTool, {
    kind: 'result', ok: true, summary: 'mixed result', scope: { resources: [`artifacts/${artifact.artifactId}`], coverage: 'complete' },
    content: [{ type: 'text', text: 'keep this', mediaType: 'text/plain' }, { type: 'image', artifact, detail: 'original' }], output: { status: 'complete' }
  });
  const filtered = filterToolResultContentForModel(observation, ['text']);
  assert.deepEqual(filtered.content.map(item => item.type), ['text', 'artifact']);
  assert.equal(filtered.content[0].text, 'keep this');
  assert.equal(filtered.content[1].artifact.artifactId, artifact.artifactId);
});
