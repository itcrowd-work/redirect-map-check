// Every problem the checker can report, with a severity and a plain-English fix.

export const SEVERITIES = ['error', 'warning', 'notice'];

export const ISSUES = {
  unchecked: {
    severity: 'error',
    title: 'Could not be checked',
    fix: 'We were not allowed to (or could not) request this URL, so we cannot say whether its redirect works. Nothing here counts as clean.',
  },
  'sitemap-unread': {
    severity: 'error',
    title: 'Sitemap could not be read',
    fix: 'A child sitemap failed to load, so the URLs in it were not checked. This fails the run even if every URL we did check is clean.',
  },
  'not-found': {
    severity: 'error',
    title: 'Ends in a 404 / 410',
    fix: 'The redirect target does not exist. Build the page or point the redirect at the closest live page.',
  },
  'client-error': {
    severity: 'error',
    title: 'Ends in another 4xx error',
    fix: 'Check access rules, authentication and firewall settings on the target.',
  },
  'server-error': {
    severity: 'error',
    title: 'Ends in a 5xx server error',
    fix: 'The server failed on this URL (503s are retried once first). Check the logs for that route.',
  },
  'fetch-error': {
    severity: 'error',
    title: 'Request failed',
    fix: 'DNS, TLS, timeout or connection problem. Make sure the host is reachable from where you run the check.',
  },
  'private-address': {
    severity: 'error',
    title: 'Points into a private network',
    fix: 'A redirect or sitemap entry leads to a loopback, private or link-local address. We did not request it. If that is intended (local staging), re-run with --allow-private-network.',
  },
  'non-http-redirect': {
    severity: 'error',
    title: 'Redirects to a non-web address',
    fix: 'A rule sends visitors to a javascript:, mailto:, file: or similar address. Point it at a web page.',
  },
  'rate-limited': {
    severity: 'error',
    title: 'Rate limited (429)',
    fix: 'The server refused us for sending too many requests, so this URL was not checked. Re-run with a longer --delay or lower --concurrency.',
  },
  'check-failed': {
    severity: 'error',
    title: 'Check failed',
    fix: 'Something unexpected went wrong while checking this URL. The other URLs were still checked. Please report it with the details.',
  },
  'redirect-loop': {
    severity: 'error',
    title: 'Redirect loop',
    fix: 'Two or more rules send the URL back to itself. Remove or reorder the conflicting rules.',
  },
  'too-many-redirects': {
    severity: 'error',
    title: 'Too many redirects',
    fix: 'The chain is longer than the hop limit. Point the first redirect straight at the final page.',
  },
  'redirect-without-location': {
    severity: 'error',
    title: 'Redirect without a Location header',
    fix: 'The server returns a 3xx status but no target. Fix the redirect rule.',
  },
  'not-redirected': {
    severity: 'error',
    title: 'In the map, but not redirected',
    fix: 'The old URL still answers 200 on the new site. Add the redirect, or remove the row if the URL is meant to stay.',
  },
  'wrong-target': {
    severity: 'error',
    title: 'Lands somewhere other than the mapped URL',
    fix: 'The live redirect does not match the map. Fix the rule (or the map, if the map is out of date).',
  },
  'lands-on-homepage': {
    severity: 'error',
    title: 'Lands on the homepage',
    fix: 'A deep URL is sent to the homepage, which search engines treat as a soft 404. Map it to the closest matching page.',
  },
  'map-conflict': {
    severity: 'error',
    title: 'Conflicting rows in the map',
    fix: 'The same old URL appears more than once with different targets. Keep one row. (We tested the first one.)',
  },
  'map-loop': {
    severity: 'error',
    title: 'Rows in the map redirect to each other',
    fix: 'Following the map from this URL comes back to it. Point one of the rows at a live page.',
  },
  'target-variant': {
    severity: 'warning',
    title: 'Lands on a variant of the mapped URL',
    fix: 'The redirect ends on the right page, but the address differs from the map in scheme, www, letter case or tracking parameters. Update the map so it records the real address.',
  },
  'redirect-chain': {
    severity: 'warning',
    title: 'Redirect chain (more than one hop)',
    fix: 'Each extra hop slows users down and leaks a little signal. Redirect the old URL straight to the final URL.',
  },
  'temporary-redirect': {
    severity: 'warning',
    title: 'Temporary redirect (302 / 303 / 307)',
    fix: 'A migration should use permanent redirects (301 or 308) so search engines move the old URL\'s signals to the new one.',
  },
  'content-mismatch': {
    severity: 'warning',
    title: 'Lands on an unrelated page',
    fix: 'The new page\'s title and H1 share almost no words with the old page. Check the map row: it is often a copy-paste slip.',
  },
  'mapped-to-homepage': {
    severity: 'warning',
    title: 'Mapped to the homepage on purpose',
    fix: 'Search engines usually treat this as a soft 404. Prefer the closest category or a 410 if the content is gone for good.',
  },
  'map-chain': {
    severity: 'warning',
    title: 'Map points at another old URL',
    fix: 'The target is itself redirected by another row. Point this row straight at the final URL.',
  },
  'missing-from-map': {
    severity: 'warning',
    title: 'Old URL missing from the map',
    fix: 'This URL is in the old sitemap but has no row in the map and does not resolve to the same page. Add a row.',
  },
  'unchanged-not-in-map': {
    severity: 'notice',
    title: 'Not in the map, still works',
    fix: 'The URL is not in the map but answers 200 on the new site at the same address. Nothing to do if that is intended.',
  },
  'page-incomplete': {
    severity: 'notice',
    title: 'Page arrived incomplete',
    fix: 'The final page was cut off or too slow, so the title/H1 check used only what arrived (or was skipped).',
  },
  'target-not-checked': {
    severity: 'notice',
    title: 'Final page on another site not checked',
    fix: 'The redirect leaves for another site whose robots.txt disallows us, so we did not confirm that page loads. The redirect itself was checked.',
  },
  'map-self-target': {
    severity: 'notice',
    title: 'Row keeps the same URL',
    fix: 'The old and new URL are the same. Fine as documentation, but do not create a redirect rule for it: a URL redirecting to itself loops.',
  },
  'map-duplicate': {
    severity: 'notice',
    title: 'Duplicate row in the map',
    fix: 'The same row appears more than once. Delete the copies so the map stays easy to maintain.',
  },
  'map-row-skipped': {
    severity: 'notice',
    title: 'Map row skipped',
    fix: 'The row did not contain two URLs. Check the CSV.',
  },
};

export function makeIssue(type, detail = '', data = undefined) {
  const def = ISSUES[type];
  if (!def) throw new Error(`Unknown issue type: ${type}`);
  return data === undefined ? { type, severity: def.severity, title: def.title, detail } : { type, severity: def.severity, title: def.title, detail, data };
}

export function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}
