import { assertModelRequestSupported, parseModelProfile, parseModelSelection, type ModelProfile, type ModelProvider, type ModelSelection } from '@agent-core/model';
import { hashJson } from '@agent-core/persistence';
import { InferenceService, type InferenceServiceOptions } from '../inference/service.js';
import type { SessionSubmissionConfiguration, SessionSubmissionInput } from './contracts.js';
import { assertSessionImagesSupported } from './images.js';

export interface SessionProviderBindingOptions extends Omit<InferenceServiceOptions, 'provider'> {
  readonly provider: ModelProvider;
  readonly selection: ModelSelection;
  /** Resolve credentials and transport for this exact complete selection. */
  readonly resolveProvider?: (selection: ModelSelection) => ModelProvider | Promise<ModelProvider>;
}

export interface SessionProviderResolution {
  readonly selection: ModelSelection;
  readonly bindingId: string;
  readonly provider: ModelProvider;
  readonly inference: InferenceService;
  readonly profile: ModelProfile;
}

/** Transport and governed inference move together, only after complete validation. */
export class SessionProviderBinding {
  private binding: Omit<SessionProviderResolution, 'profile'> & { readonly profile?: ModelProfile };
  private readonly resolutions = new WeakSet<SessionProviderResolution>();

  constructor(private readonly options: SessionProviderBindingOptions) {
    const selection = parseModelSelection(options.selection);
    if (options.provider.id !== selection.provider)
      throw new Error('The provider does not match the session configuration.');
    this.binding = Object.freeze({ selection, bindingId: hashJson(selection), provider: options.provider,
      inference: new InferenceService({ ...options, provider: options.provider }) });
  }

  get bindingId(): string { return this.binding.bindingId; }
  get provider(): ModelProvider { return this.binding.provider; }
  get inference(): InferenceService { return this.binding.inference; }
  get profile(): ModelProfile | undefined { return this.binding.profile; }

  async resolve(
    configuration: SessionSubmissionConfiguration,
    input?: SessionSubmissionInput,
    adapter?: ModelProvider
  ): Promise<SessionProviderResolution> {
    const { responseFormat: ignored, ...settings } = configuration;
    void ignored;
    const selection = parseModelSelection(settings);
    const same = hashJson(selection) === hashJson(this.binding.selection);
    const provider = adapter ?? (same ? this.binding.provider : await this.options.resolveProvider?.(selection));
    if (!provider)
      throw new Error('Session model configuration changed in another client. Select the model again before submitting.');
    if (provider.id !== selection.provider)
      throw new Error('The resolved provider does not match the session configuration.');
    const profile = parseModelProfile(await provider.describeModel(selection.model));
    if (profile.provider !== selection.provider || profile.id !== selection.model)
      throw new Error('The resolved model profile does not match the session configuration.');
    assertModelRequestSupported(profile, { model: selection.model, messages: [],
      ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
      ...(selection.temperature === undefined ? {} : { temperature: selection.temperature }),
      ...(configuration.responseFormat === undefined ? {} : { responseFormat: configuration.responseFormat }) });
    if (input?.images?.length) assertSessionImagesSupported(input.images, profile);
    const inference = same && provider === this.binding.provider ? this.binding.inference
      : new InferenceService({ ...this.options, provider });
    const resolution = Object.freeze({ selection, bindingId: hashJson(selection), provider, inference, profile });
    this.resolutions.add(resolution);
    return resolution;
  }

  /** Called by the serialized session lifecycle after its durable boundary succeeds. */
  commit(resolution: SessionProviderResolution): void {
    if (!this.resolutions.delete(resolution)) throw new Error('Provider resolution does not belong to this session binding.');
    this.binding = resolution;
  }
}
