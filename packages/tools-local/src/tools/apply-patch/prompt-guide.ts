export const APPLY_PATCH_PROMPT_GUIDE = `Send a patch document directly as freeform input, without JSON or git diff headers. Paths are relative to the workspace root. Multiple files and hunks are allowed.

*** Begin Patch
*** Add File: new/path
+new file line
*** Update File: existing/path
@@ optional context label
 unchanged context
-old line
+replacement line
*** Delete File: obsolete/path
*** End Patch

For a move, use "*** Update File: old/path" followed by "*** Move to: new/path", with optional update hunks.
Each update hunk starts with @@ and includes at least one + or - line. Context lines start with a space. Use exact current source text and enough context to identify the intended region; labels after @@ can disambiguate repeated text. Do not copy display line numbers into the patch.
Use "*** End of File" after a hunk only when it must match at the file's end.`;
