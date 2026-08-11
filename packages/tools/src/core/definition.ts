import type { PublicArtifactRef, ToolEvidenceDelta } from '@agent-core/evidence';
import type { JsonObject, JsonValue } from '@agent-core/json';
import type * as z from 'zod';
import type { ToolExecutionContext, ToolPreparationContext } from './context.js';
import type { ToolObservationPresentation, ToolObservationPresentationRequest } from './observation-presentation.js';
import type { ToolPolicy } from './policy.js';
import type { ToolEffectEnvelope, ToolEffects } from './authorization.js';

export interface ToolCall { readonly id?: string; readonly name: string; readonly input: ToolInput }
export type ToolInput = { readonly kind: 'json'; readonly value: JsonObject } | { readonly kind: 'text'; readonly value: string };
export type ToolTextInputFormat = { type: 'text' } | { type: 'grammar'; syntax: string; definition: string };
export interface ToolPromptGuideRequest { inputFormat: string; services?: Record<string, unknown>; metadata?: Record<string, unknown> }
export type ToolPromptGuide = string | ((request: ToolPromptGuideRequest) => string | undefined);
export interface ToolTextInputDefinition<TInput = unknown> { format: ToolTextInputFormat; description?: string; promptGuide?: ToolPromptGuide; decode(text: string): TInput }
export type ToolInputParseResult<TInput> = { ok: true; input: TInput } | { ok: false; observation: ToolFailureObservation<InvalidArgumentsToolFailureOutput> };

export interface ToolScope {
  readonly resources: readonly string[];
  readonly filters?: import('@agent-core/json').JsonObject;
  readonly limits?: import('@agent-core/json').JsonObject;
  readonly omitted?: import('@agent-core/json').JsonObject;
  readonly coverage: 'complete' | 'partial';
  readonly truncated?: boolean;
  readonly causes?: readonly string[];
}

export type ToolContent =
  | { readonly type: 'text'; readonly text: string; readonly mediaType?: string }
  | { readonly type: 'image'; readonly artifact: PublicArtifactRef; readonly detail: 'high' | 'original' }
  | { readonly type: 'artifact'; readonly artifact: PublicArtifactRef };

export type ModelInputModality = 'text' | 'image';
export interface ToolRequirements {
  readonly services?: readonly string[];
  readonly modelInputModalities?: readonly ModelInputModality[];
  readonly hostCapabilities?: readonly string[];
}

interface ToolObservationBase {
  readonly summary: string;
  readonly scope: ToolScope;
  readonly content?: readonly ToolContent[];
  readonly metadata?: Record<string, unknown>;
  readonly evidence?: ToolEvidenceDelta;
}
export interface ToolResultObservation<TOutput = unknown> extends ToolObservationBase { kind: 'result'; /** A negative domain result is still a completed tool invocation. */ ok: boolean; output: TOutput }
export interface ToolFailureObservation<TOutput extends ToolFailureOutput = ToolFailureOutput> extends ToolObservationBase { kind: 'failure'; ok: false; output: TOutput }
export type ToolObservation<TOutput = unknown> = ToolResultObservation<TOutput> | ToolFailureObservation;

export type ToolFailureReason = 'unknown_tool' | 'policy' | 'invalid_arguments' | 'invalid_output' | 'missing_service' | 'runtime_error';
export interface BaseToolFailureOutput { blocked: true; reason: ToolFailureReason; recovery: string }
export interface UnknownToolFailureOutput extends BaseToolFailureOutput { reason: 'unknown_tool'; toolCall: ToolCall }
export interface PolicyToolFailureOutput extends BaseToolFailureOutput { reason: 'policy'; tool?: string; policyReason?: string; details?: Record<string, unknown> }
export interface ToolValidationIssue { readonly path: readonly (string | number)[]; readonly code: string; readonly message: string }
export interface ToolValidationIssues { readonly issues: readonly ToolValidationIssue[] }
export interface InvalidArgumentsToolFailureOutput extends BaseToolFailureOutput { reason: 'invalid_arguments'; issues?: ToolValidationIssues; details?: Record<string, unknown> }
export interface InvalidOutputToolFailureOutput extends BaseToolFailureOutput { reason: 'invalid_output'; issues: ToolValidationIssues }
export interface MissingServiceDetails { readonly expected?: string; readonly actualType?: string }
export interface MissingServiceToolFailureOutput extends BaseToolFailureOutput { reason: 'missing_service'; service: string; details?: MissingServiceDetails }
export interface RuntimeErrorToolFailureOutput extends BaseToolFailureOutput { reason: 'runtime_error'; error: string; details?: Record<string, unknown> }
export type ToolFailureOutput = UnknownToolFailureOutput | PolicyToolFailureOutput | InvalidArgumentsToolFailureOutput | InvalidOutputToolFailureOutput | MissingServiceToolFailureOutput | RuntimeErrorToolFailureOutput;

export interface ToolDefinition<TDecodedInput = unknown, TCanonicalInput = TDecodedInput, TOutput = unknown> {
  readonly name: string;
  readonly implementationId: string;
  readonly description: string;
  readonly promptGuide?: ToolPromptGuide;
  readonly jsonSchema: JsonObject;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly textInput?: ToolTextInputDefinition<TDecodedInput>;
  readonly effectEnvelope: ToolEffectEnvelope;
  readonly requirements?: ToolRequirements;
  readonly isAvailable?: (policy: ToolPolicy) => boolean;
  decodeInput(input: ToolInput): ToolInputParseResult<TDecodedInput>;
  canonicalizeInput(input: TDecodedInput, context: ToolPreparationContext): TCanonicalInput | Promise<TCanonicalInput>;
  snapshotInput(input: TCanonicalInput): JsonValue;
  deriveEffects(input: TCanonicalInput, context: ToolPreparationContext): ToolEffects | Promise<ToolEffects>;
  invoke(input: TCanonicalInput, context: ToolExecutionContext): Promise<ToolObservation<TOutput>>;
  presentObservation?(request: ToolObservationPresentationRequest<TCanonicalInput, TOutput>): ToolObservationPresentation;
}
