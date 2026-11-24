#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runCheck } from '../src/check.js';
import { openInBrowser } from '../src/open.js';
import { pathToFileURL } from 'node:url';
import { renderSummary } from '../src/report/terminal.js';
import { writeReports } from '../src/write.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TOOL_URL = 'https://itcrowd.work/tools/redirect-map-check/';

const HELP = `redirect-map-check v${pkg.version}
Check a website migration's redirects against the redirect map.

Usage
  npx redirect-map-check --sitemap <url|file> --map <redirects.csv> [options]
  npx redirect-map-check ui [options]      Open the browser interface (local only)

Inputs
  --sitemap <url|file>     Old site's sitemap (index and .gz supported). Repeatable.
  --urls <file|url>        Plain list of old URLs, one per line. Repeatable.
  --map <file|url>         Redirect map CSV: old URL, new URL (header optional).
  --base <url>             Test against this host instead (e.g. staging before launch).
  --old-base <url>         Origin of the old site, for relative URLs in the inputs.
  --allow-partial-sitemaps If a child sitemap fails, check the rest and report it as
                           an error (by default the run stops).
  --old-site <url>         A copy of the old site that is still live, used to read
                           old titles/H1s after launch (e.g. the old *.webflow.io).
  --snapshot <file>        old-pages.json from an earlier run, for the same purpose.
  --new-sitemap <url|file> The new site's sitemap. We read its titles so the
                           recommended fixes can name the closest live pages.
  --new-urls <file|url>    Same, from a plain list of the new site's URLs.
  --new-host <host>        A host that belongs to the new site (e.g. after a domain
                           change), so its URLs are rewritten onto --base. Repeatable.

Crawling (polite by default)
  --concurrency <n>        Parallel requests (default 4, max 16).
  --delay <ms>             Minimum gap between requests to one host (default 250).
  --timeout <ms>           Per-request timeout (default 15000).
  --retries <n>            Retries for 429/503/network errors (default 1).
  --max-hops <n>           Redirects to follow per URL (default 10).
  --user-agent <string>    Override the User-Agent.
  --ignore-robots          Skip robots.txt. Only for sites you own (staging often
                           blocks everything).
  --allow-private-network  Allow redirects and sitemap entries that lead to loopback
                           or private addresses. Hosts you name in the inputs
                           (e.g. a local --base) are always allowed.
  --limit <n>              Check only the first n URLs.

Checks and output
  --min-similarity <0-1>   Title/H1 overlap below this is an unrelated page (default 0.25).
  --min-suggestion <0-1>   Lowest match score for a suggested page (default 0.5;
                           0.75 and up is labelled strong).
  --no-content             Skip the title/H1 comparison.
  --out <dir>              Report folder (default ./redirect-report).
  --fail-on <level>        Exit 1 on "error" (default), "warning", or "never".
  --open                   Open report.html in your browser when the check finishes.
  --no-color               Plain terminal output.
  -q, --quiet              Only print the summary.
  -h, --help               Show this help.
  -v, --version            Show the version.

Browser interface (redirect-map-check ui)
  Starts a page on this computer (127.0.0.1 only) where you pick the files, watch
  the check run and work through the results. Any input flag above (--sitemap,
  --map, --base, --new-sitemap, --old-site, --snapshot, --ignore-robots) fills in
  the form. Extra flags:
  --port <n>               Port to listen on (default 47470, or a free one if that's taken).
  --no-open                Don't open the browser; just print the address.

Docs: ${TOOL_URL}`;

function fail(message) {
  process.stderr.write(`redirect-map-check: ${message}\nRun with --help for usage.\n`);
  process.exit(2);
}

function integer(value, name, { min = 0, max = Infinity } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number between ${min} and ${max}`);
  return n;
}

let parsed;
const subcommand = process.argv[2] === 'ui' ? 'ui' : null;
try {
  parsed = parseArgs({
    args: process.argv.slice(subcommand ? 3 : 2),
    allowPositionals: false,
    options: {
      sitemap: { type: 'string', multiple: true },
      urls: { type: 'string', multiple: true },
      map: { type: 'string' },
      base: { type: 'string' },
      'old-base': { type: 'string' },
      'old-site': { type: 'string' },
      snapshot: { type: 'string' },
      'new-sitemap': { type: 'string', multiple: true },
      'new-urls': { type: 'string', multiple: true },
      'new-host': { type: 'string', multiple: true },
      'allow-private-network': { type: 'boolean' },
      'allow-partial-sitemaps': { type: 'boolean' },
      'min-suggestion': { type: 'string' },
      concurrency: { type: 'string' },
      delay: { type: 'string' },
      timeout: { type: 'string' },
      retries: { type: 'string' },
      'max-hops': { type: 'string' },
      'user-agent': { type: 'string' },
      'ignore-robots': { type: 'boolean' },
      limit: { type: 'string' },
      'min-similarity': { type: 'string' },
      'no-content': { type: 'boolean' },
      out: { type: 'string' },
      'fail-on': { type: 'string' },
      'no-color': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      open: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  fail(err.message);
}

const a = parsed.values;
if (a.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (a.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (subcommand === 'ui') {
  for (const [name, value] of [['base', a.base], ['old-base', a['old-base']], ['old-site', a['old-site']]]) {
    if (value !== undefined && !/^https?:\/\/[^/]/i.test(value)) fail(`--${name} must be an http(s) URL`);
  }
  const { startUi, DEFAULT_PORT } = await import('../src/ui/server.js');
  const chosen = integer(a.port, 'port', { min: 0, max: 65535 });
  const local = (v) => (/^https?:\/\//i.test(v) ? v : resolve(v));
  const settings = {
    port: chosen ?? DEFAULT_PORT,
    open: !a['no-open'],
    version: pkg.version,
    userAgent: a['user-agent'] ?? `redirect-map-check/${pkg.version} (+${TOOL_URL})`,
    outDir: a.out ?? 'redirect-report',
    // Every input flag becomes a default in the form. Local paths stay on this side: the page
    // only learns file names.
    defaults: {
      sitemaps: (a.sitemap ?? []).map(local),
      urlLists: (a.urls ?? []).map(local),
      map: a.map ? resolve(a.map) : undefined,
      snapshot: a.snapshot ? resolve(a.snapshot) : undefined,
      base: a.base,
      oldBase: a['old-base'],
      oldSite: a['old-site'],
      newSitemaps: (a['new-sitemap'] ?? []).map(local),
      newUrlLists: (a['new-urls'] ?? []).map(local),
      newHosts: a['new-host'] ?? [],
      ignoreRobots: Boolean(a['ignore-robots']),
      noContent: Boolean(a['no-content']),
      allowPrivateNetwork: Boolean(a['allow-private-network']),
      allowPartialSitemaps: Boolean(a['allow-partial-sitemaps']),
      delay: a.delay,
      concurrency: a.concurrency,
      timeout: a.timeout,
      retries: a.retries,
      maxHops: a['max-hops'],
      limit: a.limit,
      minSimilarity: a['min-similarity'],
      minSuggestion: a['min-suggestion'],
    },
  };
  let ui;
  try {
    ui = await startUi(settings);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') fail(err.message);
    if (chosen !== undefined) fail(`port ${chosen} is in use; pick another with --port`);
    // Our usual port is taken (another copy running?): use any free one.
    ui = await startUi({ ...settings, port: 0 }).catch((e) => fail(e.message));
  }
  process.stdout.write(`\nredirect-map-check is running at\n\n  ${ui.url}\n\n${a['no-open'] ? 'Open that address in your browser.' : 'It should open in your browser; if not, open that address.'} The address includes a private access token: don't share it.\nPress Ctrl+C to stop.\n`);
  const stop = async () => {
    await ui.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
if (!a.sitemap && !a.urls && !a.map) fail('give at least --sitemap, --urls or --map');

for (const [name, value] of [['base', a.base], ['old-base', a['old-base']], ['old-site', a['old-site']]]) {
  if (value !== undefined && !/^https?:\/\/[^/]/i.test(value)) fail(`--${name} must be an http(s) URL`);
}
const failOn = a['fail-on'] ?? 'error';
if (!['error', 'warning', 'never'].includes(failOn)) fail('--fail-on must be error, warning or never');
const minSuggestion = a['min-suggestion'] === undefined ? undefined : Number(a['min-suggestion']);
if (minSuggestion !== undefined && !(minSuggestion > 0 && minSuggestion <= 1)) fail('--min-suggestion must be above 0 and at most 1');
const minSimilarity = a['min-similarity'] === undefined ? undefined : Number(a['min-similarity']);
if (minSimilarity !== undefined && !(minSimilarity >= 0 && minSimilarity <= 1)) fail('--min-similarity must be between 0 and 1');

const color = !a['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY;
const showProgress = !a.quiet && process.stderr.isTTY;

const options = {
  sitemaps: a.sitemap ?? [],
  urlLists: a.urls ?? [],
  map: a.map,
  base: a.base,
  oldBase: a['old-base'],
  oldSite: a['old-site'],
  snapshot: a.snapshot,
  newSitemaps: a['new-sitemap'],
  newUrlLists: a['new-urls'],
  newHosts: a['new-host'],
  allowPrivateNetwork: Boolean(a['allow-private-network']),
  allowPartialSitemaps: Boolean(a['allow-partial-sitemaps']),
  minSuggestion,
  concurrency: integer(a.concurrency, 'concurrency', { min: 1, max: 16 }),
  delayMs: integer(a.delay, 'delay', { min: 0, max: 60_000 }),
  timeoutMs: integer(a.timeout, 'timeout', { min: 1000, max: 120_000 }),
  retries: integer(a.retries, 'retries', { min: 0, max: 5 }),
  maxHops: integer(a['max-hops'], 'max-hops', { min: 1, max: 30 }),
  limit: integer(a.limit, 'limit', { min: 1 }),
  minSimilarity,
  respectRobots: !a['ignore-robots'],
  content: !a['no-content'],
  userAgent: a['user-agent'] ?? `redirect-map-check/${pkg.version} (+${TOOL_URL})`,
  onProgress: showProgress ? (done, total) => process.stderr.write(`\rChecking ${done}/${total} URLs…`) : undefined,
};
for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];

// Check the output folder before a long crawl, not after it.
const outDir = a.out ?? 'redirect-report';
try {
  await mkdir(outDir, { recursive: true });
  if (!(await stat(outDir)).isDirectory()) throw new Error('not a folder');
  await access(outDir, constants.W_OK);
} catch (err) {
  fail(`can't write reports to ${outDir} (${err.code ?? err.message})`);
}
if (a.snapshot && resolve(a.snapshot) === resolve(join(outDir, 'old-pages.json'))) {
  process.stderr.write(`Note: ${a.snapshot} is in the report folder; it will be left as it is (we never overwrite a --snapshot file).\n`);
}

try {
  const run = await runCheck(options);
  if (showProgress) process.stderr.write('\r\x1b[K');
  const files = await writeReports(run, outDir, { version: pkg.version });
  const shown = [`Report:    ${relative(process.cwd(), files.html)}`, `CSV:       ${relative(process.cwd(), files.csv)}`];
  if (files.snapshot) shown.push(`Old pages: ${relative(process.cwd(), files.snapshot)} (keep it: reuse after launch with --snapshot)`);
  process.stdout.write(renderSummary(run, { color, files: shown }));

  const { error, warning } = run.summary.bySeverity;
  const failed = (failOn === 'error' && error > 0) || (failOn === 'warning' && error + warning > 0);
  process.exitCode = failed ? 1 : 0;
  if (a.open) openInBrowser(pathToFileURL(resolve(files.html)).href);
} catch (err) {
  if (showProgress) process.stderr.write('\n');
  process.stderr.write(`redirect-map-check: ${err.message}\n`);
  process.exitCode = 2;
}
}
