// robots.txt parsing and matching, following RFC 9309: the group whose user-agent
// equals our product token wins (falling back to "*"), the longest matching rule
// wins, and Allow beats Disallow on a tie. "*" and "$" are supported with a
// linear-time matcher (no regular expressions built from remote input).

const MAX_RULES = 5000;
const MAX_PATTERN = 2048;

function normalizeEncoding(path) {
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

/** Compile a robots pattern once: collapsed wildcards, "$" anchor split off. */
export function compilePattern(raw) {
  let pattern = String(raw).slice(0, MAX_PATTERN).replace(/\*+/g, '*');
  let anchored = false;
  if (pattern.endsWith('$')) {
    anchored = true;
    pattern = pattern.slice(0, -1);
  }
  return { pattern, anchored, length: String(raw).length };
}

/**
 * Does the path match? Prefix semantics unless anchored with "$". Greedy glob with
 * backtracking to the last "*" only, which is O(path × pattern) at worst and linear
 * in practice (the approach Google's robots parser uses).
 */
export function matches(compiled, path) {
  const p = compiled.anchored ? compiled.pattern : `${compiled.pattern}*`;
  const s = path;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === s[si]) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi;
      mark = si;
      pi += 1;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

/** Parse robots.txt text into groups: [{ agents: [], rules: [{ allow, pattern, compiled }], crawlDelay }]. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  let ruleCount = 0;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      // RFC 9309: the product token is the leading run of letters, "-" and "_".
      const token = (/^[a-z_-]+/i.exec(value)?.[0] ?? (value === '*' ? '*' : '')).toLowerCase();
      if (value.startsWith('*')) current.agents.push('*');
      else if (token) current.agents.push(token);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // "Disallow:" with no path allows everything
      if (ruleCount >= MAX_RULES) {
        groups.truncated = MAX_RULES;
        continue;
      }
      ruleCount += 1;
      const pattern = normalizeEncoding(value);
      current.rules.push({ allow: key === 'allow', pattern, compiled: compilePattern(pattern) });
    } else if (key === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  return groups;
}

/** Pick the rules for our product token (e.g. "redirect-map-check"): exact token match, else "*". */
export function selectGroup(groups, productToken) {
  const token = productToken.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(token));
  if (named.length) return mergeGroups(named);
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  return wildcard.length ? mergeGroups(wildcard) : { rules: [], crawlDelay: null };
}

function mergeGroups(groups) {
  return {
    rules: groups.flatMap((g) => g.rules),
    crawlDelay: groups.reduce((max, g) => (g.crawlDelay !== null && g.crawlDelay > (max ?? -1) ? g.crawlDelay : max), null),
  };
}

/** Is `pathWithQuery` allowed by the selected group? */
export function isAllowed(group, pathWithQuery) {
  const path = normalizeEncoding(pathWithQuery || '/');
  if (path === '/robots.txt') return true;
  let verdict = null;
  for (const rule of group.rules) {
    if (!rule.pattern) continue;
    const compiled = rule.compiled ?? compilePattern(rule.pattern);
    if (!matches(compiled, path)) continue;
    const length = compiled.length;
    if (!verdict || length > verdict.length || (length === verdict.length && rule.allow && !verdict.allow)) {
      verdict = { allow: rule.allow, length };
    }
  }
  return verdict ? verdict.allow : true;
}

/** Convenience: parse + select + match in one call. */
export function robotsAllows(text, productToken, pathWithQuery) {
  return isAllowed(selectGroup(parseRobots(text), productToken), pathWithQuery);
}
