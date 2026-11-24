// The local browser interface: `redirect-map-check ui`.
//
// A small server on 127.0.0.1 that serves one page and a JSON/SSE API around runCheck.
// Security, because any website you visit could try to talk to it:
// - it listens on loopback only;
// - the API needs the session token printed in the terminal. The page reads it from its
//   address once, keeps it in sessionStorage and removes it from the address bar; API calls
//   send it in a header (only the event stream, which can't set headers, uses the query);
// - the Host header must be our own address (stops DNS-rebinding attacks);
// - writes need our exact Origin, a JSON body and the token header (stops cross-site requests);
// - the browser can never make it read a local path: local files come only from uploads or
//   from the command line, sitemap URLs typed in the page must be http(s), and a dropped
//   sitemap index may only point at other files dropped with it;
// - uploads are size-capped, one check runs at a time, temp files are removed afterwards.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCheck } from '../check.js';
import { problemRows, statusChain } from '../report/rows.js';
import { writeReports } from '../write.js';
import { renderPage } from './page.js';

export const DEFAULT_PORT = 47470; // fixed by default, so "Done" marks (per origin) survive a restart
const MAX_BODY = 64 * 1024 * 1024; // uploads arrive base64-encoded in JSON
const MAX_CLIENTS = 8; // event streams; the oldest is closed beyond this
const REPLAY_URLS = 200; // URL events replayed to a page that connects mid-run
const SLOW_CLIENT_BYTES = 1024 * 1024; // above this backlog a stream only gets the important events
const DOWNLOADS = {
  'report.html': 'text/html; charset=utf-8',
  'report.csv': 'text/csv; charset=utf-8',
  'results.json': 'application/json; charset=utf-8',
  'old-pages.json': 'application/json; charset=utf-8',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

// Command-line flags as the page labels them, for messages shown in the page.
const FLAG_LABELS = {
  'old-base': "Old site's address",
  'old-site': 'Old site still online elsewhere',
  base: 'Staging URL',
  snapshot: 'old-pages.json (More options)',
  'new-sitemap': "New site's sitemap",
  'new-urls': 'new-URL list (command line)',
  'new-host': 'Hosts that belong to the new site',
  'ignore-robots': 'Ignore robots.txt',
  'allow-private-network': 'Allow redirects into private network addresses',
  'allow-partial-sitemaps': 'If a child sitemap fails, check the rest',
  'min-suggestion': 'Lowest suggestion score',
  'min-similarity': 'Lowest title match',
  concurrency: 'Requests at once',
  delay: 'Delay between requests',
  timeout: 'Timeout',
  limit: 'Check only the first N URLs',
};
const TICK_FLAGS = new Set(['ignore-robots', 'allow-private-network', 'allow-partial-sitemaps']);
// Only a flag that starts the text or follows a space or "(" is a flag; "/summer-sale--limit" is a URL.
export const forPage = (text) =>
  String(text ?? '')
    .replace(/Pass --old-base \S+ to say which site they belong to/g, "Fill in the old site's address (under the redirect map) to say which site they belong to")
    .replace(/\b(re-run with|pass|add|use)( or)? --([a-z][a-z-]*)(?![\w-])/gi, (m, verb, or, name) => (TICK_FLAGS.has(name) ? `tick “${FLAG_LABELS[name]}”` : m))
    .replace(/(^|[\s(])--([a-z][a-z-]*)(?![\w-])/g, (m, pre, name) => (FLAG_LABELS[name] ? `${pre}“${FLAG_LABELS[name]}”` : m));

const isHttpUrl = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req, limit = MAX_BODY) {
  const tooBig = () => httpError(413, `The upload is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
  if (Number(req.headers['content-length']) > limit) throw tooBig();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooBig();
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'Expected a JSON object.');
  return value;
}

function numberIn(value, name, min, max, integer = true) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw httpError(400, `${name} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  }
  return n;
}

/** URLs: one per line or space. Commas are allowed inside URLs, so they don't separate. */
function urlList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(/\s+/).filter(Boolean);
}
const hostList = (value) => (Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/)).map((v) => v.trim()).filter(Boolean);

/** A file name that is safe inside our folder: no path, no control characters, unique. */
function safeName(raw, taken, fallback) {
  let name = basename(String(raw ?? '')).replace(/[^\w.\-() ]+/g, '_').replace(/^\.+/, '').slice(0, 120) || fallback;
  if (taken.has(name.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let i = 2;
    while (taken.has(`${stem}-${i}${ext}`.toLowerCase())) i += 1;
    name = `${stem}-${i}${ext}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function upload(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.data !== 'string') throw httpError(400, `${label}: expected a file.`);
  return { name: value.name, bytes: Buffer.from(value.data, 'base64') };
}

/**
 * Turn the page's form into runCheck options. Uploaded files are written to a private
 * temp folder under their own names (so an index and its children dropped together still
 * find each other); command-line defaults (paths) are used only when the page asks for them.
 */
async function buildOptions(form, defaults, dir) {
  const options = { localRoot: dir };
  const taken = new Set();
  const save = async (file, fallback) => {
    const path = join(dir, safeName(file.name, taken, fallback));
    await writeFile(path, file.bytes);
    return path;
  };

  const sitemaps = urlList(form.sitemaps);
  for (const s of sitemaps) if (!isHttpUrl(s)) throw httpError(400, `Sitemap "${s.slice(0, 80)}" must be an http(s) URL. Drop a saved file instead.`);
  options.sitemaps = [...sitemaps];
  options.urlLists = [];
  if (form.useDefaultSitemaps) {
    // Local files given on the command line (URLs from there are prefilled in the page instead).
    options.sitemaps.push(...(defaults.sitemaps ?? []).filter((s) => !isHttpUrl(s)));
    options.urlLists.push(...(defaults.urlLists ?? []));
  }

  if (form.oldFiles !== undefined && form.oldFiles !== null && !Array.isArray(form.oldFiles)) throw httpError(400, 'oldFiles: expected a list of files.');
  for (const file of form.oldFiles ?? []) {
    const f = upload(file, 'old URLs file');
    const head = f.bytes.subarray(0, 512);
    const isSitemap = (head[0] === 0x1f && head[1] === 0x8b) || /^\s*(﻿)?</.test(head.toString('utf8'));
    (isSitemap ? options.sitemaps : options.urlLists).push(await save(f, isSitemap ? 'sitemap.xml' : 'urls.txt'));
  }

  const map = upload(form.mapFile, 'redirect map');
  if (map) options.map = await save(map, 'map.csv');
  else if (form.useDefaultMap && defaults.map) options.map = defaults.map;

  const snapshot = upload(form.snapshotFile, 'old-pages.json');
  if (snapshot) options.snapshot = await save(snapshot, 'old-pages.json');
  else if (form.useDefaultSnapshot && defaults.snapshot) options.snapshot = defaults.snapshot;

  for (const [key, label] of [
    ['base', 'Staging URL'],
    ['oldSite', 'Old site copy'],
    ['oldBase', "Old site's address"],
  ]) {
    const v = String(form[key] ?? '').trim();
    if (!v) continue;
    if (!isHttpUrl(v)) throw httpError(400, `${label} must be an http(s) URL.`);
    options[key] = v;
  }

  const newSitemaps = urlList(form.newSitemaps);
  for (const s of newSitemaps) if (!isHttpUrl(s)) throw httpError(400, `New sitemap "${s.slice(0, 80)}" must be an http(s) URL.`);
  options.newSitemaps = newSitemaps;
  options.newUrlLists = [];
  if (form.useDefaultNewFiles) {
    options.newSitemaps.push(...(defaults.newSitemaps ?? []).filter((s) => !isHttpUrl(s)));
    options.newUrlLists.push(...(defaults.newUrlLists ?? []));
  }
  const newHosts = hostList(form.newHosts);
  if (newHosts.length) options.newHosts = newHosts;

  options.concurrency = numberIn(form.concurrency, 'Requests at once', 1, 16);
  options.delayMs = numberIn(form.delay, 'Delay', 0, 60_000);
  options.timeoutMs = numberIn(form.timeout, 'Timeout', 1000, 120_000);
  options.retries = numberIn(form.retries, 'Retries', 0, 5);
  options.maxHops = numberIn(form.maxHops, 'Max redirects per URL', 1, 30);
  options.limit = numberIn(form.limit, 'Check only the first N URLs', 1, 10_000_000);
  options.minSimilarity = numberIn(form.minSimilarity, 'Lowest title match', 0, 1, false);
  options.minSuggestion = numberIn(form.minSuggestion, 'Lowest suggestion score', 0.01, 1, false);
  options.respectRobots = !form.ignoreRobots;
  options.content = !form.noContent;
  options.allowPrivateNetwork = Boolean(form.allowPrivateNetwork);
  options.allowPartialSitemaps = Boolean(form.allowPartialSitemaps);
  for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];

  if (!options.sitemaps.length && !options.urlLists.length && !options.map) {
    throw httpError(400, 'Give at least a sitemap, a URL list or a redirect map.');
  }
  return options;
}

/** What the page may know about command-line defaults: values and file names, never paths. */
function publicDefaults(defaults) {
  const localNames = (list) => (list ?? []).filter((s) => !isHttpUrl(s)).map((s) => basename(s));
  return {
    sitemaps: (defaults.sitemaps ?? []).filter(isHttpUrl),
    localOld: [...localNames(defaults.sitemaps), ...localNames(defaults.urlLists)],
    map: defaults.map ? basename(defaults.map) : null,
    snapshot: defaults.snapshot ? basename(defaults.snapshot) : null,
    base: defaults.base ?? '',
    oldBase: defaults.oldBase ?? '',
    oldSite: defaults.oldSite ?? '',
    newSitemaps: (defaults.newSitemaps ?? []).filter(isHttpUrl),
    localNew: [...localNames(defaults.newSitemaps), ...(defaults.newUrlLists ?? []).map((s) => (isHttpUrl(s) ? s : basename(s)))],
    newHosts: defaults.newHosts ?? [],
    ignoreRobots: Boolean(defaults.ignoreRobots),
    noContent: Boolean(defaults.noContent),
    allowPrivateNetwork: Boolean(defaults.allowPrivateNetwork),
    allowPartialSitemaps: Boolean(defaults.allowPartialSitemaps),
    numbers: Object.fromEntries(
      ['delay', 'concurrency', 'timeout', 'retries', 'maxHops', 'limit', 'minSimilarity', 'minSuggestion']
        .filter((k) => defaults[k] !== undefined && defaults[k] !== null && defaults[k] !== '')
        .map((k) => [k, String(defaults[k])]),
    ),
  };
}

/** Replace our temp folder in any string inside a value (notes, issue details). */
function scrubDeep(value, prefixes, depth = 0) {
  if (typeof value === 'string') return prefixes.reduce((s, p) => s.split(p).join(''), value);
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = scrubDeep(value[i], prefixes, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) value[key] = scrubDeep(value[key], prefixes, depth + 1);
  return value;
}

/** Start the interface. Returns { url, port, token, close() }. */
export async function startUi({ port = 0, open = true, defaults = {}, version = '', userAgent, outDir = 'redirect-report', openBrowser, maxBody = MAX_BODY, log = () => {} } = {}) {
  const token = randomBytes(24).toString('hex');
  let current = { events: [], recentUrls: [], status: 'idle' }; // the last (or running) check
  const clients = new Set();
  let busy = false; // reserved synchronously, so two requests can't both start a check
  let actualPort = port;
  let launcherDir = null;

  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));
  const origin = () => `http://127.0.0.1:${actualPort}`;

  const write = (client, event) => {
    // A stream that isn't keeping up gets only the events that matter (no per-URL noise).
    if ((event.type === 'url' || event.type === 'progress') && client.writableLength > SLOW_CLIENT_BYTES) return;
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const emit = (state, event) => {
    if (state !== current) return; // a cancelled check that is still winding down
    if (event.type === 'url') {
      state.recentUrls.push(event);
      if (state.recentUrls.length > REPLAY_URLS) state.recentUrls.shift();
    } else if (event.type === 'progress') {
      state.progress = event;
    } else {
      state.events.push(event);
    }
    for (const client of clients) write(client, event);
  };
  const replay = (client) => {
    const terminal = current.events.filter((e) => ['done', 'cancelled', 'error'].includes(e.type));
    for (const e of current.events) if (!terminal.includes(e)) write(client, e);
    if (current.progress) write(client, current.progress);
    for (const e of current.recentUrls) write(client, e);
    for (const e of terminal) write(client, e);
  };

  async function startRun(form) {
    if (busy) throw httpError(409, 'A check is already running. Cancel it first.');
    busy = true;
    let dir;
    let inputs;
    let options;
    try {
      dir = await mkdtemp(join(tmpdir(), 'rmc-ui-'));
      inputs = join(dir, 'in');
      await mkdir(inputs);
      options = await buildOptions(form, defaults, inputs);
    } catch (err) {
      busy = false;
      if (dir) await rm(dir, { recursive: true, force: true });
      throw err;
    }
    if (current.dir) await rm(current.dir, { recursive: true, force: true });
    const controller = new AbortController();
    const state = { controller, events: [], recentUrls: [], progress: null, status: 'running', dir, reportDir: join(dir, 'report'), run: null };
    current = state;
    const prefixes = [inputs + sep, dir + sep, inputs, dir];
    const clean = (text) => forPage(scrubDeep(String(text ?? ''), prefixes));
    emit(state, { type: 'start', at: Date.now() });

    runCheck({
      ...options,
      userAgent,
      signal: controller.signal,
      onPhase: (name, detail) => emit(state, { type: 'phase', name, ...detail }),
      onProgress: (done, total) => emit(state, { type: 'progress', done, total }),
      onUrlDone: (r) => emit(state, { type: 'url', oldUrl: r.oldUrl, chain: statusChain(r), finalUrl: r.chain.finalUrl, finalStatus: r.chain.finalStatus }),
    })
      .then(async (run) => {
        if (controller.signal.aborted) throw Object.assign(new Error('The check was cancelled.'), { code: 'ECANCELLED' });
        scrubDeep(run.notes, prefixes);
        scrubDeep(run.mapRowIssues, prefixes);
        for (const r of run.results) scrubDeep(r.issues, prefixes);
        state.run = run;
        await writeReports(run, state.reportDir, { version });
        state.status = 'done';
        busy = false; // before the event, so the page can start the next check straight away
        emit(state, { type: 'done', summary: run.summary });
      })
      .catch((err) => {
        state.status = err?.code === 'ECANCELLED' || controller.signal.aborted ? 'cancelled' : 'failed';
        busy = false;
        emit(state, state.status === 'cancelled' ? { type: 'cancelled', message: 'The check was cancelled.' } : { type: 'error', message: clean(err?.message ?? err) });
      })
      .finally(async () => {
        // Uploaded inputs are no longer needed; the reports stay until the next run or exit.
        busy = false;
        await rm(inputs, { recursive: true, force: true });
      });
  }

  function results() {
    const run = current.run;
    if (!run) return null;
    return {
      summary: run.summary,
      notes: run.notes.map(forPage),
      hasOldPages: !run.oldPagesFromSnapshot && Object.keys(run.oldPages).length > 0,
      problems: problemRows(run).map((r) => ({
        severity: r.severity,
        type: r.type,
        title: r.title,
        detail: forPage(r.detail),
        fix: forPage(r.fix),
        oldUrl: r.oldUrl,
        expectedUrl: r.expectedUrl,
        finalUrl: r.finalUrl,
        statusChain: r.statusChain,
        suggestions: (r.suggestions ?? []).map((s) => ({ url: s.url, title: s.title || s.h1 || '', confidence: s.confidence, score: s.score })),
      })),
    };
  }

  const server = createServer(async (req, res) => {
    try {
      // 1. Only our own address (DNS rebinding sends a foreign Host header).
      if (!allowedHosts().has(String(req.headers.host ?? '').toLowerCase())) return send(res, 403, 'Host not allowed.');
      const url = new URL(req.url, origin());
      const path = url.pathname;
      const headerToken = req.headers['x-rmc-token'];

      if (req.method === 'GET' && path === '/') {
        // The page itself holds no data, so it needs no token: it reads the token from its
        // address (then removes it) or from sessionStorage, and sends it with every API call.
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        return res.end(renderPage({ nonce, version }));
      }

      // 2. Everything else needs the token: in a header, or in the query for the event stream.
      if (req.method === 'GET') {
        const given = path === '/api/events' ? url.searchParams.get('t') : headerToken;
        if (!sameToken(given, token)) return send(res, 403, 'Missing or wrong access token. Open the address printed in the terminal.');
      } else if (req.method === 'POST') {
        const reqOrigin = req.headers.origin;
        if (reqOrigin !== undefined && !allowedOrigins().has(String(reqOrigin).toLowerCase())) return send(res, 403, 'Cross-site request refused.');
        if (!sameToken(headerToken, token)) return send(res, 403, 'Missing or wrong access token.');
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, 'Expected JSON.');
      } else {
        return send(res, 405, 'Method not allowed.');
      }

      if (req.method === 'GET' && path === '/api/defaults') return send(res, 200, publicDefaults(defaults));

      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (clients.size >= MAX_CLIENTS) [...clients][0].end();
        clients.add(res);
        replay(res);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
        const drop = () => {
          clearInterval(keepAlive);
          clients.delete(res);
        };
        req.on('close', drop);
        res.on('close', drop);
        return undefined;
      }

      if (req.method === 'GET' && path === '/api/results') {
        const data = results();
        return data ? send(res, 200, data) : send(res, 404, 'No finished check yet.');
      }

      if (req.method === 'GET' && path.startsWith('/api/download/')) {
        const name = path.slice('/api/download/'.length);
        if (!Object.hasOwn(DOWNLOADS, name) || !current.run) return send(res, 404, 'Not found.');
        let body;
        try {
          body = await readFile(join(current.reportDir, name));
        } catch {
          return send(res, 404, 'Not found.');
        }
        return send(res, 200, body, {
          'content-type': DOWNLOADS[name],
          'content-disposition': `attachment; filename="${name}"`,
          ...(name === 'report.html' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox" } : {}),
        });
      }

      if (req.method === 'POST' && path === '/api/run') {
        const form = await readJson(req, maxBody);
        await startRun(form);
        return send(res, 202, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/cancel') {
        await readJson(req, 64 * 1024);
        if (current.status === 'running') current.controller.abort();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/save') {
        const body = await readJson(req, 64 * 1024);
        if (!current.run) return send(res, 409, { error: 'There is no finished check to save yet.' });
        const target = resolve(outDir);
        const exists = await access(join(target, 'report.html')).then(() => true, () => false);
        // Not an error: the page asks the user and sends overwrite: true if they agree.
        if (exists && !body.overwrite) return send(res, 200, { ok: false, exists: true, path: target });
        await writeReports(current.run, target, { version });
        return send(res, 200, { ok: true, path: target });
      }

      return send(res, 404, 'Not found.');
    } catch (err) {
      // After refusing an oversized upload, close the connection: the rest of the body is still
      // in flight, and a kept-alive socket would make the browser's next request wait behind it.
      const closing = err?.status === 413 ? { connection: 'close' } : {};
      return send(res, err?.status ?? 500, { error: err?.message ?? 'Something went wrong.' }, closing);
    }
  });

  await new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', r);
  });
  actualPort = server.address().port;
  const address = `${origin()}/?t=${token}`;
  log(address);
  if (open) {
    // Open a small private file that forwards to the address, so the token isn't in the
    // browser launcher's command line (visible to other users in `ps`).
    launcherDir = await mkdtemp(join(tmpdir(), 'rmc-open-'));
    const launcher = join(launcherDir, 'open.html');
    await writeFile(launcher, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${address}"><title>redirect-map-check</title><p>Opening redirect-map-check…</p>`, { mode: 0o600 });
    (openBrowser ?? (await import('../open.js')).openInBrowser)(pathToFileURL(launcher).href);
    setTimeout(() => rm(launcherDir, { recursive: true, force: true }).catch(() => {}), 60_000).unref();
  }

  return {
    url: address,
    port: actualPort,
    token,
    async close() {
      if (current.status === 'running') current.controller.abort();
      for (const client of clients) client.end();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      if (current.dir) await rm(current.dir, { recursive: true, force: true });
      if (launcherDir) await rm(launcherDir, { recursive: true, force: true });
    },
  };
}
