import { parseJsonObject } from '@agent-core/json';
import { atomicWritePrivateJson } from '@agent-core/persistence/node';
import { inputTriggerIdentity } from '@ismail-elkorchi/terminal-ui/input';
import { readFile } from 'node:fs/promises';
import { defaultTuiPreferences, type TuiPreferences } from './preferences.js';
import { parseShortcut, type ShortcutAction } from './shortcuts.js';

export async function readTuiPreferences(
  file: string,
  actions: readonly ShortcutAction[]
): Promise<TuiPreferences> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultTuiPreferences;
    throw error;
  }
  const value = parseJsonObject(JSON.parse(content), { maxTotalBytes: 64 * 1024 });
  const theme = value.theme;
  if (theme !== 'default' && theme !== 'minimal' && theme !== 'highContrast' && theme !== 'noColor')
    throw new Error('Unknown presentation theme.');
  if (
    !Array.isArray(value.statusline) ||
    !value.statusline.every((id): id is string => typeof id === 'string') ||
    new Set(value.statusline).size !== value.statusline.length
  )
    throw new Error('Status line fields must be unique strings.');
  if (
    typeof value.showReasoning !== 'boolean' ||
    typeof value.showTools !== 'boolean' ||
    typeof value.notify !== 'boolean' ||
    Object.keys(value).some(
      (key) => !['shortcuts', 'statusline', 'theme', 'showReasoning', 'showTools', 'notify'].includes(key)
    )
  )
    throw new Error('Presentation preferences are invalid.');
  const shortcuts = Object.fromEntries(
    Object.entries(parseJsonObject(value.shortcuts)).map(([action, value]) => [
      action,
      parseShortcut(value)
    ])
  );
  if (Object.keys(shortcuts).some((id) => !actions.some((action) => action.id === id)))
    throw new Error('Presentation preferences contain an unknown shortcut action.');
  if (new Set(Object.values(shortcuts).map(inputTriggerIdentity)).size !== Object.keys(shortcuts).length)
    throw new Error('Shortcut overrides must be unique.');
  return {
    shortcuts,
    statusline: value.statusline,
    theme,
    showReasoning: value.showReasoning,
    showTools: value.showTools,
    notify: value.notify
  };
}

export function writeTuiPreferences(file: string, preferences: TuiPreferences): Promise<void> {
  return atomicWritePrivateJson(file, { ...preferences });
}
