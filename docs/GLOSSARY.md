# Domain glossary

These terms are part of Agent Core's public and persisted contract. New APIs,
events, state fields, and documentation use them consistently.

| Term | Meaning |
| --- | --- |
| **run** | One admitted agent execution from task input to suspension or finalization. Core does not call this an operation. |
| **model output** | Content returned by a model invocation. `candidate` is not a Core synonym. |
| **model window** | The bounded, causally ordered messages submitted for one active run window. |
| **prompt material** | Typed application or runtime material available to the request assembler. |
| **logical model request** | Provider-neutral request assembled by Core before wire serialization. |
| **request fingerprint** | Stable identity of the logical request and the inputs that produced it. It is not proof of provider-visible bytes. |
| **observation** | A tool or effect result recorded in the run log. |
| **observed fact** | A bounded, normalized fact derived from an observation for persistence or later selection. |
| **plan** | A fully specified proposed effect that has not crossed its authorization or start boundary. |
| **authorization** | Host-owned authority to perform a bounded effect. |
| **staged** | Durable local state awaiting a later commit, application, or publication boundary. |
| **snapshot** | An immutable capture of state at a named boundary, such as a pre-change workspace snapshot. It is not a synonym for request, view, or summary. |
| **receipt** | An immutable acknowledgement from a durability or authority boundary. Selection records, prompt bundles, and ordinary return values are not receipts. |
| **run finalization** | Durable settlement of the run result and its session record. |
| **verification** | A production check that can affect acceptance. `evaluation` is reserved for offline product or model measurement. |
| **working copy** | Coding Agent's isolated mutable workspace. This is application-owned, not a Core candidate. |
| **evidence** | Writing-domain material that supports or contradicts a claim. Core tool results are observations or observed facts, not evidence. |

## Prohibited contract vocabulary

Do not introduce persisted or public names using:

- `projection` for assembly, selection, recording, delivery, or finalization;
- `candidate` without an application-qualified domain meaning;
- `prepare` or `prepared` when the actual state is planned, authorized, staged,
  normalized, admitted, or assembled;
- `evaluation` for production verification.

An adapter may retain an upstream protocol name only at that boundary. Coding
Agent therefore mirrors Sandbox `prepare`, `preparing`, and `prepared` wire
states in its Sandbox adapters, then exposes application-owned authorization
terminology everywhere else.

Local variables may use ordinary English where there is no domain ambiguity, but
persisted fields and exported APIs must name the exact state transition.
