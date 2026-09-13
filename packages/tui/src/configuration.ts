import type { DeviceAuthenticationChallenge } from '@agent-core/auth';
import type {
  ModelCatalogEntry,
  ModelProfile,
  ModelProvider,
  ModelReasoningRequest,
  ModelSelection
} from '@agent-core/model';
import { assertModelRequestSupported } from '@agent-core/model';
import {
  createSearchPickerIndex,
  createSearchPickerState,
  createTextAreaState,
  searchPickerReducer,
  searchPickerView,
  textAreaReducer,
  textInputReducer,
  textInputState,
  type SearchPickerControlTransition,
  type TextAreaState,
  type TextAreaTransition,
  type TextInputTransition,
  type UnscrolledSearchPickerState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  button,
  passwordInput,
  searchPicker,
  text,
  textArea,
  type Element
} from '@ismail-elkorchi/terminal-ui/components';
import { column, flow, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { textDocumentText, type TextEditBuffer } from '@ismail-elkorchi/terminal-ui/text';
import type { TuiEffect } from '@ismail-elkorchi/terminal-ui/tui';
import { copySource } from './copy.js';
import { diagnosticMessage } from './diagnostics.js';
import { panel } from './panel.js';

export interface ConfigurationOperations {
  openBrowser?(url: string, signal: AbortSignal): Promise<void>;
  readonly providers: readonly { readonly id: string; readonly label: string }[];
  connect(provider: string, endpoint?: string): ModelProvider | Promise<ModelProvider>;
  save(selection: ModelSelection, provider: ModelProvider): Promise<void>;
}

export interface ConfigurationState {
  readonly offset: number;
  readonly id: string;
  readonly selection: ModelSelection;
  readonly stage:
    | 'provider'
    | 'model'
    | 'reasoning'
    | 'review'
    | 'custom-model'
    | 'endpoint'
    | 'authentication'
    | 'reasoning-budget'
    | 'reasoning-mode'
    | 'reasoning-summary'
    | 'temperature';
  readonly picker: UnscrolledSearchPickerState;
  readonly input: TextAreaState;
  readonly secret: TextEditBuffer;
  readonly challenge?: DeviceAuthenticationChallenge;
  readonly models: readonly ModelCatalogEntry[];
  readonly adapter?: ModelProvider;
  readonly profile?: ModelProfile;
  readonly pending?: string | undefined;
  readonly error?: string;
  readonly notice?: string;
}

export type ConfigurationMessage =
  | { readonly type: 'configuration.open-browser' }
  | { readonly type: 'configuration.scroll'; readonly offset: number }
  | { readonly type: 'configuration.copy'; readonly target: 'url' | 'code' }
  | { readonly type: 'configuration.notice'; readonly id: string; readonly message: string }
  | {
      readonly type: 'configuration.connected';
      readonly id: string;
      readonly request: string;
      readonly adapter: ModelProvider;
      readonly refresh: boolean;
    }
  | { readonly type: 'configuration.secret'; readonly transition: TextInputTransition }
  | { readonly type: 'configuration.login' | 'configuration.logout' }
  | {
      readonly type: 'configuration.challenge';
      readonly id: string;
      readonly request: string;
      readonly challenge: DeviceAuthenticationChallenge;
    }
  | { readonly type: 'configuration.authenticated'; readonly id: string; readonly request: string }
  | { readonly type: 'configuration.stage'; readonly stage: ConfigurationState['stage'] }
  | { readonly type: 'configuration.pick'; readonly value: string }
  | { readonly type: 'configuration.transition'; readonly transition: SearchPickerControlTransition }
  | { readonly type: 'configuration.edit'; readonly transition: TextAreaTransition }
  | { readonly type: 'configuration.input' }
  | { readonly type: 'configuration.refresh' }
  | { readonly type: 'configuration.save' }
  | { readonly type: 'configuration.saved'; readonly id: string }
  | {
      readonly type: 'configuration.catalog';
      readonly id: string;
      readonly request: string;
      readonly adapter: ModelProvider;
      readonly models: readonly ModelCatalogEntry[];
    }
  | {
      readonly type: 'configuration.profile';
      readonly id: string;
      readonly request: string;
      readonly profile: ModelProfile;
    }
  | {
      readonly type: 'configuration.failed';
      readonly id: string;
      readonly request: string;
      readonly error: string;
    };

export function configurationState(
  selection: ModelSelection | undefined,
  providers: ConfigurationOperations['providers']
): ConfigurationState {
  return {
    id: crypto.randomUUID(),
    offset: 0,
    selection: selection ?? { provider: '', model: '' },
    stage: 'provider',
    picker: createSearchPickerState(
      { query: { text: '', mode: 'fuzzy' } },
      createSearchPickerIndex(providers.map((item) => ({ ...item, value: item.id })))
    ),
    input: createTextAreaState({ value: '' }),
    secret: { text: '', cursor: 0 },
    models: []
  };
}

export function updateConfiguration(
  state: ConfigurationState,
  message: ConfigurationMessage,
  operations: ConfigurationOperations
) {
  let current = state;
  if (
    message.type === 'configuration.stage' ||
    message.type === 'configuration.pick' ||
    message.type === 'configuration.edit' ||
    message.type === 'configuration.input'
  ) {
    const editing = { ...state };
    delete editing.error;
    delete editing.notice;
    current = editing;
  }
  const result = reduceConfiguration(current, message, operations);
  return result.state.stage === state.stage ? result : { ...result, state: { ...result.state, offset: 0 } };
}

function reduceConfiguration(
  state: ConfigurationState,
  message: ConfigurationMessage,
  operations: ConfigurationOperations
): {
  readonly state: ConfigurationState;
  readonly effects?: readonly TuiEffect<ConfigurationMessage>[];
  readonly cancelEffects?: readonly string[];
} {
  if ('id' in message && message.id !== state.id) return { state };
  if ('request' in message && message.request !== state.pending) return { state };
  switch (message.type) {
    case 'configuration.scroll':
      return { state: { ...state, offset: message.offset } };
    case 'configuration.notice':
      return { state: { ...state, notice: message.message } };
    case 'configuration.open-browser': {
      const challenge = state.challenge;
      const open = operations.openBrowser?.bind(operations);
      if (challenge === undefined || open === undefined) return { state };
      return {
        state,
        effects: [
          {
            id: 'configuration-browser',
            concurrency: 'keep-first',
            async run({ signal }) {
              await open(challenge.url, signal);
              return {
                kind: 'message',
                message: {
                  type: 'configuration.notice',
                  id: state.id,
                  message: 'Sign-in page opened in your browser.'
                }
              };
            },
            onError: ({ diagnostic }) => ({
              kind: 'message',
              message: {
                type: 'configuration.notice',
                id: state.id,
                message: diagnosticMessage(diagnostic)
              }
            })
          }
        ]
      };
    }
    case 'configuration.copy': {
      const value = state.challenge?.[message.target];
      return value === undefined
        ? { state }
        : {
            state,
            effects: [
              copySource(value, (message) => ({ type: 'configuration.notice', id: state.id, message }))
            ]
          };
    }
    case 'configuration.secret':
      return { state: { ...state, secret: textInputReducer(state.secret, message.transition) } };
    case 'configuration.login': {
      const authentication = state.adapter?.authentication?.();
      if (authentication === undefined) return { state };
      if (authentication.kind === 'api_key')
        return operation(state, async (request, signal) => {
          await authentication.save(state.secret.text, signal);
          return { type: 'configuration.authenticated', id: state.id, request };
        });
      return operation(state, async (request, signal) => ({
        type: 'configuration.challenge',
        id: state.id,
        request,
        challenge: await authentication.begin(signal)
      }));
    }
    case 'configuration.logout': {
      const authentication = state.adapter?.authentication?.();
      if (authentication === undefined) return { state };
      return operation(state, async (request) => {
        await authentication.logout();
        return { type: 'configuration.authenticated', id: state.id, request };
      });
    }
    case 'configuration.challenge':
      return operation({ ...state, challenge: message.challenge }, async (request, signal) => {
        await message.challenge.complete(signal);
        return { type: 'configuration.authenticated', id: state.id, request };
      });
    case 'configuration.authenticated': {
      const next = { ...state, secret: { text: '', cursor: 0 }, stage: 'model' as const };
      delete next.challenge;
      return discover(next, operations, true);
    }
    case 'configuration.connected':
      return operation({ ...state, adapter: message.adapter }, async (request, signal) => ({
        type: 'configuration.catalog',
        id: state.id,
        request,
        adapter: message.adapter,
        models: (await message.adapter.listModels?.({ signal, refresh: message.refresh })) ?? []
      }));
    case 'configuration.stage': {
      const next = { ...state, stage: message.stage, pending: undefined };
      return {
        state: {
          ...next,
          picker: createSearchPickerState(
            { query: { text: '', mode: 'fuzzy' } },
            configurationIndex(next, operations)
          ),
          input: createTextAreaState({
            value:
              message.stage === 'temperature'
                ? state.selection.temperature === undefined
                  ? ''
                  : String(state.selection.temperature)
                : message.stage === 'endpoint'
                  ? (state.selection.endpoint ?? '')
                  : message.stage === 'reasoning-budget'
                    ? state.selection.reasoning?.strategy === 'budget'
                      ? String(state.selection.reasoning.maxTokens)
                      : ''
                    : state.selection.model
          })
        },
        cancelEffects: ['model-configuration']
      };
    }
    case 'configuration.transition':
      return {
        state: {
          ...state,
          picker: searchPickerReducer(state.picker, message.transition, {
            searchPickerIndex: configurationIndex(state, operations)
          })
        }
      };
    case 'configuration.edit':
      return { state: { ...state, input: textAreaReducer(state.input, message.transition).state } };
    case 'configuration.refresh':
      return discover(state, operations, true);
    case 'configuration.pick': {
      if (state.stage === 'provider') {
        const same = state.selection.provider === message.value;
        return discover(
          {
            ...state,
            selection: same ? state.selection : { provider: message.value, model: '' },
            models: [],
            stage: 'model',
            picker: createSearchPickerState(
              { query: { text: '', mode: 'fuzzy' } },
              createSearchPickerIndex([])
            )
          },
          operations
        );
      }
      if (state.stage === 'reasoning-mode' || state.stage === 'reasoning-summary') {
        const reasoning = state.selection.reasoning;
        if (reasoning === undefined || reasoning.strategy === 'disabled') return { state };
        if (state.stage === 'reasoning-mode') {
          if (reasoning.strategy !== 'effort') return { state };
          const mode = state.profile?.capabilities.reasoning?.modes?.find((mode) => mode === message.value);
          const next = { ...reasoning };
          delete next.mode;
          return {
            state: {
              ...state,
              stage: 'review',
              selection: {
                ...state.selection,
                reasoning: { ...next, ...(mode === undefined ? {} : { mode }) }
              }
            }
          };
        }
        const summary = state.profile?.capabilities.reasoning?.summaries?.find(
          (summary) => summary === message.value
        );
        const next = { ...reasoning };
        delete next.summary;
        return {
          state: {
            ...state,
            stage: 'review',
            selection: {
              ...state.selection,
              reasoning: { ...next, ...(summary === undefined ? {} : { summary }) }
            }
          }
        };
      }
      if (state.stage === 'reasoning') {
        if (message.value === 'budget')
          return updateConfiguration(
            state,
            { type: 'configuration.stage', stage: 'reasoning-budget' },
            operations
          );
        const selection = { ...state.selection };
        delete selection.reasoning;
        const choice = reasoningChoices(state.profile).find((item) => item.id === message.value);
        if (choice === undefined) return { state };
        return {
          state: {
            ...state,
            selection: {
              ...selection,
              ...(choice.value === undefined
                ? {}
                : { reasoning: retainReasoningOptions(choice.value, state.selection.reasoning) })
            },
            stage: 'review'
          }
        };
      }
      return describe({ ...state, selection: { ...state.selection, model: message.value } });
    }
    case 'configuration.input': {
      const value = textDocumentText(state.input.document).trim();
      if (state.stage === 'temperature') {
        const temperature = Number(value);
        if (value && !Number.isFinite(temperature))
          return {
            state: {
              ...state,
              error: 'Temperature must be a finite number, or empty for the provider default.'
            }
          };
        const selection = { ...state.selection };
        delete selection.temperature;
        return {
          state: {
            ...state,
            stage: 'review',
            selection: { ...selection, ...(value ? { temperature } : {}) }
          }
        };
      }
      if (state.stage === 'reasoning-budget') {
        const maxTokens = Number(value);
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
          return { state: { ...state, error: 'Enter a positive whole number of reasoning tokens.' } };
        return {
          state: {
            ...state,
            stage: 'review',
            selection: {
              ...state.selection,
              reasoning: retainReasoningOptions(
                { strategy: 'budget', maxTokens },
                state.selection.reasoning
              )
            }
          }
        };
      }
      if (state.stage === 'endpoint') {
        const selection = { ...state.selection };
        delete selection.endpoint;
        return discover(
          {
            ...state,
            selection: { ...selection, ...(value ? { endpoint: value } : {}) },
            models: [],
            stage: 'model'
          },
          operations
        );
      }
      return describe({ ...state, selection: { ...state.selection, model: value } });
    }
    case 'configuration.catalog':
      return {
        state: {
          ...state,
          pending: undefined,
          adapter: message.adapter,
          models: message.models,
          picker: searchPickerReducer(
            state.picker,
            {
              kind: 'setActive',
              ...(message.models[0] === undefined
                ? {}
                : {
                    id:
                      message.models.find((model) => model.id === searchPickerView(state.picker).activeId)
                        ?.id ??
                      message.models.find((model) => model.id === state.selection.model)?.id ??
                      message.models[0].id
                  })
            },
            { searchPickerIndex: configurationIndex({ ...state, models: message.models }, operations) }
          )
        }
      };
    case 'configuration.profile': {
      const next = { ...state, pending: undefined, profile: message.profile, stage: 'review' as const };
      try {
        assertModelRequestSupported(message.profile, {
          model: state.selection.model,
          messages: [],
          ...(state.selection.reasoning === undefined ? {} : { reasoning: state.selection.reasoning }),
          ...(state.selection.temperature === undefined ? {} : { temperature: state.selection.temperature })
        });
        return { state: next };
      } catch (error) {
        return { state: { ...next, error: error instanceof Error ? error.message : String(error) } };
      }
    }
    case 'configuration.failed':
      return { state: { ...state, pending: undefined, error: message.error } };
    case 'configuration.save': {
      const adapter = state.adapter;
      const profile = state.profile;
      if (adapter === undefined || profile?.id !== state.selection.model || state.pending !== undefined)
        return { state };
      return operation(state, async () => {
        assertModelRequestSupported(profile, {
          model: state.selection.model,
          messages: [],
          ...(state.selection.reasoning === undefined ? {} : { reasoning: state.selection.reasoning }),
          ...(state.selection.temperature === undefined ? {} : { temperature: state.selection.temperature })
        });
        await operations.save(state.selection, adapter);
        return { type: 'configuration.saved', id: state.id };
      });
    }
    case 'configuration.saved':
      return { state };
  }
}

function discover(state: ConfigurationState, operations: ConfigurationOperations, refresh = false) {
  const next = { ...state };
  delete next.adapter;
  delete next.profile;
  delete next.challenge;
  return operation(next, async (request, signal) => {
    const adapter = await operations.connect(state.selection.provider, state.selection.endpoint);
    signal.throwIfAborted();
    return { type: 'configuration.connected', id: state.id, request, adapter, refresh };
  });
}

function describe(state: ConfigurationState) {
  const adapter = state.adapter;
  if (adapter === undefined || !state.selection.model) return { state };
  return operation(state, async (request) => ({
    type: 'configuration.profile',
    id: state.id,
    request,
    profile: await adapter.describeModel(state.selection.model)
  }));
}

function operation(
  state: ConfigurationState,
  run: (request: string, signal: AbortSignal) => Promise<ConfigurationMessage>
) {
  const request = crypto.randomUUID();
  const current = { ...state };
  delete current.error;
  delete current.notice;
  return {
    state: { ...current, pending: request },
    effects: [
      {
        id: 'model-configuration',
        concurrency: 'replace',
        async run(context) {
          return { kind: 'message', message: await run(request, context.signal) };
        },
        onError: ({ diagnostic }) => ({
          kind: 'message',
          message: {
            type: 'configuration.failed',
            id: state.id,
            request,
            error: diagnosticMessage(diagnostic)
          }
        })
      } satisfies TuiEffect<ConfigurationMessage>
    ]
  };
}

function reasoningChoices(
  profile?: ModelProfile
): readonly { readonly id: string; readonly label: string; readonly value?: ModelReasoningRequest }[] {
  const reasoning = profile?.capabilities.reasoning;
  return [
    { id: 'default', label: 'Provider default' },
    ...(reasoning?.canDisable
      ? [{ id: 'disabled', label: 'Disabled', value: { strategy: 'disabled' as const } }]
      : []),
    ...(reasoning?.strategies.includes('effort')
      ? (reasoning.efforts ?? []).flatMap((effort) =>
          effort === 'none'
            ? []
            : [{ id: effort, label: effort, value: { strategy: 'effort' as const, effort } }]
        )
      : []),
    ...(reasoning?.strategies.includes('budget')
      ? [{ id: 'budget', label: 'Reasoning token budget…' }]
      : []),
    ...(reasoning?.strategies.includes('toggle')
      ? [{ id: 'enabled', label: 'Enabled', value: { strategy: 'enabled' as const } }]
      : [])
  ];
}

function configurationIndex(state: ConfigurationState, operations: ConfigurationOperations) {
  const items =
    state.stage === 'provider'
      ? operations.providers
      : state.stage === 'reasoning-mode' || state.stage === 'reasoning-summary'
        ? [
            { id: 'default', label: 'Provider default' },
            ...(state.stage === 'reasoning-mode'
              ? (state.profile?.capabilities.reasoning?.modes ?? [])
              : (state.profile?.capabilities.reasoning?.summaries ?? [])
            ).map((id) => ({ id, label: id }))
          ]
        : state.stage === 'reasoning'
          ? reasoningChoices(state.profile)
          : state.models.map((model) => ({
              id: model.id,
              label: `${model.id === state.selection.model ? '✓ ' : ''}${model.displayName ?? model.id}`,
              description: model.unavailableReason ?? model.description ?? model.id,
              disabled: model.unavailableReason !== undefined
            }));
  return createSearchPickerIndex(items.map((item) => ({ ...item, value: item.id })));
}

export function configurationView(
  state: ConfigurationState,
  operations: ConfigurationOperations,
  width: number,
  height: number
): Element<ConfigurationMessage | { readonly type: 'overlay.close' }> {
  type Message = ConfigurationMessage | { readonly type: 'overlay.close' };
  const action = (id: string, label: string, message: Message) =>
    button({ id, label, onPress: () => message });
  const editing =
    state.stage === 'custom-model' ||
    state.stage === 'endpoint' ||
    state.stage === 'reasoning-budget' ||
    state.stage === 'temperature';
  const choices =
    state.stage === 'provider' ||
    state.stage === 'model' ||
    state.stage === 'reasoning' ||
    state.stage === 'reasoning-mode' ||
    state.stage === 'reasoning-summary';
  const authentication = state.adapter?.authentication?.();
  const content: Element<Message> =
    state.stage === 'authentication'
      ? column([
          text({
            content:
              authentication?.kind === 'api_key'
                ? authentication.externalSource === undefined
                  ? 'API key · stored in the credential store'
                  : `${authentication.externalSource} takes precedence. Logout removes stored credentials only.`
                : state.challenge === undefined
                  ? 'Start device login to receive a verification link and code.'
                  : `Open ${state.challenge.url}\nCode: ${state.challenge.code}\nWaiting for authorization…`
          }),
          ...(authentication?.kind === 'api_key'
            ? [
                passwordInput<Message>({
                  id: 'configuration-secret',
                  state: textInputState(state.secret),
                  onTransition: (transition) => ({ type: 'configuration.secret', transition })
                })
              ]
            : []),
          action('configuration-login', 'Sign in', { type: 'configuration.login' }),
          ...(state.challenge === undefined
            ? []
            : [
                ...(operations.openBrowser === undefined
                  ? [
                      text({
                        content: 'Browser launch is unavailable; copy the link to open it elsewhere.'
                      })
                    ]
                  : [
                      action('configuration-open-browser', 'Open in browser', {
                        type: 'configuration.open-browser'
                      })
                    ]),
                action('configuration-copy-url', 'Copy sign-in link', {
                  type: 'configuration.copy',
                  target: 'url'
                }),
                action('configuration-copy-code', 'Copy code', {
                  type: 'configuration.copy',
                  target: 'code'
                })
              ]),
          action('configuration-logout', 'Log out stored credentials', { type: 'configuration.logout' })
        ])
      : editing
        ? column([
            text({
              content:
                state.stage === 'temperature'
                  ? 'Temperature · leave empty for the provider default'
                  : state.stage === 'endpoint'
                    ? 'Endpoint URL · leave empty for the provider default'
                    : state.stage === 'reasoning-budget'
                      ? 'Maximum reasoning tokens'
                      : 'Exact model ID'
            }),
            textArea({
              id: 'configuration-input',
              state: state.input,
              meta: { accessibleName: state.stage },
              onTransition: (transition: TextAreaTransition): Message => ({
                type: 'configuration.edit',
                transition
              })
            }),
            action('configuration-use-input', 'Continue', { type: 'configuration.input' })
          ])
        : choices
          ? searchPicker<string, Message, Message>({
              id: 'configuration-picker',
              title: `Choose ${state.stage}`,
              view: searchPickerView(state.picker),
              searchPickerIndex: configurationIndex(state, operations),
              maxVisible: Math.max(1, height - 7),
              emptyText:
                state.pending === undefined
                  ? 'No choices available. Refresh or enter a model ID.'
                  : 'Discovering available models…',
              onTransition: (transition: SearchPickerControlTransition): Message => ({
                type: 'configuration.transition',
                transition
              }),
              onAccept: (event): Message => ({ type: 'configuration.pick', value: event.id })
            })
          : column([
              text({
                content: `${state.selection.provider} · ${state.selection.model}\nEndpoint: ${state.selection.endpoint ?? 'provider default'}\nReasoning: ${state.selection.reasoning === undefined ? 'provider default' : JSON.stringify(state.selection.reasoning)}\nTemperature: ${state.selection.temperature === undefined ? 'provider default' : String(state.selection.temperature)}\nSave changes this session and the default for new sessions. Accepted work retains its recorded configuration.`
              }),
              flow(
                [
                  action('configuration-model', 'Model', { type: 'configuration.stage', stage: 'model' }),
                  action('configuration-reasoning', 'Reasoning', {
                    type: 'configuration.stage',
                    stage: 'reasoning'
                  }),
                  ...(state.profile?.capabilities.temperature
                    ? [
                        action('configuration-temperature', 'Temperature', {
                          type: 'configuration.stage',
                          stage: 'temperature'
                        })
                      ]
                    : []),
                  button({
                    id: 'configuration-save',
                    label: 'Save',
                    ...(state.pending === undefined
                      ? { onPress: (): Message => ({ type: 'configuration.save' }) }
                      : { disabled: true })
                  })
                ],
                { direction: 'horizontal' }
              ),
              ...(state.selection.reasoning?.strategy === 'effort' &&
              state.profile?.capabilities.reasoning?.modes?.length
                ? [
                    action('configuration-mode', 'Reasoning mode', {
                      type: 'configuration.stage',
                      stage: 'reasoning-mode'
                    })
                  ]
                : []),
              ...(state.selection.reasoning !== undefined &&
              state.selection.reasoning.strategy !== 'disabled' &&
              state.profile?.capabilities.reasoning?.summaries?.length
                ? [
                    action('configuration-summary', 'Reasoning summary', {
                      type: 'configuration.stage',
                      stage: 'reasoning-summary'
                    })
                  ]
                : [])
            ]);
  return panel({
    id: 'configuration',
    title: 'Model configuration',
    width,
    height,
    focusId:
      state.stage === 'authentication'
        ? authentication?.kind === 'api_key'
          ? 'configuration-secret'
          : 'configuration-login'
        : editing
          ? 'configuration-input'
          : choices
            ? 'configuration-picker'
            : 'configuration-save',
    onClose: (): Message => ({ type: 'overlay.close' }),
    slots: {
      content: column(
        [
          viewport(content, {
            id: 'configuration-content',
            offset: { row: state.offset },
            scrollbar: { axis: 'vertical', visible: 'auto' },
            onScroll: (request): Message => ({
              type: 'configuration.scroll',
              offset: request.nextState.offsetRow
            })
          }),
          text({ content: state.error ?? state.notice ?? (state.pending === undefined ? '' : 'Working…') })
        ],
        { sizes: [{ kind: 'fill' }, { kind: 'fixed', cells: 2 }] }
      ),
      actions: flow(
        [
          ...(authentication === undefined
            ? []
            : [
                action('configuration-auth', 'Account', {
                  type: 'configuration.stage',
                  stage: 'authentication'
                })
              ]),
          action('configuration-providers', 'Provider', { type: 'configuration.stage', stage: 'provider' }),
          ...(state.selection.provider
            ? [
                action('configuration-refresh', 'Refresh', { type: 'configuration.refresh' }),
                action('configuration-custom', 'Model ID', {
                  type: 'configuration.stage',
                  stage: 'custom-model'
                }),
                action('configuration-endpoint', 'Endpoint', {
                  type: 'configuration.stage',
                  stage: 'endpoint'
                })
              ]
            : [])
        ],
        { direction: 'horizontal' }
      )
    }
  });
}

function retainReasoningOptions(
  next: ModelReasoningRequest,
  previous: ModelReasoningRequest | undefined
): ModelReasoningRequest {
  if (next.strategy === 'disabled' || previous === undefined || previous.strategy === 'disabled')
    return next;
  return {
    ...next,
    ...(previous.summary === undefined ? {} : { summary: previous.summary }),
    ...(next.strategy === 'effort' && previous.strategy === 'effort' && previous.mode !== undefined
      ? { mode: previous.mode }
      : {})
  };
}
