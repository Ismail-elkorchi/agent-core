# JSON boundaries

This dependency-free package owns the shared JSON contract. It has no agent, provider, or persistence policy.

`parseJsonValue` and `parseJsonObject` capture unknown input into deeply immutable JSON snapshots. They reject unsupported values, accessors, cycles, sparse arrays, extra array properties, and non-enumerable or symbol properties. Limits apply to the complete tree: nesting depth, total entries, each string or key in UTF-8, and exact serialized bytes including keys, punctuation, and escapes. Captured subtrees can be reused, but their full size still counts toward every enclosing limit.

`canonicalJsonString` encodes complete JSON with sorted object keys. It accepts unknown input because serialization is a boundary: TypeScript cannot guarantee finite numbers, dense arrays, plain objects, or absence of cycles. It rejects invalid data without invoking accessors or `toJSON`. It does not clone, truncate, omit undefined values, or impose application-specific size limits. Hashes and artifacts use this exact encoding. Omit optional fields when constructing their domain records; do not pass explicit `undefined` as JSON.

Use decoding where external data enters or where a retained JSON value needs an ownership snapshot. Inside an admitted domain, trust its types and encode directly. Domain schema parsers should own their own readonly outputs; JSON is not an intermediate representation for every domain operation. A caller's shallow `Object.freeze` is never an ownership proof.

`@agent-core/json/diagnostics` exports `renderDiagnostic`, which describes arbitrary values as text. Its byte, depth, and shared entry budgets limit output and property inspection. JavaScript reflection must enumerate an object's own keys, and a proxy's reflection traps remain application code; this is not an isolation boundary for adversarial code. Diagnostic text can be incomplete, never invokes getters or function names, and handles cyclic errors. It is for display, never identity, replay, or authoritative payload storage.
