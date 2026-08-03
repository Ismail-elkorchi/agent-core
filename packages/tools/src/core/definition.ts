import type { ArtifactRef, ToolEvidenceDelta } from '@agent-core/evidence';
import type { ToolExecutionContext, ToolPreparationContext } from './context.js';
import type { ToolObservationPresentation, ToolObservationPresentationRequest } from './observation-presentation.js';
import type { ToolPolicy, ToolRisk } from './policy.js';
import type { ToolEffects } from './authorization.js';

export interface ToolCall {
  id?: string;
  name: string;
  input: ToolInput;
}

export type ToolInput =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export type ToolTextInputFormat =
  | { type: 'text' }
  | { type: 'grammar'; syntax: string; definition: string };

export interface ToolPromptGuideRequest {
  inputFormat: string;
  services?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type ToolPromptGuide = string | ((request: ToolPromptGuideRequest) => string | undefined);

export interface ToolTextInputDefinition<TInput = unknown> {
  format: ToolTextInputFormat;
  description?: string;
  promptGuide?: ToolPromptGuide;
  decode(text: string): TInput;
}

export type ToolInputParseResult<TInput> =
  | { ok: true; input: TInput }
  | { ok: false; observation: ToolFailureObservation<InvalidArgumentsToolFailureOutput> };

export interface ToolResultObservation<TOutput = unknown> {
  kind: 'result';
  /** Whether the completed tool operation achieved its requested outcome. */
  ok: boolean;
  output: TOutput;
  summary: string;
  artifacts?: ArtifactRef[];
  metadata?: Record<string, unknown>;
  evidence?: ToolEvidenceDelta;
}

export type ToolFailureReason =
  | 'unknown_tool'
  | 'policy'
  | 'invalid_arguments'
  | 'missing_service'
  | 'runtime_error';

export interface BaseToolFailureOutput {
  blocked: true;
  reason: ToolFailureReason;
  recovery: string;
}

export interface UnknownToolFailureOutput extends BaseToolFailureOutput {
  reason: 'unknown_tool';
  toolCall: ToolCall;
}

export interface PolicyToolFailureOutput extends BaseToolFailureOutput {
  reason: 'policy';
  tool?: string;
  risk?: ToolRisk;
  policyReason?: string;
  details?: Record<string, unknown>;
}

export interface ToolValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export interface ToolValidationIssues {
  issues: ToolValidationIssue[];
}

export interface InvalidArgumentsToolFailureOutput extends BaseToolFailureOutput {
  reason: 'invalid_arguments';
  issues?: ToolValidationIssues;
  details?: Record<string, unknown>;
}

export interface MissingServiceDetails {
  expected?: string;
  actualType?: string;
}

export interface MissingServiceToolFailureOutput extends BaseToolFailureOutput {
  reason: 'missing_service';
  service: string;
  details?: MissingServiceDetails;
}

export interface RuntimeErrorToolFailureOutput extends BaseToolFailureOutput {
  reason: 'runtime_error';
  error: string;
  details?: Record<string, unknown>;
}

export type ToolFailureOutput =
  | UnknownToolFailureOutput
  | PolicyToolFailureOutput
  | InvalidArgumentsToolFailureOutput
  | MissingServiceToolFailureOutput
  | RuntimeErrorToolFailureOutput;

export interface ToolFailureObservation<TOutput extends ToolFailureOutput = ToolFailureOutput> {
  kind: 'failure';
  ok: false;
  output: TOutput;
  summary: string;
  artifacts?: ArtifactRef[];
  metadata?: Record<string, unknown>;
  evidence?: ToolEvidenceDelta;
}

export type ToolObservation<TOutput = unknown> = ToolResultObservation<TOutput> | ToolFailureObservation;

export interface ToolDefinition<TDecodedInput = unknown, TCanonicalInput = TDecodedInput, TOutput = unknown> {
  name: string;
  implementationId: string;
  description: string;
  promptGuide?: ToolPromptGuide;
  jsonSchema: Record<string, unknown>;
  textInput?: ToolTextInputDefinition<TDecodedInput>;
  risk: ToolRisk;
  declaredEffects: ToolEffects;
  isAvailable?: (policy: ToolPolicy) => boolean;
  decodeInput(input: ToolInput): ToolInputParseResult<TDecodedInput>;
  canonicalizeInput(input: TDecodedInput, context: ToolPreparationContext): TCanonicalInput | Promise<TCanonicalInput>;
  deriveEffects(input: TCanonicalInput, context: ToolPreparationContext): ToolEffects | Promise<ToolEffects>;
  invoke(input: TCanonicalInput, context: ToolExecutionContext): Promise<ToolObservation<TOutput>>;
  presentObservation?(request: ToolObservationPresentationRequest<TCanonicalInput, TOutput>): ToolObservationPresentation;
}
