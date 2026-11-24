// Page content: pull the <title> and first <h1> out of HTML and score how
// related two pages are. Words that appear on most pages of a site (the brand
// name in every title, "Home", etc.) are ignored so they don't inflate scores.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
const SCAN_LIMIT = 256 * 1024; // title and h1 are always near the top
const FIELD_LIMIT = 4000; // characters kept from a title or h1

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Strip tags with one forward scan (a regex here is quadratic on a run of "<"). */
function stripTags(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break; // unclosed tag: drop the rest
    out += ' ';
    i = gt + 1;
  }
  return out;
}

function cleanText(html) {
  return decodeEntities(stripTags(html.slice(0, FIELD_LIMIT * 4))).replace(/\s+/g, ' ').trim().slice(0, FIELD_LIMIT);
}

/**
 * Remove comments and script/style/noscript/template blocks with one forward scan.
 * Each opener's next position is cached and only searched again once the scan has
 * passed it, so the whole thing stays linear.
 */
function stripBlocks(doc) {
  const lower = doc.toLowerCase();
  const openers = ['<!--', '<script', '<style', '<noscript', '<template'];
  const nextAt = openers.map((o) => lower.indexOf(o));
  let out = '';
  let i = 0;
  for (;;) {
    let best = -1;
    for (let k = 0; k < openers.length; k += 1) {
      if (nextAt[k] !== -1 && nextAt[k] < i) nextAt[k] = lower.indexOf(openers[k], i);
      if (nextAt[k] !== -1 && (best === -1 || nextAt[k] < nextAt[best])) best = k;
    }
    if (best === -1) return out + doc.slice(i);
    const at = nextAt[best];
    const which = openers[best];
    out += doc.slice(i, at);
    const closer = which === '<!--' ? '-->' : `</${which.slice(1)}`;
    const end = lower.indexOf(closer, at + which.length);
    if (end < 0) return out; // unclosed: everything after it is inside the block
    i = end + closer.length;
    if (which !== '<!--') {
      const gt = lower.indexOf('>', i);
      i = gt < 0 ? lower.length : gt + 1;
    }
  }
}

/** Content of the first <tag ...>...</tag>, found with indexOf. */
function firstElement(doc, lower, tag) {
  let from = 0;
  for (;;) {
    const open = lower.indexOf(`<${tag}`, from);
    if (open < 0) return '';
    const after = lower[open + tag.length + 1];
    if (after !== '>' && after !== undefined && !/\s|\//.test(after)) {
      from = open + 1; // e.g. <h10> or <titles>
      continue;
    }
    const gt = lower.indexOf('>', open);
    if (gt < 0) return '';
    const close = lower.indexOf(`</${tag}`, gt + 1);
    return doc.slice(gt + 1, close < 0 ? Math.min(doc.length, gt + 1 + FIELD_LIMIT) : close);
  }
}

/** Extract { title, h1 } from an HTML string. Missing values are ''. Linear time. */
export function extractPageInfo(html) {
  const doc = stripBlocks(String(html ?? '').slice(0, SCAN_LIMIT));
  const lower = doc.toLowerCase();
  return { title: cleanText(firstElement(doc, lower, 'title')), h1: cleanText(firstElement(doc, lower, 'h1')) };
}

/** Decode an HTML body: charset from Content-Type, else from <meta charset> in the first 1 KB, else UTF-8. */
export function decodeHtml(buffer, contentType = '') {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = Buffer.from(buffer).subarray(0, 1024).toString('latin1');
    charset =
      /<meta[^>]{0,200}?charset=["']?([\w-]{1,40})/i.exec(head)?.[1] ?? undefined;
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in is it its of on or our the this to was we with your you ' +
    'home page welcome official site shop store online ' +
    // Romanian, since we work in both languages
    'si și cu de din la pe pentru un o ale al acasa acasă'
  ).split(' '),
);

/** Lower-case word tokens with diacritics folded and a light plural strip. */
export function tokenize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// Just enough English plural folding to match "tables" with "table".
function stem(t) {
  if (t.length <= 3 || !t.endsWith('s') || t.endsWith('ss')) return t;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (/(x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  return t.slice(0, -1);
}

// Token sets are computed once per page object and reused across comparisons.
const tokenCache = new WeakMap();
export function pageTokens(info) {
  if (info && typeof info === 'object') {
    const cached = tokenCache.get(info);
    if (cached && cached.title === info.title && cached.h1 === info.h1) return cached.tokens;
    const tokens = new Set([...tokenize(info.title), ...tokenize(info.h1)]);
    tokenCache.set(info, { title: info.title, h1: info.h1, tokens });
    return tokens;
  }
  return new Set();
}

/**
 * Build a scorer for a set of pages. Tokens present on more than `maxShare`
 * of the pages in either corpus (site-wide words like the brand) are ignored
 * once a corpus has at least `minPages` pages.
 */
export function createScorer(oldPages, newPages, { maxShare = 0.5, minPages = 4 } = {}) {
  const common = new Set();
  for (const pages of [oldPages, newPages]) {
    if (pages.length < minPages) continue;
    const df = new Map();
    for (const info of pages) for (const t of pageTokens(info)) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, n] of df) if (n / pages.length > maxShare) common.add(t);
  }
  const scorer = (a, b) => similarity(a, b, common);
  scorer.common = common;
  return scorer;
}

/**
 * Overlap coefficient between two pages' title + H1 tokens: |A ∩ B| / min(|A|, |B|).
 * Returns null when either side has no usable words.
 */
export function similarity(a, b, ignore = new Set()) {
  let na = 0;
  let nb = 0;
  let shared = 0;
  const tb = pageTokens(b);
  for (const t of tb) if (!ignore.has(t)) nb += 1;
  for (const t of pageTokens(a)) {
    if (ignore.has(t)) continue;
    na += 1;
    if (tb.has(t)) shared += 1;
  }
  if (na === 0 || nb === 0) return null;
  return shared / Math.min(na, nb);
}

/**
 * Words in a URL's last path segment ("/products/rattan-chair.html" → rattan, chair).
 * Slugs often survive a migration even when titles change. A bare number or a
 * one-word segment borrows its parent ("/blog/2024/" → blog).
 */
const slugCache = new Map();
export function slugTokens(value) {
  const key = String(value);
  if (slugCache.has(key)) return slugCache.get(key);
  const words = computeSlugTokens(key);
  if (slugCache.size > 200_000) slugCache.clear();
  slugCache.set(key, words);
  return words;
}

function computeSlugTokens(value) {
  let path;
  try {
    path = new URL(value, 'http://placeholder.invalid').pathname;
  } catch {
    return [];
  }
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .map((seg) => seg.replace(/\.(html?|php|aspx?)$/i, ''));
  if (!segments.length) return [];
  let words = tokenize(segments.at(-1).replace(/[-_]+/g, ' ')).filter((t) => !/^\d+$/.test(t));
  if (words.length === 0 && segments.length > 1) words = tokenize(segments.at(-2).replace(/[-_]+/g, ' '));
  return [...new Set(words)];
}

/** Overlap coefficient of two URLs' slug words, or null when either has none. */
export function slugSimilarity(a, b) {
  const ta = slugTokens(a);
  const tb = new Set(slugTokens(b));
  if (!ta.length || !tb.size) return null;
  return ta.filter((t) => tb.has(t)).length / Math.min(ta.length, tb.size);
}

/**
 * Score a candidate page for an old page from two signals: title/H1 words and slug
 * words. With both, the stronger counts 60% and the weaker 40%, so agreement scores
 * highest. Returns { score, content, slug } (score null when neither signal exists).
 */
export function matchScore(content, slug) {
  const signals = [content, slug].filter((v) => v !== null && v !== undefined);
  if (!signals.length) return { score: null, content, slug };
  const score = signals.length === 2 ? 0.6 * Math.max(...signals) + 0.4 * Math.min(...signals) : signals[0];
  return { score, content, slug };
}
