import * as z from 'zod';

export const searchFileTextModeSchema = z.enum(['literal', 'regex']);
export const searchFileTextHiddenModeSchema = z.enum(['include', 'exclude', 'only']);
export const searchFileTextResultModeSchema = z.enum(['files', 'matches', 'count']);

export const searchFileTextInputSchema = z.strictObject({
  query: z.string().trim().min(1).meta({
    description: 'Required non-empty text or regex to search for inside files.'
  }),
  path: z.string().trim().min(1).default('.').meta({
    description: 'Directory path to search under, relative to the configured root. Defaults to ".". The result only supports claims about files searched under this path.'
  }),
  mode: searchFileTextModeSchema.default('literal').meta({
    description: 'Search mode. "literal" treats query characters literally. "regex" treats query as a regular expression. Defaults to "literal".'
  }),
  caseSensitive: z.boolean().default(false).meta({
    description: 'Whether matching is case-sensitive. Defaults to false.'
  }),
  hidden: searchFileTextHiddenModeSchema.default('exclude').meta({
    description: 'How to handle files whose path contains a hidden segment. Defaults to "exclude", so hidden files are not searched. Use "include" or "only" when hidden content matters.'
  }),
  include: z.array(z.string().trim().min(1)).default([]).meta({
    description: 'Caller-chosen relative file/path patterns to include. Omit to search all non-excluded files. When set, absence claims apply only inside matching included paths.'
  }),
  exclude: z.array(z.string().trim().min(1)).default([]).meta({
    description: 'Caller-chosen relative file/path patterns to exclude. Excluded paths are not searched; absence claims do not apply there.'
  }),
  resultMode: searchFileTextResultModeSchema.default('files').meta({
    description: 'Result shape. "files" returns compact file localization, "matches" returns line evidence, "count" returns counts only. Defaults to "files".'
  }),
  contextLines: z.int().min(0).max(20).default(0).meta({
    description: 'Number of surrounding lines in matches resultMode. Ignored outside resultMode:"matches". Defaults to 0.'
  }),
  maxResults: z.int().min(1).max(1_000).default(50).meta({
    description: 'Maximum returned files, matches, or count rows. Defaults to 50. Reaching this limit produces partial coverage, so absence or completeness claims require a narrower or larger follow-up search.'
  }),
  maxMatchesPerFile: z.int().min(1).max(100).default(5).meta({
    description: 'Maximum returned matches per file in matches output. Defaults to 5.'
  }),
  maxFileBytes: z.int().min(1).max(50_000_000).default(1_000_000).meta({
    description: 'Maximum individual file size to search, in bytes. Defaults to 1000000. Larger files are outside the searched subset.'
  }),
  maxResultBytes: z.int().min(1_000).max(1_000_000).default(64_000).meta({
    description: 'Maximum serialized search result size before observation presentation, in bytes. Defaults to 64000.'
  })
});

export type SearchFileTextArguments = z.input<typeof searchFileTextInputSchema>;
export type SearchFileTextInput = z.output<typeof searchFileTextInputSchema>;
export type SearchFileTextMode = z.output<typeof searchFileTextModeSchema>;
export type SearchFileTextResultMode = z.output<typeof searchFileTextResultModeSchema>;

export interface SearchFileTextFileResult {
  path: string;
  matchCount: number;
  firstLine: number;
  firstPreview: string;
}

export interface SearchFileTextMatchResult {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchFileTextCountResult {
  filesWithMatches: number;
  totalMatches: number;
}

export interface SearchFileTextOmitted {
  files: number;
  matches: number;
  bytes: number;
}

export interface SearchFileTextFilters {
  hidden: z.output<typeof searchFileTextHiddenModeSchema>;
  include: string[];
  exclude: string[];
  caseSensitive: boolean;
  contextLines: number;
  maxResults: number;
  maxMatchesPerFile: number;
  maxFileBytes: number;
  maxResultBytes: number;
}

export interface SearchFileTextOutput {
  path: string;
  query: string;
  mode: SearchFileTextMode;
  resultMode: SearchFileTextResultMode;
  filters: SearchFileTextFilters;
  files?: SearchFileTextFileResult[];
  matches?: SearchFileTextMatchResult[];
  counts?: SearchFileTextCountResult;
  omitted: SearchFileTextOmitted;
  coverage: 'complete' | 'partial';
  truncated: boolean;
}
