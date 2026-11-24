// The polite fetcher. Built on node:http/https rather than fetch so that:
// - every request, including each redirect hop, goes through the per-host delay;
// - private network addresses are refused at connect time (checked on the resolved
//   IP, so DNS rebinding can't get round it), unless the run's own inputs live there;
// - decompressed bodies are capped, so a gzip bomb can't exhaust memory;
// - only http and https are ever requested.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { isAllowed, parseRobots, selectGroup } from './robots.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
const MAX_CRAWL_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_429_DELAY_MS = 30_000;
const DISCARD_LIMIT = 64 * 1024; // read at most this much of a body we don't need, then drop the socket
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED', 'UND_ERR_SOCKET']);

// Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges.
const PRIVATE = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) PRIVATE.addSubnet(ip, bits, 'ipv6');
// ::/96 covers the deprecated IPv4-compatible forms such as ::7f00:1.

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];
const defaultPort = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
const bare = (host) => String(host).toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackName = (name) => name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127\./.test(name);
const isLoopbackAddress = (ip) => ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./i.test(ip);

/** Politeness is per site: http/https and www/apex share one delay; other ports are other servers. */
function siteOf(url) {
  const host = bare(url.hostname).replace(/^www\./, '');
  const port = defaultPort(url);
  return port === '80' || port === '443' ? host : `${host}:${port}`;
}

/** True for loopback, private, link-local and other non-public addresses (incl. IPv4-mapped IPv6). */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE.check(ip, 'ipv4');
  if (family === 6) return PRIVATE.check(ip, 'ipv6');
  return false;
}

class Semaphore {
  constructor(size) {
    this.free = size;
    this.waiting = [];
  }
  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function describeError(err, url) {
  const code = err?.code ?? err?.cause?.code;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  switch (code) {
    case 'ENOTFOUND':
      return { code, message: `DNS lookup failed for ${host}` };
    case 'EAI_AGAIN':
      return { code, message: `DNS lookup timed out for ${host}` };
    case 'ECONNREFUSED':
      return { code, message: `Connection refused by ${host}` };
    case 'ECONNRESET':
      return { code, message: `Connection reset by ${host}` };
    case 'ETIMEDOUT':
      return { code, message: err.message || `Timed out (${host})` };
    case 'EPRIVATE':
      return { code, message: err.message };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { code: 'ETLS', message: `TLS certificate problem on ${host} (${code})` };
    default:
      return { code: code ?? 'EREQUEST', message: err?.message ?? String(err) };
  }
}

export class Fetcher {
  constructor({
    userAgent,
    productToken,
    concurrency = 4,
    delayMs = 0,
    timeoutMs = 15_000,
    retries = 1,
    retryBaseMs = 1000,
    respectRobots = true,
    maxBodyBytes = 2 * 1024 * 1024,
    allowPrivateNetwork = false,
    lookup = dns.lookup, // injectable for tests
    notes = [],
    signal, // AbortSignal: cancels waits and requests in flight
  }) {
    this.signal = signal;
    this.dnsLookup = lookup;
    this.userAgent = userAgent;
    this.productToken = productToken;
    this.delayMs = delayMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryBaseMs = retryBaseMs;
    this.respectRobots = respectRobots;
    this.maxBodyBytes = maxBodyBytes;
    this.allowPrivateNetwork = allowPrivateNetwork;
    this.trust = new Map(); // host name you named → { ports, addresses, loopback }
    this.notes = notes;
    this.semaphore = new Semaphore(Math.max(1, concurrency));
    this.sites = new Map(); // politeness state per site
    this.robots = new Map(); // robots.txt per origin
    this.requestCount = 0;
    // The semaphore limits requests in flight; the agents don't, so a socket that is still
    // draining an unwanted body never makes the next request wait (and time out) for a slot.
    this.agents = {
      'http:': new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: Math.max(1, concurrency) }),
      'https:': new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: Math.max(1, concurrency) }),
    };
    // A lookup bound to the host name and port we're connecting to. Private addresses
    // are allowed only for host names you named in the inputs (see trustHost).
    this.lookupFor = (hostname, port) => (name, options, callback) => {
      const opts = typeof options === 'object' && options !== null ? options : { family: options };
      this.dnsLookup(name, { ...opts, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const bad = addresses.find((a) => !this.addressAllowed(a.address, port, hostname));
        if (bad) {
          const error = new Error(`${name} resolves to ${bad.address}, a private network address`);
          error.code = 'EPRIVATE';
          return callback(error);
        }
        if (opts.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      });
    };
  }

  addressAllowed(address, port, hostname) {
    if (this.allowPrivateNetwork || !isPrivateAddress(address)) return true;
    const entry = this.trust.get(bare(hostname ?? address));
    if (!entry || !entry.ports.has(String(port))) return false;
    const ip = bare(address);
    return entry.loopback ? isLoopbackAddress(ip) : entry.addresses.has(ip);
  }

  /**
   * The run's own inputs may live on a private network (local staging, the demo). Trust
   * the host name you named, on its port and on 80/443 (http→https on the same host),
   * and only for the private addresses it resolved to when you named it, so a later DNS
   * change can't point it somewhere else. Loopback names (localhost, 127.0.0.1, ::1) are
   * one host, trusted on the named port only (no 80/443 extension for loopback).
   */
  async trustHost(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const name = bare(url.hostname);
    const port = defaultPort(url);
    const add = (n, ports, addresses, loopback) => {
      if (!this.trust.has(n)) this.trust.set(n, { ports: new Set(), addresses: new Set(), loopback: false });
      const entry = this.trust.get(n);
      for (const p of ports) entry.ports.add(p);
      for (const a of addresses) entry.addresses.add(a);
      entry.loopback ||= loopback;
    };
    if (isLoopbackName(name)) {
      // Your own machine: only the port you named, so a crawled page can't reach other local services.
      for (const n of new Set([name, ...LOOPBACK_NAMES])) add(n, [port], [], true);
      return;
    }
    let addresses = [];
    if (net.isIP(name)) addresses = [name];
    else {
      try {
        addresses = (await new Promise((resolve, reject) => this.dnsLookup(name, { all: true }, (e, a) => (e ? reject(e) : resolve(a))))).map((a) => bare(a.address));
      } catch {
        addresses = [];
      }
    }
    add(name, [port, '80', '443'], addresses.filter(isPrivateAddress), false);
  }

  close() {
    for (const agent of Object.values(this.agents)) agent.destroy();
  }

  site(url) {
    const key = siteOf(url);
    if (!this.sites.has(key)) this.sites.set(key, { key, nextAt: 0, lastStart: 0, delayMs: this.delayMs, backedOff: false });
    return this.sites.get(key);
  }

  /** Wait for this site's next slot and a free connection; never start two requests to a site closer than its delay. */
  async turn(url) {
    const state = this.site(url);
    for (;;) {
      if (this.signal?.aborted) {
        // Cancelled: return at once (the caller sees the abort and releases the slot).
        await this.semaphore.acquire();
        return;
      }
      const now = Date.now();
      const start = Math.max(now, state.nextAt, state.lastStart + state.delayMs);
      state.nextAt = start + state.delayMs;
      if (start > now) await sleep(start - now, this.signal);
      await this.semaphore.acquire();
      if (Date.now() - state.lastStart >= state.delayMs || state.lastStart === 0) {
        state.lastStart = Date.now();
        return;
      }
      this.semaphore.release();
    }
  }

  /** One HTTP GET, no redirect following. Never throws. */
  async once(url, { wantBody = false, maxBytes } = {}) {
    const base = { status: 0, location: null, contentType: '', retryAfter: null, finalUrl: url, body: null, truncated: false, error: null, errorCode: null };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ...base, error: `Invalid URL: ${String(url).slice(0, 200)}`, errorCode: 'EINVALIDURL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ...base, error: `Not a web address (${parsed.protocol})`, errorCode: 'ENOTHTTP' };
    }
    const literal = bare(parsed.hostname);
    const port = defaultPort(parsed);
    if (net.isIP(literal) && !this.addressAllowed(literal, port, literal)) {
      return { ...base, error: `${literal} is a private network address`, errorCode: 'EPRIVATE' };
    }

    if (this.signal?.aborted) return { ...base, error: 'Cancelled', errorCode: 'ECANCELLED' };
    await this.turn(parsed);
    if (this.signal?.aborted) {
      this.semaphore.release();
      return { ...base, error: 'Cancelled', errorCode: 'ECANCELLED' };
    }
    this.requestCount += 1;
    try {
      return await this.send(parsed, wantBody, maxBytes ?? this.maxBodyBytes, base);
    } finally {
      this.semaphore.release();
    }
  }

  send(url, wantBody, maxBytes, base) {
    return new Promise((resolve) => {
      const lib = url.protocol === 'https:' ? https : http;
      let settled = false;
      let timer = null;
      let result = null; // set once headers arrive
      let finishPartial = null; // set once we're reading a body
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let req;
      try {
        req = lib.request(url, {
          method: 'GET',
          agent: this.agents[url.protocol],
          lookup: this.lookupFor(bare(url.hostname), defaultPort(url)),
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
          },
        });
      } catch (err) {
        const e = describeError(err, url.href);
        done({ ...base, error: e.message, errorCode: e.code });
        return;
      }
      const onAbort = () => {
        const err = new Error('Cancelled');
        err.code = 'ECANCELLED';
        req.destroy(err);
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => this.signal?.removeEventListener('abort', onAbort));
      timer = setTimeout(() => {
        if (finishPartial) {
          // Headers (and maybe part of the body) arrived: keep the status, return what we have.
          finishPartial(true, true);
          req.destroy();
          return;
        }
        const err = new Error(`Timed out after ${this.timeoutMs} ms`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      }, this.timeoutMs);

      req.on('error', (err) => {
        if (finishPartial) return finishPartial(true);
        const e = describeError(err, url.href);
        done({ ...base, error: e.message, errorCode: e.code });
      });

      req.on('response', (res) => {
        result = {
          ...base,
          status: res.statusCode,
          location: res.headers.location ?? null,
          contentType: String(res.headers['content-type'] ?? ''),
          retryAfter: res.headers['retry-after'] ?? null,
          finalUrl: url.href,
        };
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!wantBody || !ok) {
          // The status is all we need: answer now, then drain a little so the
          // connection can be reused, dropping it if the body is big or slow.
          done(result);
          let seen = 0;
          const drainTimer = setTimeout(() => res.destroy(), 500);
          const stop = () => clearTimeout(drainTimer);
          res.on('data', (chunk) => {
            seen += chunk.length;
            if (seen > DISCARD_LIMIT) {
              stop();
              res.destroy();
            }
          });
          res.on('end', stop);
          res.on('close', stop);
          res.on('error', stop);
          return;
        }

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
        const chunks = [];
        let size = 0;
        let decoder = null;
        let ended = false;
        let rawBytes = 0;
        let tail = Buffer.alloc(0); // last 8 raw bytes: the gzip trailer (CRC32, ISIZE)
        finishPartial = (truncated, timedOut = false) => {
          if (settled) return;
          result.body = Buffer.concat(chunks).subarray(0, maxBytes);
          result.truncated = truncated;
          if (timedOut) result.bodyTimedOut = true;
          if (truncated && size === 0 && !timedOut) {
            result.error = 'The connection closed before the page arrived';
            result.errorCode = 'EBODY';
          }
          done(result);
        };
        const onData = (chunk) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) {
            finishPartial(true);
            res.destroy();
            decoder?.destroy();
          }
        };
        const makeDecoder = (first) => {
          const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
          if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip(flush);
          if (encoding === 'br') return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
          if (encoding === 'deflate') {
            // "deflate" is meant to be zlib-wrapped, but some servers send raw deflate (browsers accept both).
            const zlibHeader = first.length >= 2 && (first[0] & 0x0f) === 8 && ((first[0] << 8) | first[1]) % 31 === 0;
            return zlibHeader ? zlib.createInflate(flush) : zlib.createInflateRaw(flush);
          }
          return null;
        };
        const needsDecoder = ['gzip', 'x-gzip', 'br', 'deflate'].includes(encoding);
        const gzipIncomplete = () => {
          if (encoding !== 'gzip' && encoding !== 'x-gzip') return false;
          if (rawBytes < 18 || tail.length < 8) return true; // header only, or less
          return tail.readUInt32LE(4) !== size % 2 ** 32; // ISIZE must match what we decoded
        };
        const attach = (d) => {
          d.on('data', onData);
          d.on('end', () => {
            if (settled) return;
            if (size === 0 && (gzipIncomplete() || !ended)) {
              done({ ...result, error: `The ${encoding} body ended before any content`, errorCode: 'EBODY' });
              return;
            }
            finishPartial(!ended || gzipIncomplete());
          });
          d.on('error', (err) => {
            if (size > 0) finishPartial(true);
            else if (!settled) done({ ...result, error: `Could not decode the ${encoding} body (${err.message})`, errorCode: 'EDECODE' });
          });
        };

        res.on('data', (chunk) => {
          rawBytes += chunk.length;
          if (needsDecoder) tail = Buffer.concat([tail, chunk]).subarray(-8);
          if (!needsDecoder) return onData(chunk);
          if (!decoder) {
            decoder = makeDecoder(chunk);
            attach(decoder);
          }
          decoder.write(chunk);
        });
        res.on('end', () => {
          ended = res.complete;
          if (decoder) decoder.end();
          else if (needsDecoder) finishPartial(false); // empty compressed body
          else finishPartial(!res.complete);
        });
        res.on('close', () => {
          if (settled) return;
          // Closed before the end: whatever arrived is a partial body.
          if (decoder) decoder.end();
          else finishPartial(true);
        });
        res.on('error', () => {
          if (decoder) decoder.end();
          else finishPartial(true);
        });
      });
      req.end();
    });
  }

  /** Request with retries for 429 / 503 and transient network errors. */
  async request(url, options = {}) {
    let attempt = 0;
    for (;;) {
      const result = await this.once(url, options);
      if (result.status === 429) this.backOff(url);
      const transient = result.status === 0 && RETRY_CODES.has(result.errorCode);
      const retryable = transient || result.status === 429 || result.status === 503;
      if (!retryable || attempt >= this.retries) return { ...result, attempts: attempt + 1 };
      const hinted = retryAfterMs(result.retryAfter);
      if (hinted !== null && hinted > MAX_RETRY_AFTER_MS) {
        // The server asked us to wait longer than we're willing to; report it rather than retry early.
        return { ...result, attempts: attempt + 1, retryAfterMs: hinted };
      }
      attempt += 1;
      if (this.signal?.aborted) return { ...result, attempts: attempt + 1 };
      await sleep(hinted ?? this.retryBaseMs * 2 ** (attempt - 1), this.signal);
    }
  }

  backOff(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const origin = parsed.origin;
    const state = this.site(parsed);
    const next = Math.min(Math.max(state.delayMs * 2, 1000), MAX_429_DELAY_MS);
    if (next > state.delayMs) {
      state.delayMs = next;
      if (!state.backedOff) {
        state.backedOff = true;
        this.notes.push(`${origin} answered 429 Too Many Requests, so we slowed down to one request every ${next / 1000}s there.`);
      }
    }
  }

  /**
   * Follow redirects ourselves (every hop through the delay and, optionally, robots.txt).
   * Returns the final response plus { finalUrl, hops, blocked }.
   */
  async follow(url, { wantBody = false, maxBytes, checkRobots = false, maxHops = 10 } = {}) {
    let current = url;
    const hops = [];
    for (let i = 0; i <= maxHops; i += 1) {
      if (checkRobots) {
        const verdict = await this.robotsCheck(current);
        if (!verdict.allowed) return { status: 0, error: verdict.reason, errorCode: 'EROBOTS', blocked: verdict, finalUrl: current, hops, body: null };
      }
      const res = await this.request(current, { wantBody, maxBytes });
      hops.push({ url: current, status: res.status });
      if (REDIRECTS.has(res.status) && res.location) {
        let next;
        try {
          next = new URL(res.location, current);
        } catch {
          return { ...res, finalUrl: current, hops, error: `Invalid Location header: ${res.location}`, errorCode: 'EINVALIDURL' };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return { ...res, finalUrl: current, hops, error: `Redirects to a non-web address (${next.protocol})`, errorCode: 'ENOTHTTP' };
        }
        next.hash = '';
        current = next.href;
        continue;
      }
      return { ...res, finalUrl: current, hops };
    }
    return { status: 0, error: `More than ${maxHops} redirects`, errorCode: 'EMAXHOPS', finalUrl: current, hops, body: null };
  }

  /** Fetch a whole document (sitemaps, lists), following redirects. Capped at 50 MB decompressed. */
  async fetchRaw(url, maxBytes = 50 * 1024 * 1024) {
    return this.follow(url, { wantBody: true, maxBytes });
  }

  /**
   * robots.txt verdict for a URL: { allowed, reason, kind }.
   * kind: 'disallowed' (rules say no), 'robots-error' (robots.txt answered 5xx/429),
   * 'unreachable' (couldn't connect at all).
   */
  async robotsCheck(url) {
    if (!this.respectRobots) return { allowed: true };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: true };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { allowed: true };
    if (!this.robots.has(parsed.origin)) this.robots.set(parsed.origin, this.loadRobots(parsed.origin, this.site(parsed)));
    const verdict = await this.robots.get(parsed.origin);
    if (verdict.kind) return { allowed: false, ...verdict };
    const allowed = isAllowed(verdict.group, parsed.pathname + parsed.search);
    return allowed ? { allowed } : { allowed, kind: 'disallowed', reason: `Disallowed by ${parsed.origin}/robots.txt` };
  }

  async loadRobots(origin, state) {
    const res = await this.follow(`${origin}/robots.txt`, { wantBody: true, maxBytes: 512 * 1024, maxHops: 5 });
    if (res.status >= 200 && res.status < 300) {
      const groups = parseRobots((res.body ?? Buffer.alloc(0)).toString('utf8'));
      if (groups.truncated) this.notes.push(`${origin}/robots.txt has more than ${groups.truncated} rules; we read only the first ${groups.truncated}, so some Disallow lines may not apply.`);
      const group = selectGroup(groups, this.productToken);
      if (group.crawlDelay !== null) {
        const ms = Math.min(group.crawlDelay * 1000, MAX_CRAWL_DELAY_MS);
        if (ms > state.delayMs) {
          state.delayMs = ms;
          this.notes.push(`${origin} asks for Crawl-delay: ${group.crawlDelay}s, so we wait ${ms / 1000}s between requests there.`);
        }
      }
      return { group };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) return { group: { rules: [], crawlDelay: null } };
    if (res.status === 0) {
      return { kind: res.errorCode === 'EPRIVATE' ? 'private' : 'unreachable', reason: res.error, errorCode: res.errorCode };
    }
    // RFC 9309: a 5xx (or 429) robots.txt means "assume complete disallow".
    return { kind: 'robots-error', reason: `${origin}/robots.txt answered HTTP ${res.status}, so we stay out (RFC 9309)` };
  }
}
