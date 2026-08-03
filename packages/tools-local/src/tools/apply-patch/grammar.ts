export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF (move_update | patch_update)
move_update: change_move patch_update?
patch_update: patch_hunk+

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
patch_hunk: change_context hunk_line* changed_line hunk_line* eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
changed_line: ("+" | "-") /(.*)/ LF
hunk_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
