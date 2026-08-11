import * as z from 'zod';
import type { ToolExecutionContext, ToolPreparationContext } from './context.js';
import type { ToolDefinition, ToolInput, ToolObservation, ToolPromptGuide, ToolRequirements, ToolTextInputDefinition } from './definition.js';
import type { ToolObservationPresentation, ToolObservationPresentationRequest } from './observation-presentation.js';
import type { ToolPolicy } from './policy.js';
import { invalidArgumentsObservation, invalidToolInputObservation } from './observation.js';
import type { ToolEffectEnvelope, ToolEffects } from './authorization.js';

export interface DefineToolOptions<Schema extends z.ZodType, TCanonicalInput, TOutput> {
  name: string;
  implementationId: string;
  description: string;
  promptGuide?: ToolPromptGuide;
  schema: Schema;
  outputSchema: z.ZodType<TOutput>;
  textInput?: Omit<ToolTextInputDefinition<z.output<Schema>>, 'decode'> & {
    decode(text: string): z.input<Schema>;
  };
  effectEnvelope: ToolEffectEnvelope;
  requirements?: ToolRequirements;
  canonicalizeInput: (input: z.output<Schema>, context: ToolPreparationContext) => TCanonicalInput | Promise<TCanonicalInput>;
  deriveEffects: (input: TCanonicalInput, context: ToolPreparationContext) => ToolEffects | Promise<ToolEffects>;
  isAvailable?: (policy: ToolPolicy) => boolean;
  invoke: (input: TCanonicalInput, context: ToolExecutionContext) => Promise<ToolObservation<TOutput>>;
  presentObservation?: (request: ToolObservationPresentationRequest<TCanonicalInput, TOutput>) => ToolObservationPresentation;
}

export function defineTool<Schema extends z.ZodType, TCanonicalInput, TOutput>(
  definition: DefineToolOptions<Schema, TCanonicalInput, TOutput>
): ToolDefinition<z.output<Schema>, TCanonicalInput, TOutput> {
  const textInput: ToolTextInputDefinition<z.output<Schema>> | undefined = definition.textInput
    ? {
      format: definition.textInput.format,
      ...(definition.textInput.description ? { description: definition.textInput.description } : {}),
      ...(definition.textInput.promptGuide ? { promptGuide: definition.textInput.promptGuide } : {}),
      decode(text) {
        return definition.schema.parse(definition.textInput?.decode(text));
      }
    }
    : undefined;
  const tool: ToolDefinition<z.output<Schema>, TCanonicalInput, TOutput> = {
    name: definition.name,
    implementationId: definition.implementationId,
    description: definition.description,
    ...(definition.promptGuide ? { promptGuide: definition.promptGuide } : {}),
    jsonSchema: toToolJsonSchema(definition.schema),
    outputSchema: definition.outputSchema,
    ...(textInput ? { textInput } : {}),
    effectEnvelope: definition.effectEnvelope,
    ...(definition.requirements ? { requirements: definition.requirements } : {}),
    ...(definition.isAvailable ? { isAvailable: definition.isAvailable } : {}),
    ...(definition.presentObservation ? { presentObservation: definition.presentObservation } : {}),
    decodeInput(input: ToolInput) {
      let candidate: unknown;
      if (input.kind === 'json') {
        candidate = input.value;
      } else if (definition.textInput) {
        try {
          candidate = definition.textInput.decode(input.value);
        } catch (error) {
          return {
            ok: false,
            observation: invalidToolInputObservation(definition.name, error instanceof Error ? error.message : String(error), {
              inputKind: input.kind
            })
          };
        }
      } else {
        return {
          ok: false,
          observation: invalidToolInputObservation(definition.name, 'This tool does not accept freeform text input.', {
            inputKind: input.kind,
            expectedInputKind: 'json'
          })
        };
      }
      const parsed = definition.schema.safeParse(candidate);
      if (!parsed.success) {
        return { ok: false, observation: invalidArgumentsObservation(definition.name, parsed.error) };
      }
      return { ok: true, input: parsed.data };
    },
    canonicalizeInput: definition.canonicalizeInput,
    deriveEffects: definition.deriveEffects,
    invoke: definition.invoke
  };
  return Object.freeze(tool);
}

function toToolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const normalized = normalizeJsonSchema(z.toJSONSchema(schema));
  if (!isJsonObject(normalized)) throw new Error('Tool schema conversion did not produce a JSON object.');
  const jsonSchema = normalized;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonSchema);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJsonSchema(item)]));
  const properties = normalized.properties;
  if (isJsonObject(properties) && Array.isArray(normalized.required)) {
    const required = normalized.required.filter((item): item is string => {
      return typeof item === 'string' && !hasDefault(properties[item]);
    });
    if (required.length > 0) {
      normalized.required = required;
    } else {
      delete normalized.required;
    }
  }
  return normalized;
}

function hasDefault(value: unknown): boolean {
  return isJsonObject(value) && Object.prototype.hasOwnProperty.call(value, 'default');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
