// The core: build the list of old URLs, follow each one's redirects, read the
// landing page, and turn what we saw into issues and recommended fixes.

import { readFile } from 'node:fs/promises';
import { createScorer, decodeHtml, extractPageInfo, matchScore, pageTokens, slugTokens } from './content.js';
import { SUGGEST_TYPES, fixContext, recommendFix } from './fixes.js';
import { Fetcher } from './http.js';
import { loadSitemapUrls, loadText, parseRedirectMap, parseUrlList } from './inputs.js';
import { makeIssue, severityRank } from './issues.js';
import {
  exactKey,
  foldHost,
  hostVariants,
  isRelative,
  isRootLike,
  normalizeUrl,
  pathKey,
  rebase,
  sameUrl,
  siteKey,
  toUrl,
  variantDifferences,
} from './url.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEMPORARY_STATUSES = new Set([302, 303, 307]);
const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ''));

export const DEFAULTS = {
  concurrency: 4,
  delayMs: 250,
  timeoutMs: 15_000,
  retries: 1,
  retryBaseMs: 1000,
  maxHops: 10,
  minSimilarity: 0.25,
  minSuggestion: 0.5,
  strongSuggestion: 0.75,
  maxSuggestions: 3,
  respectRobots: true,
  content: true,
  allowPrivateNetwork: false,
};

function isHtml(contentType) {
  return /html/i.test(contentType) || contentType === '';
}

/**
 * Gather old URLs from the sitemap, URL list and map, merged per page (folded host + path),
 * and check the map itself: conflicts, duplicates, self-targets, chains and loops.
 */
export async function collectTargets(options, fetcher, notes) {
  const trusted = []; // URLs whose hosts the user gave us directly (may be on a private network)
  const sitemapUrls = [];
  const sitemapFailures = [];
  for (const source of options.sitemaps ?? []) {
    const entrySources = [];
    const locs = await loadSitemapUrls(source, fetcher, {
      notes,
      allowPartial: Boolean(options.allowPartialSitemaps),
      failures: sitemapFailures,
      confineTo: options.localRoot,
      signal: options.signal,
      entrySources,
    });
    if (options.signal?.aborted) break;
    // Trust follows the file each entry was read from: a local file is the user's own; entries
    // of a remote sitemap (even a child of a local index) are trusted only on that sitemap's
    // host (the top-level sitemap's host when the top level is remote, as before).
    const topHost = isHttpUrl(source) ? foldHost(new URL(source).host) : null;
    for (const { from, locs: batch } of entrySources) {
      const host = isHttpUrl(from) ? topHost ?? foldHost(new URL(from).host) : null;
      for (const loc of batch) if (!host || (toUrl(loc) && foldHost(toUrl(loc).host) === host)) trusted.push(loc);
    }
    sitemapUrls.push(...locs);
  }
  const listUrls = [];
  for (const source of options.urlLists ?? []) {
    const urls = parseUrlList(await loadText(source, fetcher, { signal: options.signal }));
    if (!isHttpUrl(source)) trusted.push(...urls);
    listUrls.push(...urls);
  }
  let map = { entries: [], problems: [], delimiter: ',', notes: [] };
  if (options.map) {
    map = parseRedirectMap(await loadText(options.map, fetcher, { notes, signal: options.signal }));
    notes.push(...map.notes);
    if (!isHttpUrl(options.map)) for (const e of map.entries) trusted.push(e.old, e.new);
  }
  const mapEntries = map.entries;

  if (sitemapUrls.length + listUrls.length + mapEntries.length === 0) {
    const why = notes.filter((n) => /Stopped after|could not be read/.test(n));
    throw new Error(`No URLs found in the inputs. Check the sitemap, URL list or map you passed.${why.length ? ` (${why.join(' ')})` : ''}`);
  }

  const firstAbsolute = [...sitemapUrls, ...listUrls, ...mapEntries.map((e) => e.old)].find((u) => !isRelative(u) && toUrl(u));
  let oldBase = options.oldBase ?? (firstAbsolute ? toUrl(firstAbsolute)?.origin : null);
  if (!oldBase && options.base) {
    oldBase = toUrl(options.base).origin;
    notes.push('All old URLs are paths and no --old-base was given, so we show them against the --base host.');
  }
  if (!oldBase) {
    throw new Error('Old URLs are relative paths. Pass --old-base https://old-site.example to say which site they belong to.');
  }

  const targets = new Map();
  const add = (value, source) => {
    const url = toUrl(value, oldBase);
    if (!url || !/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    const id = siteKey(url.href);
    if (!targets.has(id)) {
      targets.set(id, { id, key: pathKey(url.href), oldUrl: url.href, inSitemap: false, inList: false, mapEntry: null, mapIssues: [] });
    }
    const target = targets.get(id);
    if (source === 'sitemap') target.inSitemap = true;
    if (source === 'list') target.inList = true;
    return target;
  };

  let skippedLocs = 0;
  for (const u of sitemapUrls) if (!add(u, 'sitemap')) skippedLocs += 1;
  for (const u of listUrls) add(u, 'list');
  if (skippedLocs) notes.push(`${skippedLocs} sitemap entr${skippedLocs === 1 ? 'y was' : 'ies were'} not web addresses and were skipped.`);

  const byId = new Map(); // folded old URL → its (first) map entry
  for (const entry of mapEntries) {
    const target = add(entry.old, 'map');
    if (!target) continue;
    const resolvedNew = toUrl(entry.new, oldBase)?.href;
    if (target.mapEntry) {
      const firstNew = toUrl(target.mapEntry.new, oldBase)?.href;
      if (normalizeUrl(firstNew) === normalizeUrl(resolvedNew)) {
        target.mapIssues.push(makeIssue('map-duplicate', `Row ${entry.line} repeats row ${target.mapEntry.line}`, { lines: [target.mapEntry.line, entry.line] }));
      } else {
        target.mapIssues.push(
          makeIssue('map-conflict', `Row ${target.mapEntry.line} → ${target.mapEntry.new}; row ${entry.line} → ${entry.new}`, {
            rows: [
              { line: target.mapEntry.line, target: target.mapEntry.new },
              { line: entry.line, target: entry.new },
            ],
          }),
        );
      }
      continue;
    }
    target.mapEntry = { ...entry, resolvedNew };
    byId.set(target.id, target.mapEntry);
  }

  // The map as a graph: self-targets, chains (A → B, B → C) and loops (A → B → A).
  for (const target of targets.values()) {
    const entry = target.mapEntry;
    if (!entry) continue;
    if (normalizeUrl(target.oldUrl) === normalizeUrl(entry.resolvedNew)) {
      target.mapIssues.push(makeIssue('map-self-target', `Row ${entry.line}: ${entry.old} → ${entry.new}`, { line: entry.line }));
      continue;
    }
    const path = [entry];
    let current = entry;
    let loop = false;
    for (let i = 0; i < 50; i += 1) {
      const key = siteKey(current.resolvedNew);
      const next = byId.get(key);
      // A row that keeps its URL (/,/ is common) doesn't redirect it again, so it can't make a chain.
      if (!next || next === current || siteKey(next.resolvedNew) === key) break;
      if (path.includes(next)) {
        loop = next === entry;
        break;
      }
      path.push(next);
      current = next;
    }
    if (loop) {
      const lines = path.map((e) => e.line);
      target.mapIssues.push(
        makeIssue('map-loop', `Rows ${lines.join(' → ')} → ${entry.line}: ${path.map((e) => e.old).join(' → ')} → ${entry.old}`, {
          lines,
          urls: path.map((e) => e.old),
        }),
      );
      target.mapLoop = true;
    } else if (path.length > 1) {
      const end = path.at(-1);
      target.mapIssues.push(
        makeIssue('map-chain', `${entry.new} is redirected again (row ${path[1].line})${path.length > 2 ? ` and again` : ''} to end at ${end.new}`, {
          line: entry.line,
          via: entry.new,
          viaLine: path[1].line,
          end: end.new,
        }),
      );
      target.mapChainEnd = end.resolvedNew;
    }
  }

  return {
    targets: [...targets.values()],
    oldBase,
    mapProblems: map.problems,
    mapDelimiter: map.delimiter,
    sitemapFailures,
    trusted,
    counts: { sitemap: sitemapUrls.length, list: listUrls.length, map: mapEntries.length },
  };
}

/** Collect the new site's page URLs (--new-sitemap / --new-urls) before the crawl. */
async function collectNewUrls(options, fetcher, notes, resolveBase) {
  const urls = [];
  for (const source of options.newSitemaps ?? []) {
    try {
      urls.push(...(await loadSitemapUrls(source, fetcher, { notes, confineTo: options.localRoot, signal: options.signal })));
    } catch (err) {
      notes.push(`New sitemap not read (${err.message}); fixes suggest only pages we visited.`);
    }
  }
  for (const source of options.newUrlLists ?? []) {
    try {
      urls.push(...parseUrlList(await loadText(source, fetcher, { signal: options.signal })).map((u) => toUrl(u, resolveBase)?.href).filter(Boolean));
    } catch (err) {
      notes.push(`New URL list not read (${err.message}); fixes suggest only pages we visited.`);
    }
  }
  return urls.filter((u) => isHttpUrl(u));
}

/**
 * Which hosts are "this site" (rewritten onto --base and shortened in fixes)? The old
 * hosts, hosts the user names (--new-host), hosts in the new sitemap, and, for a map
 * whose targets are all absolute, the host most of them point at (a domain change).
 * When some targets are relative, the map is about this site and any other absolute
 * host is an external link unless named.
 */
function buildContext(options, oldBase, targets, newUrls, notes = []) {
  const base = options.base ? toUrl(options.base) : null;
  const siteHosts = new Set();
  const addHost = (value) => {
    const url = toUrl(value, oldBase);
    if (url) for (const h of hostVariants(url.host)) siteHosts.add(h);
  };
  addHost(oldBase);
  for (const t of targets) addHost(t.oldUrl);
  for (const h of options.newHosts ?? []) addHost(/^https?:\/\//i.test(h) ? h : `https://${h}`);
  for (const u of newUrls) addHost(u);

  const counts = new Map();
  let absolute = 0;
  let relative = 0;
  let own = 0; // absolute targets on this site's own hosts
  for (const t of targets) {
    if (!t.mapEntry) continue;
    // A row that keeps its URL ("/,/") says nothing about where the new site lives.
    if (normalizeUrl(t.oldUrl)?.replace(/\/$/, '') === normalizeUrl(t.mapEntry.resolvedNew)?.replace(/\/$/, '')) continue;
    if (isRelative(t.mapEntry.new)) {
      relative += 1;
      continue;
    }
    const url = toUrl(t.mapEntry.new);
    if (!url) continue;
    absolute += 1;
    const host = foldHost(url.host);
    if (siteHosts.has(url.host.toLowerCase())) own += 1;
    else counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const foreign = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // A domain change: no row moves within this site by path, and one other host holds at
  // least half of the absolute targets and more than the site's own host does.
  if (relative === 0 && foreign.length && foreign[0][1] >= absolute * 0.5 && foreign[0][1] > own) {
    const [host, n] = foreign[0];
    for (const h of hostVariants(host)) siteHosts.add(h);
    notes.push(`Treated ${host} as the new site's domain (${n} of ${absolute} map targets).${base ? ' Its URLs are tested on --base.' : ''} If that's wrong, list the new site's hosts with --new-host.`);
  }
  const external = foreign.filter(([host]) => !siteHosts.has(host));
  if (external.length && base) {
    notes.push(`Treated ${external.map(([h]) => h).join(', ')} as external (not rewritten onto --base). If ${external.length === 1 ? 'it belongs' : 'any belong'} to the new site, pass --new-host.`);
  }

  const baseHosts = new Set(base ? hostVariants(base.host) : []);
  const rewriteHosts = new Set([...siteHosts].filter((h) => !baseHosts.has(h)));

  return {
    base,
    oldBase,
    siteHosts,
    localHosts: [...siteHosts, ...baseHosts],
    basePrefix: base && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '',
    isSiteHost(value) {
      const url = toUrl(value);
      return Boolean(url && (siteHosts.has(url.host.toLowerCase()) || baseHosts.has(url.host.toLowerCase())));
    },
    /** Point URLs on the production host(s) at the staging base instead. */
    toTestUrl(value) {
      const url = toUrl(value);
      if (!url || !base) return url?.href ?? null;
      return rewriteHosts.has(url.host.toLowerCase()) ? rebase(url.href, base.href) : url.href;
    },
  };
}

/** Follow one URL's redirects hop by hop. Never throws. */
async function followChain(startUrl, fetcher, ctx, maxHops, readPages = true) {
  const hops = [];
  const visited = new Set();
  let current = startUrl;
  const out = {
    hops,
    finalUrl: null,
    finalStatus: null,
    page: null,
    loop: false,
    tooMany: false,
    error: null,
    errorCode: null,
    blocked: null,
    noLocation: false,
    nonHttp: null,
    rateLimited: null,
  };

  for (let i = 0; ; i += 1) {
    const key = exactKey(current);
    if (visited.has(key)) {
      out.loop = true;
      hops.push({ url: current, status: null, loopsBack: true });
      return out;
    }
    visited.add(key);

    const robots = await fetcher.robotsCheck(current);
    if (!robots.allowed) {
      out.blocked = { url: current, reason: robots.reason, kind: robots.kind, hop: hops.length, siteHost: ctx.isSiteHost(current) || hops.length === 0 };
      if (robots.kind === 'unreachable') {
        out.error = robots.reason;
        out.errorCode = robots.errorCode ?? 'EUNREACHABLE';
      } else if (robots.kind === 'private') {
        out.error = robots.reason;
        out.errorCode = 'EPRIVATE';
      }
      return out;
    }

    const res = await fetcher.request(current, { wantBody: readPages });
    const hop = { url: current, status: res.status || null, location: res.location ?? null };
    hops.push(hop);

    if (res.error) {
      out.error = res.error;
      out.errorCode = res.errorCode;
      hop.error = res.error;
      return out;
    }
    if (res.status === 429) {
      out.rateLimited = { url: current, retryAfterMs: res.retryAfterMs ?? null };
      return out;
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      if (!res.location) {
        out.noLocation = true;
        return out;
      }
      const nextUrl = toUrl(res.location, current);
      if (!nextUrl) {
        out.error = `Invalid Location header: ${String(res.location).slice(0, 200)}`;
        out.errorCode = 'EINVALIDURL';
        return out;
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        out.nonHttp = { from: current, location: String(res.location).slice(0, 200), scheme: nextUrl.protocol };
        return out;
      }
      if (i >= maxHops) {
        out.tooMany = true;
        out.maxHops = maxHops;
        return out;
      }
      nextUrl.hash = '';
      const next = nextUrl.href;
      const testUrl = ctx.toTestUrl(next);
      if (testUrl !== next) hop.rewrittenFrom = next;
      current = testUrl;
      continue;
    }
    out.finalUrl = current;
    out.finalStatus = res.status;
    if (res.status >= 200 && res.status < 300 && res.body && isHtml(res.contentType)) {
      out.page = extractPageInfo(decodeHtml(res.body, res.contentType));
      // Hitting the 2 MB cap is normal for big pages; a timeout or a cut connection isn't.
      if (readPages && (res.bodyTimedOut || (res.truncated && res.body.length < fetcher.maxBodyBytes))) {
        out.partial = res.bodyTimedOut ? 'timed out while downloading' : 'cut off before the end';
      }
    }
    return out;
  }
}

/** Read the old page's title and H1 from a copy of the old site that is still live. */
async function readOldPage(url, fetcher) {
  const res = await fetcher.follow(url, { wantBody: true, checkRobots: true, maxHops: 5 });
  if (res.error || res.status < 200 || res.status >= 300 || !res.body || !isHtml(res.contentType)) return null;
  const info = extractPageInfo(decodeHtml(res.body, res.contentType));
  return info.title || info.h1 ? { url: res.finalUrl || url, ...info } : null;
}

/** Request one page without following redirects: { status, location, page }. */
async function readNewPage(url, fetcher) {
  const robots = await fetcher.robotsCheck(url);
  if (!robots.allowed) return null;
  const res = await fetcher.request(url, { wantBody: true });
  const page =
    res.status >= 200 && res.status < 300 && res.body && isHtml(res.contentType) ? extractPageInfo(decodeHtml(res.body, res.contentType)) : null;
  return { status: res.status || null, location: res.location ?? null, error: res.error, page };
}

/** Turn a crawled result into issues. Pure function, so it is easy to test. */
export function evaluate(result, { minSimilarity, scorer, basePrefix = '' }) {
  const issues = [...(result.mapIssues ?? [])];
  const add = (type, detail, data) => issues.push(makeIssue(type, detail, data));
  const chain = result.chain;
  const oldIsRoot = isRootLike(result.oldUrl);
  const redirects = chain.hops.filter((h) => REDIRECT_STATUSES.has(h.status));
  const sorted = () => issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (chain.failed) {
    add('check-failed', chain.failed);
    return sorted();
  }

  // Couldn't check the URL itself (or a page on this site further down the chain): never clean.
  if (chain.blocked && !chain.error) {
    if (chain.blocked.siteHost) {
      add('unchecked', chain.blocked.reason, { kind: chain.blocked.kind, url: chain.blocked.url, hop: chain.blocked.hop });
      if (chain.blocked.hop === 0) return sorted();
    } else {
      add('target-not-checked', chain.blocked.reason, { url: chain.blocked.url });
    }
  }
  if (chain.error) {
    if (chain.errorCode === 'EPRIVATE') add('private-address', chain.error, { url: chain.blocked?.url ?? chain.hops.at(-1)?.url });
    else add('fetch-error', chain.error, { code: chain.errorCode, url: chain.blocked?.url ?? chain.hops.at(-1)?.url, robots: Boolean(chain.blocked) });
  }
  if (chain.rateLimited) {
    add('rate-limited', `HTTP 429 at ${chain.rateLimited.url}${chain.rateLimited.retryAfterMs ? ` (asked us to wait ${Math.round(chain.rateLimited.retryAfterMs / 1000)}s)` : ''}`, chain.rateLimited);
  }
  if (chain.nonHttp) add('non-http-redirect', `${chain.nonHttp.from} → ${chain.nonHttp.location}`, chain.nonHttp);
  if (chain.loop) add('redirect-loop', chain.hops.map((h) => h.url).join(' → '));
  if (chain.tooMany) add('too-many-redirects', `More than ${chain.maxHops ?? redirects.length - 1} redirects; we stopped there`);
  if (chain.noLocation) add('redirect-without-location', `HTTP ${chain.hops.at(-1)?.status} at ${chain.hops.at(-1)?.url}`);

  if (redirects.length >= 2 && !chain.loop && !chain.tooMany) add('redirect-chain', `${redirects.length} hops: ${redirects.map((h) => h.status).join(' → ')}`);
  const temporary = redirects.filter((h) => TEMPORARY_STATUSES.has(h.status));
  if (temporary.length) add('temporary-redirect', temporary.map((h) => `${h.status} at ${h.url}`).join('; '));

  const status = chain.finalStatus;
  const landed = chain.finalUrl !== null;
  // Where the chain ended up, even if we couldn't load that last page (robots on another site).
  const endUrl = chain.finalUrl ?? (chain.blocked && !chain.blocked.siteHost ? chain.blocked.url : null);
  const ok = landed && status >= 200 && status < 300;
  const mappedNoRule = Boolean(result.expectedUrl) && landed && redirects.length === 0 && !sameUrl(result.requestUrl, result.expectedUrl);

  // A mapped URL with no rule is one problem ("not redirected"), whatever it answers below 500.
  if (!mappedNoRule || status >= 500) {
    if (status === 404 || status === 410) add('not-found', `HTTP ${status} at ${chain.finalUrl}`);
    else if (status >= 400 && status < 500) add('client-error', `HTTP ${status} at ${chain.finalUrl}`);
    else if (status >= 500) add('server-error', `HTTP ${status} at ${chain.finalUrl}`);
  }

  let homepage = false;
  if (result.expectedUrl) {
    const expectedIsRoot = isRootLike(result.expectedUrl, basePrefix);
    if (expectedIsRoot && !oldIsRoot) {
      add('mapped-to-homepage', `Map row ${result.mapLine} → ${result.mapTarget}`);
      homepage = true; // the homepage warning already says the page doesn't match; no title check on top
    }
    if (mappedNoRule && status < 500) {
      add('not-redirected', `Answers HTTP ${status} instead of redirecting to ${result.expectedUrl}`, { status });
    } else if (endUrl && redirects.length > 0 && !result.mapLoop) {
      const onTarget = sameUrl(endUrl, result.expectedUrl) || (result.mapChainEndUrl && sameUrl(endUrl, result.mapChainEndUrl));
      if (!onTarget) {
        const diffs = variantDifferences(endUrl, result.expectedUrl) ?? (result.mapChainEndUrl ? variantDifferences(endUrl, result.mapChainEndUrl) : null);
        if (diffs) {
          add('target-variant', `Map says ${result.expectedUrl}, lands on ${endUrl} (${diffs.join(', ')})`, { differences: diffs, landed: endUrl });
        } else {
          add('wrong-target', `Expected ${result.expectedUrl}, landed on ${endUrl}`);
          if (isRootLike(endUrl, basePrefix) && !oldIsRoot && !expectedIsRoot) {
            add('lands-on-homepage', endUrl);
            homepage = true;
          }
        }
      }
    }
  } else if (result.inSitemap || result.inList) {
    if (ok && redirects.length === 0) add('unchanged-not-in-map', `HTTP ${status}`);
    else if (landed || endUrl) add('missing-from-map', `Currently ends at ${endUrl}${status ? ` (HTTP ${status})` : ''}`);
    if (endUrl && redirects.length > 0 && isRootLike(endUrl, basePrefix) && !oldIsRoot) {
      add('lands-on-homepage', endUrl);
      homepage = true;
    }
  }

  if (chain.partial && redirects.length > 0) add('page-incomplete', `${chain.finalUrl} ${chain.partial}`);

  result.similarity = null;
  if (ok && redirects.length > 0 && result.oldPage && chain.page && scorer) {
    result.similarity = scorer(result.oldPage, chain.page);
    if (!homepage && result.similarity !== null && result.similarity < minSimilarity) {
      add(
        'content-mismatch',
        `Old: "${result.oldPage.title || result.oldPage.h1}" · New: "${chain.page.title || chain.page.h1}" (similarity ${result.similarity.toFixed(2)})`,
      );
    }
  }

  return sorted();
}

async function pool(items, size, worker, onDone, signal) {
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, size), items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const index = next;
      next += 1;
      await worker(items[index], index);
      onDone?.();
    }
  });
  await Promise.all(runners);
}

/**
 * Inverted index over the new site's pages, so candidates are only scored against pages
 * that share a word. Each page's words, slug and normalised URL are computed once.
 */
function buildCandidateIndex(pages, common) {
  const index = new Map();
  for (const page of pages) {
    page.norm = normalizeUrl(page.url)?.replace(/\/$/, '') ?? page.url;
    page.slug = new Set(slugTokens(page.url));
    const words = new Set([...[...pageTokens(page)].filter((t) => !common.has(t)), ...page.slug]);
    for (const w of words) {
      if (!index.has(w)) index.set(w, []);
      index.get(w).push(page);
    }
  }
  return index;
}

const MAX_POOL = 200;

/**
 * With --base, an old URL from the sitemap (or list) and a map row written with another
 * host can become the same staging URL. Check that page once, as the mapped one, and say
 * so. Two *mapped* rows are never merged: they may disagree, and each must be checked.
 */
function mergeSameTestUrl(targets, ctx, notes) {
  const groups = new Map();
  for (const t of targets) {
    const key = normalizeUrl(rebase(t.oldUrl, ctx.base.href))?.replace(/\/$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const drop = new Set();
  let mergedCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mapped = group.filter((t) => t.mapEntry);
    const unmapped = group.filter((t) => !t.mapEntry);
    const primary = mapped[0] ?? unmapped[0];
    for (const other of unmapped) {
      if (other === primary) continue;
      mergedCount += 1;
      drop.add(other);
      primary.inSitemap ||= other.inSitemap;
      primary.inList ||= other.inList;
      // The sitemap copy is on the host that really served the old page: read old titles there.
      if (other.inSitemap || other.inList) primary.contentUrl ??= other.oldUrl;
      if (mergedCount <= 5) {
        notes.push(`${other.oldUrl} (from the ${other.inSitemap ? 'sitemap' : 'URL list'}) and map row ${primary.mapEntry?.line ?? ''} (${primary.oldUrl}) are the same page on --base, so we checked it once.`.replace('map row  (', 'the URL ('));
      }
    }
    if (mapped.length > 1) {
      const rows = mapped.map((t) => `row ${t.mapEntry.line} (${t.oldUrl})`).join(', ');
      notes.push(`${rows} become the same URL on --base, so the staging site can only answer one way for all of them. We checked each row; if their targets differ, at least one will fail. Test each old host with its own --base if they are separate sites.`);
    }
  }
  if (mergedCount > 5) notes.push(`${mergedCount - 5} more sitemap URLs were merged with their map rows the same way.`);
  return targets.filter((t) => !drop.has(t));
}

async function loadSnapshot(path) {
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the snapshot ${path}: ${err.message}`);
  }
  const pages = new Map();
  for (const [key, value] of Object.entries(data?.pages ?? {})) {
    if (value && typeof value === 'object' && (typeof value.title === 'string' || typeof value.h1 === 'string')) {
      pages.set(key, { url: String(value.url ?? ''), title: String(value.title ?? ''), h1: String(value.h1 ?? '') });
    }
  }
  return pages;
}

/**
 * Run a full check. Options mirror the CLI flags (see README). Returns
 * { results, mapRowIssues, notes, oldPages, oldPagesFromSnapshot, mapDelimiter, summary }.
 */
export async function runCheck(input) {
  const options = { ...DEFAULTS, ...input };
  const started = Date.now();
  const notes = [];
  // Hooks for the browser interface: which phase we're in, each URL as it finishes, and cancelling.
  const phase = (name, detail) => options.onPhase?.(name, detail);
  const signal = options.signal;
  const checkCancelled = () => {
    if (signal?.aborted) {
      const err = new Error('The check was cancelled.');
      err.code = 'ECANCELLED';
      throw err;
    }
  };
  const ownFetcher = !options.fetcher;
  const fetcher =
    options.fetcher ??
    new Fetcher({
      userAgent: options.userAgent ?? 'redirect-map-check (+https://itcrowd.work/tools/redirect-map-check/)',
      productToken: options.productToken ?? 'redirect-map-check',
      concurrency: options.concurrency,
      delayMs: options.delayMs,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      retryBaseMs: options.retryBaseMs,
      respectRobots: options.respectRobots,
      allowPrivateNetwork: options.allowPrivateNetwork,
      notes,
      signal,
    });

  try {
    // Inputs the user named directly may be on a private network (local staging, the demo).
    const named = [options.base, options.oldBase, options.oldSite, options.map, ...(options.sitemaps ?? []), ...(options.urlLists ?? []), ...(options.newSitemaps ?? []), ...(options.newUrlLists ?? [])];
    for (const u of named) if (isHttpUrl(u)) await fetcher.trustHost(u);

    phase('inputs');
    const { targets, oldBase, mapProblems, mapDelimiter, sitemapFailures, trusted, counts } = await collectTargets(options, fetcher, notes).catch((err) => {
      checkCancelled(); // an input that failed because we cancelled is a cancel, not an error
      throw err;
    });
    checkCancelled();
    const trustedHosts = new Set();
    for (const u of trusted) {
      const url = toUrl(u, oldBase);
      if (url && /^https?:$/.test(url.protocol) && !trustedHosts.has(url.origin)) {
        trustedHosts.add(url.origin);
        await fetcher.trustHost(url.origin);
      }
    }
    if (!isRelative(oldBase)) await fetcher.trustHost(oldBase);

    const newUrls = options.content ? await collectNewUrls(options, fetcher, notes, options.base ?? oldBase) : [];
    const ctx = buildContext(options, oldBase, targets, newUrls, notes);
    const merged = ctx.base ? mergeSameTestUrl(targets, ctx, notes) : targets;
    const limited = options.limit ? merged.slice(0, options.limit) : merged;
    if (options.limit && merged.length > options.limit) notes.push(`--limit ${options.limit}: checked ${options.limit} of ${merged.length} URLs.`);

    // Where can we still read the old pages' titles and H1s?
    const snapshot = options.snapshot ? await loadSnapshot(options.snapshot) : null;
    const oldSite = options.oldSite ? toUrl(options.oldSite) : null;
    const liveOld = options.content && !snapshot && (oldSite || ctx.base);
    if (options.content && !snapshot && !liveOld) {
      notes.push(
        'Title/H1 comparison skipped: we need the old pages. Run before launch with --base, point --old-site at a copy of the old site that is still live, or pass --snapshot old-pages.json from an earlier run.',
      );
    }

    const results = [];
    let done = 0;
    phase('crawl', { total: limited.length });
    await pool(
      limited,
      options.concurrency,
      async (target, index) => {
        // Relative targets belong to the migrated site; with --base, production hosts point at staging.
        const expected = target.mapEntry ? ctx.toTestUrl(target.mapEntry.resolvedNew) : null;
        const requestUrl = ctx.base ? rebase(target.oldUrl, ctx.base.href) : target.oldUrl;
        const result = {
          id: target.id,
          key: target.key,
          oldUrl: target.oldUrl,
          requestUrl,
          expectedUrl: expected,
          mapTarget: target.mapEntry?.new ?? null,
          mapLine: target.mapEntry?.line ?? null,
          inSitemap: target.inSitemap,
          inList: target.inList,
          inMap: Boolean(target.mapEntry),
          mapIssues: target.mapIssues,
          mapLoop: Boolean(target.mapLoop),
          // When the map chains (A → B, B → C), landing on C is the intended outcome.
          mapChainEndUrl: target.mapChainEnd ? ctx.toTestUrl(target.mapChainEnd) : null,
          oldPage: null,
        };
        try {
          if (options.content) {
            if (snapshot) result.oldPage = snapshot.get(target.id) ?? snapshot.get(target.key) ?? null;
            else if (liveOld) {
              const from = target.contentUrl ?? target.oldUrl;
              result.oldPage = await readOldPage(oldSite ? rebase(from, oldSite.href) : from, fetcher);
            }
          }
          result.chain = await followChain(requestUrl, fetcher, ctx, options.maxHops, options.content);
        } catch (err) {
          // One URL must never stop the run.
          result.chain = { hops: [], finalUrl: null, finalStatus: null, page: null, failed: err?.message ?? String(err) };
        }
        results[index] = result;
        options.onUrlDone?.(result);
      },
      options.onProgress
        ? () => {
            done += 1;
            options.onProgress(done, limited.length);
          }
        : null,
      signal,
    );
    checkCancelled();

    // Pages we know on the new site: every page a redirect landed on, every mapped target we
    // probe below, and every page from --new-sitemap / --new-urls. They feed the candidate
    // pages in the recommended fixes.
    const livePages = new Map();
    const remember = (url, page) => {
      if (url && page && (page.title || page.h1)) livePages.set(normalizeUrl(url), { url, ...page });
    };
    for (const r of results) {
      if (r.chain.finalStatus >= 200 && r.chain.finalStatus < 300) remember(r.chain.finalUrl, r.chain.page);
    }

    // Does the mapped target exist? Tells "fix the rule" apart from "publish the page".
    phase('targets');
    const toProbe = results.filter(
      (r) =>
        r.expectedUrl &&
        isHttpUrl(r.expectedUrl) &&
        !(r.chain.blocked && r.chain.blocked.hop === 0) &&
        !(r.chain.finalStatus >= 200 && r.chain.finalStatus < 300 && sameUrl(r.chain.finalUrl, r.expectedUrl)),
    );
    await pool(toProbe, options.concurrency, async (r) => {
      if (signal?.aborted) return;
      const known = livePages.get(normalizeUrl(r.expectedUrl));
      if (known) {
        r.expectedProbe = { status: 200, page: { title: known.title, h1: known.h1 } };
        return;
      }
      const probe = await readNewPage(r.expectedUrl, fetcher);
      if (!probe) return;
      r.expectedProbe = { status: probe.status, page: probe.page };
      if (probe.status >= 200 && probe.status < 300) remember(r.expectedUrl, probe.page);
    });

    checkCancelled();
    if (newUrls.length) {
      phase('new-pages', { total: newUrls.length });
      const fresh = [...new Set(newUrls.map((u) => ctx.toTestUrl(u)).filter(Boolean))].filter((u) => !livePages.has(normalizeUrl(u)));
      await pool(fresh, options.concurrency, async (url) => {
        if (signal?.aborted) return;
        const res = await readNewPage(url, fetcher);
        if (res && res.status >= 200 && res.status < 300) remember(url, res.page);
      });
    }

    checkCancelled();
    phase('scoring');
    const pages = [...livePages.values()];
    const scorer = createScorer(results.map((r) => r.oldPage).filter(Boolean), pages);
    for (const result of results) {
      result.issues = evaluate(result, { minSimilarity: options.minSimilarity, scorer, basePrefix: ctx.basePrefix });
    }
    checkCancelled();

    // Candidate pages for an old URL, scored on title/H1 words and slug words.
    const index = buildCandidateIndex(pages, scorer.common);
    const candidates = (result) => {
      const oldSlug = slugTokens(result.oldUrl);
      const words = new Set([...(result.oldPage ? [...pageTokens(result.oldPage)].filter((t) => !scorer.common.has(t)) : []), ...oldSlug]);
      // Rank pages by shared rare words (IDF) and score only the best few hundred.
      const weights = new Map();
      for (const w of words) {
        const list = index.get(w);
        if (!list) continue;
        const idf = 1 / Math.log(2 + list.length);
        for (const page of list) weights.set(page, (weights.get(page) ?? 0) + idf);
      }
      const pool = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_POOL).map(([page]) => page);
      const exclude = new Set([result.chain.finalUrl, result.expectedUrl, result.requestUrl].filter(Boolean).map((u) => normalizeUrl(u)?.replace(/\/$/, '')));
      const found = [];
      for (const page of pool) {
        if (exclude.has(page.norm)) continue;
        const content = result.oldPage ? scorer(result.oldPage, page) : null;
        const slug = oldSlug.length && page.slug.size ? oldSlug.filter((t) => page.slug.has(t)).length / Math.min(oldSlug.length, page.slug.size) : null;
        const match = matchScore(content, slug);
        if (match.score === null || match.score < options.minSuggestion) continue;
        // One signal alone is never "strong": without the old title we only have the URL.
        const strong = match.score >= options.strongSuggestion && content !== null && match.slug !== null;
        found.push({
          url: page.url,
          title: page.title,
          h1: page.h1,
          score: Math.round(match.score * 100) / 100,
          confidence: strong ? 'strong' : 'possible',
          signals: { title: content === null ? null : Math.round(content * 100) / 100, slug: match.slug === null ? null : Math.round(match.slug * 100) / 100 },
        });
      }
      return found
        .sort((a, b) => b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url))
        .slice(0, options.maxSuggestions);
    };
    const closest = (result) => {
      if (!('suggestions' in result)) result.suggestions = candidates(result);
      return result.suggestions[0] ?? null;
    };
    const fx = fixContext({ localHosts: ctx.localHosts, baseHosts: ctx.base ? hostVariants(ctx.base.host) : [], closest, delimiter: mapDelimiter });
    for (const [i, result] of results.entries()) {
      if (i % 100 === 0) {
        checkCancelled();
        // Let the event loop breathe on big runs, so a cancel (or the interface) gets through.
        await new Promise((r) => setImmediate(r));
      }
      for (const issue of result.issues) {
        issue.fix = recommendFix(issue, result, fx);
        if (SUGGEST_TYPES.has(issue.type) && result.suggestions?.length) issue.suggestions = result.suggestions;
      }
      delete result.suggestions;
    }

    const mapRowIssues = mapProblems.map((p) => {
      const issue = makeIssue('map-row-skipped', p.message);
      issue.fix = `Give row ${p.line} an old URL and a new URL, or delete it.`;
      return { line: p.line, issue };
    });
    // Run-level problems with the inputs themselves (listed with the map rows in the reports).
    for (const f of sitemapFailures) {
      const issue = makeIssue('sitemap-unread', `${f.sitemap}: ${f.reason}`, { url: f.sitemap });
      issue.fix = `Make ${f.sitemap} load (it's listed in ${f.parent}), then re-run. Until then its URLs are unchecked.`;
      mapRowIssues.push({ line: null, issue });
    }
    const oldPages = {};
    for (const r of results) if (r.oldPage) oldPages[r.id] = r.oldPage;

    return {
      results,
      mapRowIssues,
      notes,
      oldPages,
      oldPagesFromSnapshot: Boolean(snapshot),
      mapDelimiter,
      summary: summarize(results, mapRowIssues, { counts, requests: fetcher.requestCount, ms: Date.now() - started, options }),
    };
  } finally {
    if (ownFetcher) fetcher.close();
  }
}

export function summarize(results, mapRowIssues, { counts, requests, ms, options }) {
  const byType = {};
  const bySeverity = { error: 0, warning: 0, notice: 0 };
  let urlsWithErrors = 0;
  let urlsWithWarnings = 0;
  let urlsUnchecked = 0;
  let clean = 0;
  const sitemapsUnread = mapRowIssues.filter(({ issue }) => issue.type === 'sitemap-unread').length;
  for (const r of results) {
    const severities = new Set(r.issues.map((i) => i.severity));
    if (r.issues.some((i) => i.type === 'unchecked' || i.type === 'rate-limited' || i.type === 'check-failed')) urlsUnchecked += 1;
    if (severities.has('error')) urlsWithErrors += 1;
    else if (severities.has('warning')) urlsWithWarnings += 1;
    else clean += 1;
    for (const issue of r.issues) {
      byType[issue.type] = (byType[issue.type] ?? 0) + 1;
      bySeverity[issue.severity] += 1;
    }
  }
  for (const { issue } of mapRowIssues) {
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
    bySeverity[issue.severity] += 1;
  }
  return {
    urlsChecked: results.length,
    clean,
    urlsWithErrors,
    urlsWithWarnings,
    urlsUnchecked,
    sitemapsUnread,
    bySeverity,
    byType,
    inputs: counts,
    requests,
    durationMs: ms,
    base: options.base ?? null,
    generatedAt: new Date().toISOString(),
  };
}
