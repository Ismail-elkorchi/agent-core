export const APPLY_PATCH_PROMPT_GUIDE = `Use apply_patch by sending the patch document as the freeform tool input. Do not wrap it in JSON.
Use this for reviewable text edits that fit a patch document. A patch may span multiple files and hunks; reviewable means explicit changed regions, not necessarily tiny edits. For generated, bulk mechanical, or tool-produced transformations, exec_command may be more efficient.
Patch hunks may contain larger changed regions; include enough unchanged context to locate each region.

Patch envelope:
*** Begin Patch
[one or more file operations]
*** End Patch

Supported operations:
*** Add File: path
+new file line

*** Update File: path
@@ optional context label
 unchanged context
-old line
+new line
*** End of File

*** Delete File: path

*** Update File: old/path
*** Move to: new/path

Valid update with multiple changed lines and hunks:
*** Update File: path
@@ functionOrSectionName
 unchanged line before
-old line one from current file
-old line two from current file
+new replacement line one
+new replacement line two
 unchanged line after
@@ nextSection
 unchanged context
+inserted line

Do not do this: context-only hunks are invalid because they make no change.
*** Update File: path
@@
 unchanged context only

Preflight before updating existing files:
- Inspect the exact current target region immediately before patching.
- Build hunks from the exact inspected text, not remembered text or earlier broad output.
- Use unnumbered source text as hunk content; do not copy line numbers from numbered listings.

Rules:
- Paths are workspace-relative, never absolute.
- Add File lines must start with +.
- Update hunks start with @@. Use unchanged context lines with a leading space when possible.
- Every Update File section has at least one @@ hunk unless it is move-only.
- Every @@ hunk has at least one + or - line; do not include context-only hunks.
- Use around 3 lines of context for updates; add a context label after @@ when repeated text could be ambiguous.
- Patch against exact current file text, not remembered text.
- Do not send raw git/unified diffs with --- or +++ headers.`;
