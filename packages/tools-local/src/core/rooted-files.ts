import { requireToolService, type ToolExecutionContext } from '@agent-core/tools';
import { isRootedFileAuthority, type RootedFileAuthority } from './rooted-file-authority.js';

export function requireRootedFileAuthority(context: ToolExecutionContext): RootedFileAuthority {
  return requireToolService(
    context,
    'rootedFileAuthority',
    isRootedFileAuthority,
    'adopted RootedFileAuthority'
  );
}
