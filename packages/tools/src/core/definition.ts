import type { PublicArtifactRef } from '@agent-core/persistence';
import type { ToolResultFacts } from './observed-facts.js';
import type { JsonObject, JsonValue } from '@agent-core/json';
import type * as z from 'zod';
import type { ToolCanonicalizationContext, ToolExecutionContext } from './context.js';
import type { ToolObservationPresentation, ToolObservationPresentationRequest } from './observation-presentation.js';
import type { ToolPolicy } from './policy.js';
import type { ToolEffectEnvelope, ToolEffects } from './authorization.js';
import type { EffectExecutionState, EffectResourcePrecondition } from '@agent-core/effects';

declare const ownedToolCall: unique symbol;
declare const ownedToolObservation: unique symbol;
export interface ToolCallInput { readonly id?: string; readonly name: string; readonly input: ToolInput }
export type ToolCall = Readonly<ToolCallInput & { readonly [ownedToolCall]: true }>;
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

interface ToolObservationInputBase {
  summary: string;
  scope: ToolScope;
  content?: readonly ToolContent[];
  metadata?: JsonObject;
  observedFacts?: ToolResultFacts;
}
export interface ToolResultObservationInput<TOutput = unknown> extends ToolObservationInputBase { kind: 'result'; /** A negative domain result is still a completed tool invocation. */ ok: boolean; output: TOutput }
export interface ToolFailureObservationInput<TOutput extends ToolFailureOutput = ToolFailureOutput> extends ToolObservationInputBase { kind: 'failure'; ok: false; output: TOutput }
export type ToolObservationInput<TOutput = unknown> = ToolResultObservationInput<TOutput> | ToolFailureObservationInput;

interface ToolObservationBase {
  readonly [ownedToolObservation]: true;
  readonly summary: string;
  readonly scope: ToolScope;
  readonly content?: readonly ToolContent[];
  readonly metadata?: JsonObject;
  readonly observedFacts?: ToolResultFacts;
}
export interface ToolResultObservation<TOutput = JsonValue> extends ToolObservationBase { readonly kind: 'result'; /** A negative domain result is still a completed tool invocation. */ readonly ok: boolean; readonly output: JsonValue & TOutput }
export interface ToolFailureObservation<TOutput extends ToolFailureOutput = ToolFailureOutput> extends ToolObservationBase { readonly kind: 'failure'; readonly ok: false; readonly output: TOutput }
export type ToolObservation<TOutput = JsonValue> = ToolResultObservation<TOutput> | ToolFailureObservation;

export type ToolEffectRecoveryResult<TOutput = unknown> =
  | { readonly status: 'reexecute'; readonly preconditions: readonly EffectResourcePrecondition[] }
  | { readonly status: 'settled'; readonly observation: ToolObservationInput<TOutput> }
  | { readonly status: 'running' }
  | { readonly status: 'not_found' | 'expired' | 'unavailable' | 'parameter_mismatch'; readonly reason?: string };

export type ToolFailureReason = 'unknown_tool' | 'policy' | 'invalid_arguments' | 'invalid_output' | 'missing_service' | 'runtime_error';
export interface BaseToolFailureOutput { readonly blocked: true; readonly reason: ToolFailureReason; readonly recovery: string }
export interface UnknownToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'unknown_tool'; readonly toolCall: ToolCall }
export interface PolicyToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'policy'; readonly tool?: string; readonly policyReason?: string; readonly details?: JsonObject }
export interface ToolValidationIssue { readonly path: readonly (string | number)[]; readonly code: string; readonly message: string }
export interface ToolValidationIssues { readonly issues: readonly ToolValidationIssue[] }
export interface InvalidArgumentsToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'invalid_arguments'; readonly issues?: ToolValidationIssues; readonly details?: JsonObject }
export interface InvalidOutputToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'invalid_output'; readonly issues: ToolValidationIssues }
export interface MissingServiceDetails { readonly expected?: string; readonly actualType?: string }
export interface MissingServiceToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'missing_service'; readonly service: string; readonly details?: JsonObject }
export interface RuntimeErrorToolFailureOutput extends BaseToolFailureOutput { readonly reason: 'runtime_error'; readonly error: string; readonly details?: JsonObject }
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
  canonicalizeInput(input: TDecodedInput, context: ToolCanonicalizationContext): TCanonicalInput | Promise<TCanonicalInput>;
  snapshotInput(input: TCanonicalInput): JsonValue;
  deriveEffects(input: TCanonicalInput, context: ToolCanonicalizationContext): ToolEffects | Promise<ToolEffects>;
  recover?(input: TCanonicalInput, effect: Extract<EffectExecutionState, { readonly phase: 'started' }>, context: ToolExecutionContext): ToolEffectRecoveryResult<TOutput> | Promise<ToolEffectRecoveryResult<TOutput>>;
  invoke(input: TCanonicalInput, context: ToolExecutionContext): Promise<ToolObservationInput<TOutput>>;
  presentObservation?(request: ToolObservationPresentationRequest<TCanonicalInput, TOutput>): ToolObservationPresentation;
}
