# JSON-RPC over stdio

`@agent-core/rpc` exports method contracts, boundary schemas and shared history/notes/session method mappings. `@agent-core/rpc/node` owns the JSONL stream connection. Applications provide authorized operations and their domain methods; neither package requires a particular agent or a daemon.

JSON-RPC 2.0 objects and nonempty batches are framed as one UTF-8 JSON value followed by LF. CRLF is accepted. Unicode U+2028/U+2029 inside strings are not delimiters. Stdout contains protocol frames only; diagnostics use stderr. Requests and outbound frames are bounded. EOF closes the connection and its application lifetime; it does not promise background execution.

A frame is limited to 8 MiB; the connection admits at most 32 concurrent requests/batch elements and retains at most 16 MiB of pending output. Slow consumers receive no promise of lossless live progress: overload closes the connection, and authoritative reads establish recovery. Bounded application subscribers can emit `delivery.gap`; progress replacements never turn fragments into complete text or redefine durable outcomes.

A request uses a string, number, or null correlation ID; notifications omit `id`. Duplicate in-flight request IDs are rejected. Malformed envelopes/JSON and invalid parameters use standard JSON-RPC errors; application failures use server errors. Batch notifications produce no response elements. No network listener is started.

The process owns application lifetime. EOF and `application.shutdown` start application cleanup before waiting for in-flight handlers, so cancellation can release those handlers. Output draining has a bounded shutdown deadline. Neither disconnect nor timeout proves an external effect did not happen. Inspect the selected session, pending decisions, and durable operation/run identities after restart.
