// A specific, recommended fix for each problem, written from what the crawl
// actually saw: which rule, which row, which page, and (when we know the new
// site's pages) candidate pages to send the old URL to.

import { isRelative, isRootLike, sameUrl, toUrl } from './url.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEMPORARY = new Set([302, 303, 307]);

/** Problem types whose fix may name candidate pages (they're also listed on the issue). */
export const SUGGEST_TYPES = new Set(['not-found', 'not-redirected', 'lands-on-homepage', 'content-mismatch', 'mapped-to-homepage', 'missing-from-map']);

/**
 * Helpers shared by every fix: short URLs (path only on this site's hosts, full URL for
 * anything external), the candidate lookup, and the map's delimiter for example rows.
 */
export function fixContext({ localHosts = [], baseHosts = [], closest = () => null, delimiter = ',' } = {}) {
  const base = new Set(baseHosts.map((h) => h.toLowerCase()));
  const hosts = new Set(localHosts.map((h) => h.toLowerCase()));
  const short = (value) => {
    const url = toUrl(value);
    if (!url) return String(value ?? '');
    return hosts.has(url.host.toLowerCase()) ? url.pathname + url.search : url.href;
  };
  const onBase = (value) => {
    const url = toUrl(value);
    return Boolean(url && base.has(url.host.toLowerCase()));
  };
  return { short, closest, onBase, delimiter: delimiter === '\t' ? '<tab>' : delimiter };
}

function quote(page) {
  const text = page?.title || page?.h1 || '';
  return text ? `"${text}"` : '';
}

/** Differences that a server normalises before any migration rule runs. */
function normalisationHop(from, to) {
  const a = toUrl(from);
  const b = toUrl(to);
  if (!a || !b) return null;
  const strip = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const samePath = strip(a.pathname) === strip(b.pathname) && a.search === b.search;
  if (!samePath) {
    if (a.host === b.host && a.protocol === b.protocol && a.pathname.toLowerCase() === b.pathname.toLowerCase()) return 'lower-cases the URL';
    return null;
  }
  if (a.protocol !== b.protocol) return 'switches to https';
  if (a.host !== b.host) return a.host.replace(/^www\./, '') === b.host.replace(/^www\./, '') ? 'adds or removes www' : null;
  if (a.pathname !== b.pathname) return b.pathname.endsWith('/') ? 'adds a trailing slash' : 'removes the trailing slash';
  return null;
}

function suggestion(result, fx, prefix = 'The closest live page we found is') {
  const best = fx.closest(result);
  if (!best) return '';
  const name = quote(best) ? ` (${quote(best)})` : '';
  return best.confidence === 'strong'
    ? ` ${prefix} ${fx.short(best.url)}${name}, a strong match.`
    : ` A possible match is ${fx.short(best.url)}${name}; check it before you use it.`;
}

const has = (result, type) => (result.issues ?? []).some((i) => i.type === type);

const DIFF_WORDS = { scheme: 'http vs https', www: 'www vs no www', case: 'letter case', tracking: 'tracking parameters' };

/** One recommended fix for one issue on one result. */
export function recommendFix(issue, result, fx) {
  const chain = result.chain ?? { hops: [] };
  const old = fx.short(result.requestUrl ?? result.oldUrl);
  const expected = result.expectedUrl ? fx.short(result.expectedUrl) : null;
  const final = chain.finalUrl ? fx.short(chain.finalUrl) : null;
  const probe = result.expectedProbe;
  const expectedLive = probe && probe.status >= 200 && probe.status < 300;
  const expectedMissing = probe && (probe.status === 404 || probe.status === 410);
  const expectedIsHome = result.expectedUrl && isRootLike(result.expectedUrl) && !isRootLike(result.oldUrl);
  const row = result.mapLine ? `row ${result.mapLine}` : 'the map';
  const redirects = chain.hops.filter((h) => REDIRECTS.has(h.status));
  const d = issue.data ?? {};

  switch (issue.type) {
    case 'unchecked': {
      const where = fx.short(d.url ?? result.requestUrl);
      if (d.kind === 'robots-error') {
        return `${issue.detail}. Fix robots.txt on that host (it should answer 200 or 404), then re-run. Until then nothing about ${old} is known.`;
      }
      return `robots.txt on ${toUrl(d.url ?? result.requestUrl)?.host ?? 'the site'} disallows ${where}, so we didn't request it. If you own the site (staging often blocks crawlers), re-run with --ignore-robots.`;
    }

    case 'not-found':
      if (redirects.length === 0) {
        return `${old} has no redirect and answers ${chain.finalStatus}. Add a 301 from ${old} to the page that replaces it.${suggestion(result, fx)}`;
      }
      if (expected && sameUrl(chain.finalUrl, result.expectedUrl)) {
        return `The rule is right but ${expected} doesn't exist. Publish ${expected}, or point ${old} (and ${row}) at a live page.${suggestion(result, fx)}`;
      }
      return `${final} doesn't exist. Point ${old} at a live page${expected ? `: the map says ${expected}` : ''}.${expected ? '' : suggestion(result, fx)}`;

    case 'client-error':
      return `${final} answers ${chain.finalStatus}. Check the firewall, password protection or access rules for that path, then re-run.`;

    case 'server-error':
      return redirects.length === 0
        ? `${old} answers ${chain.finalStatus}${chain.finalStatus === 503 ? ' (after a retry)' : ''}. Check the server or platform logs for that route, then re-run.${expected ? ` Once it responds, it should 301 to ${expected}.` : ''}`
        : `${final} answers ${chain.finalStatus}. Check the server or platform logs for that route, then re-run.`;

    case 'rate-limited':
      return `${fx.short(d.url ?? result.requestUrl)} answered 429 Too Many Requests${d.retryAfterMs ? ` and asked us to wait ${Math.round(d.retryAfterMs / 1000)}s` : ''}. Re-run later with a longer --delay (e.g. 2000) or --concurrency 1.`;

    case 'fetch-error': {
      const where = fx.short(d.url ?? chain.hops.at(-1)?.url ?? result.requestUrl);
      if (d.robots) return `We couldn't fetch robots.txt for ${toUrl(d.url)?.host ?? where} (${issue.detail}), so we couldn't check ${where}. Make sure the host is up and reachable from where you run the check.`;
      switch (d.code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return `${where}: the host name doesn't resolve. Check the DNS records, or the spelling of the host in the map or redirect rule.`;
        case 'ECONNREFUSED':
        case 'ECONNRESET':
          return `${where}: the server refused or dropped the connection. Check that the site is up on that address and port.`;
        case 'ETIMEDOUT':
          return `${where} didn't answer in time. Check that the site is up, or re-run with a longer --timeout.`;
        case 'ETLS':
          return `${where} has a TLS certificate problem (${issue.detail}). Fix the certificate; browsers will show visitors a warning too.`;
        case 'EINVALIDURL':
          return `A redirect on the way to ${where} has a malformed Location header (${issue.detail}). Fix that rule's target.`;
        default:
          return `We couldn't fetch ${where} (${issue.detail}). Check the server, then re-run.`;
      }
    }

    case 'private-address':
      return `The chain leads to ${fx.short(d.url ?? chain.hops.at(-1)?.url)}, which is on a private network, so we didn't request it. If that's a mistake, fix the rule; if you're testing a local copy on purpose, re-run with --allow-private-network.`;

    case 'non-http-redirect':
      return `${fx.short(d.from)} redirects to ${d.location}, which isn't a web page. Point that rule at ${expected ?? 'the page that replaces it'}.`;

    case 'check-failed':
      return `Re-run the check. If it fails again, report it with this message: ${issue.detail}`;

    case 'redirect-loop': {
      const urls = chain.hops.map((h) => h.url);
      const back = urls.length >= 2 ? urls[urls.length - 2] : urls[0];
      const target = urls.at(-1);
      return `${fx.short(back)} sends visitors back to ${fx.short(target)}. Remove that rule, then redirect ${old} once, with a 301, to ${expected ?? 'the page that replaces it'}.`;
    }

    case 'too-many-redirects':
      return `Replace the chain with one 301 from ${old} to ${expected ?? 'the final page'}.`;

    case 'redirect-without-location': {
      const hop = chain.hops.at(-1);
      return `${fx.short(hop?.url)} returns ${hop?.status} without a Location header. Fix that rule so it names its target${expected ? ` (${expected})` : ''}.`;
    }

    case 'not-redirected': {
      const status = d.status ?? chain.finalStatus;
      if (result.mapLoop) {
        return `${old} answers ${status} and has no redirect, but don't add the one in the map yet: ${row} is part of a loop (see the map-loop error). Point ${row} at a live page first, then add a 301 from ${old} to it.`;
      }
      if (expectedIsHome) {
        return `${old} answers ${status} and has no redirect. The map sends it to the homepage, which Google says might be treated as a soft 404: add a 301 to the page that replaces it instead, and update ${row}.${suggestion(result, fx)}`;
      }
      if (expectedMissing) return `${old} answers ${status} and has no redirect. Add a 301 from ${old} to ${expected}, but publish ${expected} first: it answers ${probe.status} right now.`;
      if (status === 404 || status === 410) return `${old} answers ${status}: the redirect is missing. Add a 301 from ${old} to ${expected}${expectedLive ? ` (${expected} is live)` : ''}.`;
      return `Add a 301 from ${old} to ${expected}${expectedLive ? ` (${expected} is live)` : ''}. Or, if ${old} is meant to stay, delete ${row} from the map.`;
    }

    case 'wrong-target': {
      const landedOn = final ?? fx.short(chain.blocked?.url);
      if (expectedMissing) {
        return `The map sends ${old} to ${expected}, which answers ${probe.status}. Publish ${expected} and change the rule to a 301 there, or update ${row} if ${landedOn} is the better page.`;
      }
      return `Change the rule for ${old} to a 301 straight to ${expected}${expectedLive ? `, which is live${quote(probe.page) ? ` (${quote(probe.page)})` : ''}` : ''}. It currently lands on ${landedOn}.`;
    }

    case 'target-variant': {
      const words = (d.differences ?? []).map((x) => DIFF_WORDS[x] ?? x).join(', ');
      // Write the new value the way the map writes it: a path for a path, a full URL for a
      // full URL (on the production host when we tested on --base).
      const landed = toUrl(d.landed);
      const mapAbsolute = result.mapTarget && !isRelative(result.mapTarget) && toUrl(result.mapTarget);
      let value = fx.short(d.landed);
      if (landed && mapAbsolute) {
        value = fx.onBase(d.landed) ? new URL(landed.pathname + landed.search, mapAbsolute.origin).href : landed.href;
      } else if (landed && result.mapTarget) {
        value = landed.pathname + landed.search;
      }
      return `${old} lands on ${fx.short(d.landed)}, the same page as the map's ${result.mapTarget ?? expected} written differently (${words}). Update ${row} to ${value} so the map records the real address.`;
    }

    case 'lands-on-homepage':
      if (expected) return `Send ${old} to ${expected}, as the map says, instead of the homepage.`;
      return `Map ${old} to the page that replaces it instead of the homepage, or answer 404 or 410 if the content is gone for good.${suggestion(result, fx)}`;

    case 'map-conflict': {
      const rows = d.rows ?? [];
      const followed = rows.find((r) => chain.finalUrl && sameUrl(toUrl(r.target, result.requestUrl)?.href, chain.finalUrl));
      const list = rows.map((r) => `row ${r.line} (${r.target})`).join(' or ');
      return `Keep one row for ${old}: ${list}, and delete the other.${followed ? ` The site currently follows row ${followed.line}.` : ''}`;
    }

    case 'map-loop': {
      const lines = d.lines ?? [];
      return `Rows ${lines.join(' and ')} send these URLs to each other (${(d.urls ?? []).join(' → ')} → ${d.urls?.[0] ?? old}). Point ${row} at a live page instead of another old URL.`;
    }

    case 'map-self-target':
      return `${row[0].toUpperCase()}${row.slice(1)} keeps ${old} as it is. Leave it in the map if you like, but don't create a redirect rule for it.`;

    case 'map-duplicate':
      return `Delete row ${(d.lines ?? [])[1] ?? ''}: it repeats row ${(d.lines ?? [])[0] ?? ''}.`;

    case 'redirect-chain': {
      const urls = [...redirects.map((h) => h.url), chain.finalUrl].filter(Boolean).map((u) => fx.short(u));
      const first = redirects[0] && chain.hops[1] ? normalisationHop(redirects[0].url, chain.hops[1].url) : null;
      const why = first ? ` The first hop only ${first}, so the migration rule never sees the original URL: make the rule match that form too, or put it first.` : '';
      return `Redirect ${old} straight to ${final ?? expected ?? 'the final page'} with one 301. Now it goes ${urls.join(' → ')}.${why}`;
    }

    case 'temporary-redirect': {
      const temp = redirects.filter((h) => TEMPORARY.has(h.status));
      return `${temp.map((h) => `Change the ${h.status} at ${fx.short(h.url)} to a 301`).join('; ')} (or 308). Platforms often label these "permanent" and "temporary"; pick permanent.`;
    }

    case 'content-mismatch': {
      const now = chain.page ? quote(chain.page) : '';
      const was = result.oldPage ? quote(result.oldPage) : '';
      const where = expected && sameUrl(chain.finalUrl, result.expectedUrl) ? `Check ${row} of the map: it sends ${old}` : `${old} lands on ${final}`;
      const verb = where.startsWith('Check') ? ` to ${final}` : '';
      return `${where}${verb}, ${now ? `titled ${now}` : 'a different page'}, but the old page was ${was || 'about something else'}.${suggestion(result, fx, 'A closer match on the new site is')}`;
    }

    case 'mapped-to-homepage':
      return `Map ${old} to the closest category or replacement page instead of the homepage, or answer 404 or 410 if the content is gone for good.${suggestion(result, fx)}`;

    case 'map-chain': {
      const end = d.end ? fx.short(toUrl(d.end, result.requestUrl)?.href ?? d.end) : 'the final URL';
      return `Change ${row} to point straight at ${end} instead of ${d.via}, and make the rule one hop.`;
    }

    case 'missing-from-map': {
      const landedWell =
        redirects.length > 0 &&
        chain.finalStatus >= 200 &&
        chain.finalStatus < 300 &&
        !has(result, 'lands-on-homepage') &&
        !has(result, 'content-mismatch');
      if (landedWell) {
        return `${old} already redirects to ${final}. If that's the right page, add "${fx.short(result.oldUrl)}${fx.delimiter}${final}" to the map so the map stays complete.`;
      }
      return `Add a row for ${fx.short(result.oldUrl)} to the map and a 301 to the page that replaces it.${suggestion(result, fx)}`;
    }

    case 'unchanged-not-in-map':
      return `Nothing to do if ${old} is meant to keep its address.`;

    case 'page-incomplete':
      return `${final} ${chain.partial ?? 'arrived incomplete'}. Check that it loads quickly and completely; re-run with a longer --timeout if the server is just slow.`;

    case 'target-not-checked':
      return `Open ${fx.short(d.url)} in a browser to confirm it loads. Nothing to change if it does.`;

    case 'map-row-skipped':
      return 'Give the row an old URL and a new URL, or delete it.';

    default:
      return '';
  }
}
