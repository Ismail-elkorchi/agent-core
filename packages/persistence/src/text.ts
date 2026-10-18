/** Decode authoritative UTF-8 without dropping a leading U+FEFF from any span. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Supported UTF-8 text interpretation shared by selection, reading and range alignment.
 * An absent charset means UTF-8 under this repository contract. Other encodings
 * remain opaque artifacts, even if their bytes happen to be valid UTF-8.
 */
export function isTextMediaType(mediaType: string): boolean {
  const essence = /^[ \t]*([!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+)[ \t]*/iu.exec(mediaType);
  if (!essence) return false;
  const type = essence[1]?.toLowerCase() ?? '';
  if (!(type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript',
    'application/x-javascript', 'application/x-ndjson', 'application/ndjson', 'application/yaml', 'application/x-yaml'].includes(type)
    || type.endsWith('+json') || type.endsWith('+xml') || type.endsWith('+yaml'))) return false;
  // Parse complete parameters, including quoted semicolons. Malformed or repeated
  // charset declarations must not accidentally become an absent-charset default.
  const parameter = /;[ \t]*([!#$%&'*+.^_`|~0-9a-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~0-9a-z-]+))[ \t]*/iy;
  let position = essence[0].length;
  let charsetSeen = false;
  while (position < mediaType.length) {
    parameter.lastIndex = position;
    const match = parameter.exec(mediaType);
    if (!match) return false;
    position = parameter.lastIndex;
    if (match[1]?.toLowerCase() !== 'charset') continue;
    if (charsetSeen) return false;
    charsetSeen = true;
    const charset = (match[2]?.replace(/\\(.)/gu, '$1') ?? match[3] ?? '').toLowerCase();
    if (charset !== 'utf-8' && charset !== 'utf8') return false;
  }
  return true;
}
