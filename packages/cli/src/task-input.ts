const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))`, 'gu');
const DISALLOWED_CONTROL_PATTERN = new RegExp(String.raw`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`, 'gu');

export function normalizeTaskInput(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(DISALLOWED_CONTROL_PATTERN, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
}
