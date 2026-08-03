import type { ToolRisk } from '@agent-core/tools';

export interface CommandSafety {
  allowed: boolean;
  risk: ToolRisk;
  reason?: string;
}

export function assessShellCommand(command: string): CommandSafety {
  const normalized = command.trim();
  const firstToken = /^\s*([^\s;&|()]+)/.exec(normalized)?.[1] ?? '';
  const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
  const destructiveBases = new Set(['rm', 'rmdir', 'mkfs', 'dd', 'shutdown', 'reboot', 'sudo', 'su']);
  const networkBases = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync']);
  if (destructiveBases.has(base)) {
    return { allowed: false, risk: 'destructive', reason: `Blocked destructive command: ${base}` };
  }
  if (/\b(git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|chmod\s+-R|chown\s+-R)\b/.test(normalized)) {
    return { allowed: false, risk: 'destructive', reason: 'Blocked command pattern that can destroy configured root state.' };
  }
  if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/.test(normalized)) {
    return { allowed: false, risk: 'network', reason: 'Blocked piping remote code into a shell.' };
  }
  if (networkBases.has(base)) {
    return { allowed: true, risk: 'network' };
  }
  const writeLike = [
    /\b(?:npm\s+install|pnpm\s+install|yarn\s+add|touch|mv|cp|mkdir|sed\s+-i|tee)\b/,
    /\bcat\s+>/,
    /(^|[^2])>\s*[^&]/,
    /\bpython(?:3)?\b[\s\S]*\bwrite\(/,
    /\bnode\b[\s\S]*writeFile/
  ].some((pattern) => pattern.test(normalized));
  return { allowed: true, risk: writeLike ? 'write' : 'execute' };
}
