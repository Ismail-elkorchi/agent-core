import { text, type Element } from '@ismail-elkorchi/terminal-ui/components';
import { terminalTextWidth } from '@ismail-elkorchi/terminal-ui/text';
import type { StatusField, TuiPreferences } from './preferences.js';

/** Prefer complete fields, preserving configured order; authority and activity survive narrow widths. */
export function responsiveStatusline(
  title: string,
  preferences: TuiPreferences,
  fields: readonly StatusField[],
  columns: number
): string {
  const selected = preferences.statusline.flatMap((id) =>
    fields.filter((field) => field.id === id && field.value)
  );
  const values = new Map<string, string>();
  let remaining = Math.max(0, columns - terminalTextWidth(title));
  const priorities = [
    ...selected.filter((field) => field.id === 'mode' || field.id === 'status'),
    ...selected.filter((field) => field.id !== 'mode' && field.id !== 'status')
  ];
  for (const field of priorities) {
    const value = field.value ?? '';
    const candidate = terminalTextWidth(value) + 3 <= remaining ? value : field.compactValue;
    if (candidate !== undefined && terminalTextWidth(candidate) + 3 <= remaining) {
      values.set(field.id, candidate);
      remaining -= terminalTextWidth(candidate) + 3;
    }
  }
  return [
    title,
    ...selected.flatMap((field) =>
      values.get(field.id) === undefined ? [] : [values.get(field.id)]
    )
  ].join(' · ');
}

export interface ActivityClock {
  readonly startedAt: number;
  readonly now: number;
}

/** A display clock only. Application run state owns whether it should exist. */
export function updateActivityClock(
  clock: ActivityClock | undefined,
  active: boolean,
  now: number
): ActivityClock | undefined {
  return active ? { startedAt: clock?.startedAt ?? now, now } : undefined;
}

export function activityLine<Message = never>(
  label: string,
  clock?: ActivityClock
): Element<Message> {
  const seconds =
    clock === undefined ? undefined : Math.max(0, Math.floor((clock.now - clock.startedAt) / 1000));
  const elapsed =
    seconds === undefined
      ? ''
      : seconds < 60
        ? `${String(seconds)}s`
        : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  return text({
    content: [label, elapsed, ...(clock === undefined ? [] : ['Esc stop'])]
      .filter(Boolean)
      .join(' · '),
    textRole: 'caption'
  });
}
