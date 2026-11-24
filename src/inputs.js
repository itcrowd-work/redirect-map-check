// Loading the inputs: sitemaps (incl. sitemap indexes and .gz), plain URL lists,
// and the redirect map CSV.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { detectDelimiter, parseCsvDetailed } from './csv.js';
import { looksLikeUrl, toUrl } from './url.js';

const MAX_SITEMAPS = 500;
/** The sitemap protocol caps a file at 50 MB uncompressed; so do we, for any input. */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

function isHttp(source) {
  return /^https?:\/\//i.test(String(source));
}

function maybeGunzip(buffer, source) {
  const bytes = Buffer.from(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_INPUT_BYTES });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength|Cannot create a Buffer/i.test(err?.message ?? '')) {
      throw new Error(`${source} is larger than 50 MB once decompressed (the sitemap limit), so we stopped reading it`);
    }
    throw new Error(`${source} could not be decompressed (${err.message})`);
  }
}

/**
 * Bytes to text. UTF-16 with or without a byte-order mark (Excel's "Unicode text"),
 * otherwise UTF-8, falling back to Windows-1252 for older spreadsheet exports.
 * Pass `notes` to be told when a fallback was used.
 */
export function decodeText(bytes, { notes, name = 'The file' } = {}) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  // UTF-16 without a BOM: plain-ASCII text has a NUL in every other byte.
  const sample = b.subarray(0, 2048);
  if (sample.length >= 4) {
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] !== 0) continue;
      if (i % 2) oddNul += 1;
      else evenNul += 1;
    }
    const half = sample.length / 2;
    if (oddNul > half * 0.3 && evenNul < half * 0.05) {
      notes?.push(`${name} looks like UTF-16 without a byte-order mark; read it as UTF-16LE.`);
      return new TextDecoder('utf-16le').decode(b);
    }
    if (evenNul > half * 0.3 && oddNul < half * 0.05) {
      notes?.push(`${name} looks like UTF-16 without a byte-order mark; read it as UTF-16BE.`);
      return new TextDecoder('utf-16be').decode(b);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    notes?.push(`${name} isn't valid UTF-8; read it as Windows-1252 (Western European). Save it as UTF-8 to be sure.`);
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** Read a local file or fetch a URL (via the crawler's polite fetcher) and return text. */
export async function loadText(source, fetcher, { notes, signal } = {}) {
  if (isHttp(source)) {
    if (!fetcher) throw new Error(`Cannot fetch ${source} without a fetcher`);
    const res = await fetcher.fetchRaw(source);
    if (res.error) throw new Error(`Could not load ${source}: ${res.error}`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Could not load ${source}: HTTP ${res.status}`);
    if (res.truncated) throw new Error(`${source} is larger than 50 MB (the sitemap limit) or was cut off, so we stopped reading it`);
    return decodeText(maybeGunzip(res.body, source), { notes, name: source });
  }
  // Only regular files, checked before opening: a FIFO or a device would block the read forever.
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`${source} is not a regular file`);
  if (info.size > MAX_INPUT_BYTES) throw new Error(`${source} is larger than 50 MB`);
  const bytes = await readFile(source, { signal });
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`${source} is larger than 50 MB`);
  return decodeText(maybeGunzip(bytes, source), { notes, name: source });
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, '&')
    .trim();
}

const EXTENSIONS = /<([a-z0-9_]+):(image|video|news|mobile|pagemap)\b/gi;
const MAX_LOC = 8192;

/**
 * Remove sitemap extension blocks (<image:image>, <video:video>, <news:news>…) so their
 * own <…:loc> elements aren't read as pages (Shopify and Yoast sitemaps include them).
 * One forward scan with indexOf: linear even on malformed input.
 */
function stripExtensions(xml) {
  const lower = xml.toLowerCase();
  let out = '';
  let i = 0;
  let malformed = 0;
  // An unclosed extension block ends at its page entry's end, so it can't swallow the next page.
  const entryEnd = (from) => {
    const a = lower.indexOf('</url>', from);
    const b = lower.indexOf('</sitemap>', from);
    return a < 0 ? b : b < 0 ? a : Math.min(a, b);
  };
  for (;;) {
    EXTENSIONS.lastIndex = i;
    const m = EXTENSIONS.exec(lower);
    if (!m) return { text: out + xml.slice(i), malformed };
    out += xml.slice(i, m.index);
    const gt = lower.indexOf('>', m.index);
    if (gt < 0) return { text: out, malformed: malformed + 1 }; // unclosed tag at the very end
    if (lower[gt - 1] === '/') {
      i = gt + 1; // self-closing
      continue;
    }
    const closer = `</${m[1]}:${m[2]}`;
    const end = lower.indexOf(closer, gt + 1);
    const limit = entryEnd(gt + 1);
    if (end < 0 || (limit >= 0 && end > limit)) {
      malformed += 1;
      if (limit < 0) return { text: out, malformed };
      i = limit; // resume at this entry's closing tag
      continue;
    }
    const endGt = lower.indexOf('>', end);
    i = endGt < 0 ? lower.length : endGt + 1;
  }
}

/** Parse sitemap XML. Returns { type: 'index' | 'urlset', locs: string[] }. Linear time. */
export function parseSitemap(xml) {
  const { text, malformed } = stripExtensions(String(xml));
  const type = /<(?:[a-z0-9_]+:)?sitemapindex[\s>]/i.test(text) ? 'index' : 'urlset';
  const locs = [];
  const open = /<(?:[a-z0-9_]+:)?loc>/gi;
  const close = /<\/(?:[a-z0-9_]+:)?loc>/gi;
  for (;;) {
    const o = open.exec(text);
    if (!o) break;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(text);
    if (!c) break; // no closing tag anywhere after this: nothing more to read
    open.lastIndex = c.index + c[0].length;
    const raw = text.slice(o.index + o[0].length, c.index);
    if (raw.length > MAX_LOC) continue;
    const loc = decodeXml(raw);
    if (loc) locs.push(loc);
  }
  return { type, locs, malformed };
}

/**
 * Collect every page URL from a sitemap or sitemap index (followed recursively).
 * A child sitemap that can't be read stops the run, because its URLs would silently
 * go unchecked; with `allowPartial`, it is recorded in `failures` instead.
 */
export async function loadSitemapUrls(source, fetcher, { notes = [], allowPartial = false, failures = [], confineTo = null, signal, entrySources = null } = {}) {
  // entrySources: if given, receives { from, locs } per sitemap file read, so callers can tell
  // entries from a local file apart from entries a remote child sitemap supplied.
  // confineTo: a folder that local sitemap children must stay inside (the browser interface
  // passes its upload folder, so a dropped index can't point at other files on the disk).
  const inside = (path, dir) => resolve(path).startsWith(resolve(dir) + sep);
  const root = confineTo && !isHttp(source) && inside(source, confineTo) ? resolve(confineTo) + sep : null;
  const seen = new Set();
  const urls = [];
  const queue = [source];
  let failed = 0;
  while (queue.length) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    if (seen.size >= MAX_SITEMAPS) {
      notes.push(`Stopped after ${MAX_SITEMAPS} sitemap files.`);
      break;
    }
    seen.add(next);
    let parsed;
    try {
      if (root && !isHttp(next) && next !== source && !resolve(next).startsWith(root)) {
        throw new Error('it points outside the files you picked; drop the child sitemaps together with the index');
      }
      parsed = parseSitemap(await loadText(next, fetcher, { signal }));
    } catch (err) {
      if (next === source) throw err; // the sitemap you named must load
      if (!allowPartial) {
        throw new Error(`A child sitemap of ${source} could not be read (${err.message}). Its URLs would go unchecked, so we stopped. Re-run, or pass --allow-partial-sitemaps to check the rest and report it as an error.`);
      }
      failed += 1;
      failures.push({ sitemap: next, parent: source, reason: err.message });
      continue;
    }
    if (parsed.malformed) notes.push(`${next} has ${parsed.malformed} unclosed image/video/news block${parsed.malformed === 1 ? '' : 's'}; we skipped ${parsed.malformed === 1 ? 'it' : 'them'} and kept the page entries.`);
    if (parsed.type === 'index') {
      for (const loc of parsed.locs) {
        let child;
        if (isHttp(next)) child = toUrl(loc, next)?.href ?? loc;
        else if (isHttp(loc)) {
          child = loc;
          notes.push(`The local sitemap index ${next} points at ${loc}, which we fetched live. After launch that address may serve the new site's sitemap: save the child sitemaps too.`);
        } else child = resolve(dirname(next), loc);
        queue.push(child);
      }
    } else {
      urls.push(...parsed.locs);
      entrySources?.push({ from: next, locs: parsed.locs });
    }
  }
  if (failed) notes.push(`${failed} child sitemap${failed === 1 ? '' : 's'} could not be read; URLs in ${failed === 1 ? 'it were' : 'them were'} not checked (reported as errors).`);
  return urls;
}

/** Plain URL list: one URL per line; blank lines and # comments ignored; extra columns after whitespace or a tab. */
export function parseUrlList(text) {
  return String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]);
}

// Header names, compared after lower-casing, folding diacritics and dropping "url", "path",
// punctuation and so on. English and Romanian. Generic names ("redirect", "location") only
// count when no specific name is present.
const OLD_NAMES = new Set(['old', 'from', 'source', 'src', 'origin', 'original', 'redirect from', 'legacy', 'before', 'old site', 'current', 'vechi', 'veche', 'sursa', 'de la', 'initial', 'vechiul']);
const NEW_NAMES = new Set(['new', 'to', 'target', 'destination', 'dest', 'redirect to', 'after', 'new site', 'new location', 'nou', 'noua', 'destinatie', 'catre', 'tinta', 'final']);
const GENERIC_NEW = new Set(['redirect', 'location', 'redirectionare', 'redirect catre']);

export function normalizeHeader(cell) {
  return String(cell)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !['url', 'urls', 'path', 'paths', 'link', 'links', 'address', 'addresses', 'page', 'pages', 'uri'].includes(w))
    .join(' ');
}

/**
 * Parse the redirect map CSV. Accepts an optional header row; columns are found by
 * name (old/from/source…, new/to/target/destination…) or default to the first two
 * when there is no header. Throws when a header is present but the columns can't be
 * told apart, rather than guessing.
 * Returns { entries: [{ old, new, line }], problems: [{ line, message }], delimiter, notes }.
 */
export function parseRedirectMap(text) {
  const src = String(text ?? '');
  const delimiter = detectDelimiter(src.replace(/^﻿/, ''));
  const { rows, unclosedQuoteLine } = parseCsvDetailed(src, delimiter);
  const problems = [];
  const entries = [];
  const notes = [];
  if (unclosedQuoteLine) {
    throw new Error(`The redirect map has a quote opened on line ${unclosedQuoteLine} that is never closed. Fix that cell and run again.`);
  }
  if (rows.length === 0) return { entries, problems, delimiter, notes };

  let oldCol = 0;
  let newCol = 1;
  let start = 0;
  const first = rows[0].map((c) => c.trim());
  if (!first.some(looksLikeUrl)) {
    start = 1;
    const names = first.map(normalizeHeader);
    const o = names.findIndex((n) => OLD_NAMES.has(n));
    let n = names.findIndex((x, i) => i !== o && NEW_NAMES.has(x));
    if (n < 0) n = names.findIndex((x, i) => i !== o && GENERIC_NEW.has(x));
    const shown = first.join(delimiter === '\t' ? ' | ' : delimiter);
    if (o >= 0 && n >= 0) {
      oldCol = o;
      newCol = n;
    } else if (first.filter(Boolean).length === 2 && o < 0 && n < 0) {
      throw new Error(`The redirect map's header "${shown}" doesn't say which column is old and which is new. Name them, e.g. "old,new" or "Source URL,Destination URL".`);
    } else if (o >= 0 || n >= 0) {
      // One side named: the other is the first remaining column that holds URLs.
      const known = o >= 0 ? o : n;
      const sample = rows.slice(1, 20);
      const other = first.findIndex((_, i) => i !== known && sample.some((r) => looksLikeUrl(r[i] ?? '')));
      if (other < 0) throw new Error(`The redirect map's header "${shown}" names only one URL column.`);
      oldCol = o >= 0 ? o : other;
      newCol = n >= 0 ? n : other;
      notes.push(`Map header "${shown}": took column ${oldCol + 1} as the old URL and column ${newCol + 1} as the new URL.`);
    } else {
      throw new Error(`The redirect map's header "${shown}" doesn't say which columns hold the old and new URLs. Name them, e.g. "old,new" or "Source URL,Destination URL".`);
    }
  }

  for (let i = start; i < rows.length; i += 1) {
    const line = rows[i].line ?? i + 1;
    const oldValue = (rows[i][oldCol] ?? '').trim();
    const newValue = (rows[i][newCol] ?? '').trim();
    if (!oldValue && !newValue) continue; // notes-only or spacer row
    if (!looksLikeUrl(oldValue) || !looksLikeUrl(newValue)) {
      const shown = rows[i].map((c) => (c.includes(delimiter) || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter === '\t' ? '⇥' : delimiter);
      problems.push({ line, message: `Row ${line} skipped: expected an old URL and a new URL, got: ${shown.slice(0, 300)}` });
      continue;
    }
    entries.push({ old: oldValue, new: newValue, line });
  }
  const total = entries.length + problems.length;
  if (total > 0 && entries.length === 0) {
    throw new Error(`None of the ${total} rows in the redirect map had an old URL and a new URL (first problem: ${problems[0].message}).`);
  }
  if (total >= 5 && problems.length / total > 0.2) {
    notes.push(`${problems.length} of ${total} map rows were skipped. Check the column order and the delimiter.`);
  }
  return { entries, problems, delimiter, notes };
}
