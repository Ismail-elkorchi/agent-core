# @agent-core/provider-claude

Native Claude Messages reference adapter. It implements `complete`, `stream`, immutable `compileRequest`, and session compiled invocation using the public `@agent-core/model` contracts.

```ts
import { ClaudeProvider } from '@agent-core/provider-claude';

const provider = new ClaudeProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  countTokens: true
});
const response = await provider.complete({
  model: 'claude-sonnet-4-6',
  maxOutputTokens: 512,
  messages: [{ role: 'user', content: 'Explain the result.' }]
});
```

Credentials and endpoint configuration belong to the application. The adapter does not inspect environment variables or credential files. `auth` accepts a host-supplied token capability. System instructions use the native system channel. Developer instructions are rejected because this Messages adapter cannot preserve that distinct authority level.

Text, images, PDF documents, JSON tools, refusal/partial output, cache usage and manual thinking budgets are supported. Thinking and redacted-thinking blocks stay in typed protocol output, including exact signatures and original order. Use `modelOutputToInput(response.output)` for replay; display reasoning summaries never substitute for protocol state. Earlier input changes, endpoint/model switches, malformed blocks and unknown required content kinds fail explicitly. Binary convenience input becomes owned base64 so persisted JSON retains media.

`claude-sonnet-4-6` is the only built-in reference model; other models require explicit verified `modelProfiles`. No availability or performance claim is made for Fable/Mythos or other untested models. The reference profile publishes no unverified capacity or price numbers. Native steering, async tools, server tools, adaptive thinking and native context editing are not implemented or advertised.

`countTokens: true` invokes the bounded, cancellable `/messages/count_tokens` endpoint during compilation. `maxConcurrentCounts` defaults to two and rejects excess work without recursive inference or automatic retries. Provider counts replace heuristic components; cached input still occupies context. Counting and invocation share the supplied cancellation signal. Hosts must budget and govern counting requests as part of admission. Without provider counting, opaque thinking and unmeasured media retain explicit unknown token cost and require a host admission allowance.

Protocol fixture sources, checked 2026-09-07:

- [Messages reference](https://platform.claude.com/docs/en/api/messages/create)
- [Thinking preservation and signatures](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Extended thinking streaming](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)

Deterministic tests cover signatures, redaction, deltas, endpoint/prefix rejection, missing terminal events, counting, usage and shared provider conformance. Live model/account access was not exercised.

Claude requires an explicit request `maxOutputTokens` or compilation `outputReservation`; the adapter has no generation allowance default.
