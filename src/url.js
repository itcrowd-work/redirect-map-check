// URL helpers: parsing, normalising and comparing URLs the way a redirect
// audit needs to (host-insensitive keys, trailing-slash tolerance, no fragments).

/** Parse `value` as an absolute URL, resolving against `base` when given. Returns null on failure. */
export function toUrl(value, base) {
  if (value instanceof URL) return new URL(value.href);
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    return base ? new URL(text, base) : new URL(text);
  } catch {
    return null;
  }
}

/** True when the string is a path ("/about") rather than an absolute URL. */
export function isRelative(value) {
  return /^\/(?!\/)/.test(String(value ?? '').trim());
}

/** True when the string looks like a URL or a path (used for CSV header detection). */
export function looksLikeUrl(value) {
  const text = String(value ?? '').trim();
  return /^https?:\/\//i.test(text) || isRelative(text);
}

function decodePath(pathname) {
  // Normalise percent-encoding so /caf%C3%A9 and /café compare equal.
  try {
    return encodeURI(decodeURI(pathname));
  } catch {
    return pathname;
  }
}

function stripTrailingSlash(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Normalised absolute URL string: lower-case scheme and host, no default port,
 * no fragment, consistent percent-encoding. Keeps the trailing slash and query.
 */
export function normalizeUrl(value, base) {
  const url = toUrl(value, base);
  if (!url) return null;
  url.hash = '';
  url.pathname = decodePath(url.pathname);
  return url.href;
}

/** Key used to match an old URL across the sitemap and the map: path + query, no trailing slash. */
export function pathKey(value, base = 'http://placeholder.invalid') {
  const url = toUrl(value, base);
  if (!url) return null;
  return stripTrailingSlash(decodePath(url.pathname)) + url.search;
}

/** Compare two URLs, ignoring a trailing-slash-only difference and the fragment. */
export function sameUrl(a, b) {
  const ua = toUrl(a);
  const ub = toUrl(b);
  if (!ua || !ub) return false;
  return (
    ua.protocol === ub.protocol &&
    ua.host === ub.host &&
    stripTrailingSlash(decodePath(ua.pathname)) === stripTrailingSlash(decodePath(ub.pathname)) &&
    ua.search === ub.search
  );
}

/** Same as sameUrl but byte-for-byte on the path (used for loop detection). */
export function exactKey(value) {
  return normalizeUrl(value);
}

// ISO 639-1 language codes, so "/en/" or "/ro-ro/" counts as a homepage but "/tv" or "/ai" doesn't.
const LANGUAGES = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu ' +
    'fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko ' +
    'kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi ' +
    'pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ' +
    'ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '),
);

/**
 * A "root-like" path: "/" or a bare locale root such as "/en" or "/ro-ro/".
 * Landing there from a deep old URL is a soft-404 risk.
 */
export function isRootLike(value, prefix = '') {
  const url = toUrl(value);
  if (!url) return false;
  let path = url.pathname;
  if (prefix && prefix !== '/' && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.length !== 1) return false;
  const m = /^([a-z]{2})([-_][a-z]{2})?$/i.exec(segments[0]);
  return Boolean(m && LANGUAGES.has(m[1].toLowerCase()));
}

/** Host without "www." and in lower case, port kept: www.Example.com:8080 → example.com:8080. */
export function foldHost(host) {
  return String(host).toLowerCase().replace(/^www\./, '');
}

/** Key for "the same page on the same site": folded host + path + query, scheme and trailing slash ignored. */
export function siteKey(value, base) {
  const url = toUrl(value, base);
  if (!url) return null;
  return `${foldHost(url.host)}${pathKey(url.href)}`;
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref|igshid)$/i;

/**
 * If two URLs are the same page written differently, say how: ['scheme', 'www', 'case', 'tracking'].
 * Returns null when they are different pages (or identical).
 */
export function variantDifferences(a, b) {
  const ua = toUrl(a);
  const ub = toUrl(b);
  if (!ua || !ub) return null;
  const clean = (u) => {
    const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([x], [y]) => x.localeCompare(y));
    return { host: foldHost(u.host), path: stripTrailingSlash(decodePath(u.pathname)), query: new URLSearchParams(params).toString() };
  };
  const ca = clean(ua);
  const cb = clean(ub);
  if (ca.host !== cb.host || ca.query !== cb.query || ca.path.toLowerCase() !== cb.path.toLowerCase()) return null;
  const diffs = [];
  if (ua.protocol !== ub.protocol) diffs.push('scheme');
  if (ua.host.toLowerCase() !== ub.host.toLowerCase()) diffs.push('www');
  if (ca.path !== cb.path) diffs.push('case');
  if (ua.search !== ub.search) diffs.push('tracking');
  return diffs.length ? diffs : null;
}

/** Join a base (origin + optional path prefix) with the path and query of another URL. */
export function rebase(value, base) {
  const url = toUrl(value);
  const target = toUrl(base);
  if (!url || !target) return null;
  const prefix = stripTrailingSlash(target.pathname === '/' ? '' : target.pathname);
  return new URL(prefix + url.pathname + url.search, target.origin).href;
}

/** www.example.com <-> example.com, so both variants count as the same site. */
export function hostVariants(host) {
  const h = String(host).toLowerCase();
  return h.startsWith('www.') ? [h, h.slice(4)] : [h, `www.${h}`];
}
