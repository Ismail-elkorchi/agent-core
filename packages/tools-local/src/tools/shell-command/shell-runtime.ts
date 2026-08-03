import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ShellRuntimeCommand {
  name: string;
  category: string;
}

export interface ShellRuntimeSnapshot {
  runtime: 'local' | 'custom';
  os?: string;
  platform?: string;
  arch?: string;
  shell?: string;
  commands: ShellRuntimeCommand[];
  notes?: string[];
}

export interface ShellRuntimeDescriber {
  describeEnvironment(): ShellRuntimeSnapshot;
}

const COMMAND_CANDIDATES: ShellRuntimeCommand[] = [
  ...commands('shell', ['pwd', 'env', 'printf', 'which']),
  ...commands('filesystem', ['ls', 'cat', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'du', 'df', 'stat', 'file', 'realpath', 'readlink']),
  ...commands('text', ['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'grep', 'xargs', 'paste', 'split', 'tee']),
  ...commands('search', ['find', 'rg']),
  ...commands('data', ['sqlite3']),
  ...commands('structured-data', ['jq']),
  ...commands('scripting', ['python', 'python3', 'pip', 'pip3', 'uv', 'perl', 'node', 'npm', 'npx']),
  ...commands('document', ['pandoc', 'pdftotext']),
  ...commands('media', ['ffmpeg', 'magick']),
  ...commands('archive', ['tar', 'unzip', 'zip', 'gzip', 'xz', 'zstd']),
  ...commands('network-transfer', ['curl', 'wget', 'rsync']),
  ...commands('versioning', ['git']),
  ...commands('build', ['make', 'cmake', 'ninja', 'gradle']),
  ...commands('compare', ['diff']),
  ...commands('process', ['timeout'])
];

const localSnapshotCache = new Map<string, ShellRuntimeSnapshot>();
export const SHELL_PROMPT_COMMAND_LIMIT = 60;

export function inspectLocalShellRuntime(input: {
  env?: NodeJS.ProcessEnv;
  shell?: string;
  pathValue?: string;
  pathext?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): ShellRuntimeSnapshot {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const pathValue = input.pathValue ?? env.PATH ?? '';
  const pathext = input.pathext ?? env.PATHEXT ?? '';
  const shell = input.shell ?? env.SHELL;
  const cacheKey = JSON.stringify({ platform, arch, shell: shell ?? '', pathValue, pathext });
  const cached = localSnapshotCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const osLabel = hostOsLabel(platform);
  const snapshot: ShellRuntimeSnapshot = {
    runtime: 'local',
    platform,
    arch,
    ...(osLabel ? { os: osLabel } : {}),
    ...(shell ? { shell } : {}),
    commands: COMMAND_CANDIDATES.filter((command) => commandExists(command.name, {
      pathValue,
      pathext,
      platform
    })),
    notes: [
      'Command presence means the binary was found on the shell runtime PATH; authentication, daemon availability, permissions, and network access may still fail.'
    ]
  };
  localSnapshotCache.set(cacheKey, snapshot);
  return snapshot;
}

export function formatShellRuntimeForPrompt(snapshot: ShellRuntimeSnapshot, input: { maxCommands?: number } = {}): string {
  const maxCommands = Math.max(1, Math.min(SHELL_PROMPT_COMMAND_LIMIT, input.maxCommands ?? 50));
  const visibleCommands = snapshot.commands.slice(0, maxCommands).map((command) => command.name);
  const omitted = Math.max(0, snapshot.commands.length - visibleCommands.length);
  const runtimeLabel = snapshot.runtime === 'local' ? 'local shell runtime' : 'configured shell runtime';
  const details = [
    snapshot.os ? `OS: ${snapshot.os}` : '',
    snapshot.platform ? `platform: ${snapshot.platform}` : '',
    snapshot.arch ? `arch: ${snapshot.arch}` : '',
    snapshot.shell ? `shell: ${snapshot.shell}` : ''
  ].filter((part) => part.length > 0).join('; ');
  return [
    'Shell runtime snapshot:',
    `- Runtime: ${runtimeLabel}${details ? `; ${details}` : ''}.`,
    visibleCommands.length > 0
      ? `- Useful commands found: ${visibleCommands.join(', ')}${omitted > 0 ? ` (${String(omitted)} more omitted)` : ''}.`
      : '- Useful commands found: none from the bounded command catalog.',
    '- This is a bounded snapshot of common commands, not a complete PATH listing. Check uncommon commands with `command -v <name>` before relying on them.',
    ...(snapshot.notes ?? []).map((note) => `- ${note}`)
  ].join('\n');
}

function commands(category: string, names: string[]): ShellRuntimeCommand[] {
  return names.map((name) => ({ name, category }));
}

function hostOsLabel(platform: NodeJS.Platform): string | undefined {
  if (platform === 'linux') {
    const release = parseOsRelease();
    if (release) {
      return release;
    }
  }
  return `${os.type()} ${os.release()}`;
}

function parseOsRelease(): string | undefined {
  if (!existsSync('/etc/os-release')) {
    return undefined;
  }
  const text = readFileSync('/etc/os-release', 'utf8');
  const values = Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      return [];
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').replace(/^"|"$/g, '').replace(/\\"/g, '"');
    return [[key, value]];
  }));
  return values.PRETTY_NAME ?? values.NAME;
}

function commandExists(name: string, input: {
  pathValue: string;
  pathext: string;
  platform: NodeJS.Platform;
}): boolean {
  return executablePaths(name, input).some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function executablePaths(name: string, input: {
  pathValue: string;
  pathext: string;
  platform: NodeJS.Platform;
}): string[] {
  const pathEntries = input.pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
  const extensions = input.platform === 'win32'
    ? (input.pathext || '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry.length > 0)
    : [''];
  return pathEntries.flatMap((entry) => extensions.map((extension) => path.join(entry, `${name}${extension}`)));
}
