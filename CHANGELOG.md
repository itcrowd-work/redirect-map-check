# Changelog

## 0.2.0 (unreleased)

- Requires Node.js 22 or newer (was 20). Node.js 20 reached end of life on 30 April 2026 and gets no more security fixes; CI now tests Node 22, 24 and 26.

- New subpath exports for other tools: `redirect-map-check/inputs`, `/csv`, `/url`, `/http`, `/content` and `/report-style`. The README lists the names they promise, and the Fetcher, loadSitemapUrls, loadText and parseRedirectMap members (options, methods, result fields, including `blocked.kind` when `checkRobots` refuses a page) other tools rely on; everything else stays internal and can't be imported. Tests cover the promised members and fail when a subpath gains an export nobody decided on.

- A sitemap index read from the web can only point at web addresses. A child like `file:///etc/passwd` or a bare path used to be read as a file on your computer (it failed only when no such file existed in the folder you ran from); now it counts as a child sitemap that can't be read. Found in a QA review of redirect-map-plan, 27 Nov 2026.
- CI actions are pinned to commit IDs (checkout v7.0.1, setup-node v7.1.0) instead of the moving `v7` tags.
- `loadSitemapUrls` takes a `partialHint` option, so a tool without `--allow-partial-sitemaps` can say something else at the end of the error. The checker's own message is unchanged.

## 0.1.2 (25 November 2026)

- The HTML report's intro says "Errors are what to fix first, warnings are worth checking" instead of "Errors break the migration, warnings cost search signal": the old sentence claimed an effect on search that the tool can't show.

## 0.1.1 (25 November 2026)

- A deep URL mapped to the homepage is now one `mapped-to-homepage` warning. It no longer also gets a `map-chain` warning when the map has a row that keeps its URL (such as `/,/`), whose fix read "point straight at / instead of /". It also no longer gets a `content-mismatch` warning on top.
- Wording matches the sources: the homepage checks say Google *might* treat such redirects as a soft 404 (as its site-move guide says), not that search engines do; chains cite Google's 10-hop limit instead of "leaking signal"; temporary redirects say what Google does with each type; `not-found` says a 404 or 410 is right for content that is gone for good; the homepage fixes offer 404 or 410; `not-redirected` no longer says the URL answers 200 when it may answer 404.
- README: "always" and "usually" claims softened, and the note on JavaScript and meta-refresh redirects now repeats Google's advice instead of an unsourced claim.

## 0.1.0 (24 November 2026)

First release.

- Inputs: sitemap (index and `.gz`), plain URL list, redirect map CSV (header optional; comma, semicolon or tab).
- Checks: 404/4xx/5xx, request errors, loops, chains, too many hops, 302/303/307, not redirected, wrong target, homepage, map conflicts, map chains, title/H1 mismatch, missing from map.
- A recommended fix for every problem (which rule, which map row, whether the target exists, the closest live page). Up to three candidate pages per problem, scored on title/H1 and slug words and labelled strong or possible; `--new-sitemap` / `--new-urls` let it suggest pages the crawl didn't visit, `--min-suggestion` sets the bar.
- `--base` to test staging before launch; `--old-site` and `--snapshot` for the content check after launch.
- Polite crawling: concurrency limit, per-host delay, robots.txt with Crawl-delay, retries with Retry-After, clear User-Agent.
- HTML report in the itcrowd.work style, light and dark, with Geist and IBM Plex Mono embedded (OFL 1.1).
- Hardened after an independent QA and security review: URLs that can't be checked (robots.txt, unreachable hosts, 429) are errors, never clean; every redirect hop goes through the per-host delay; only http(s) is followed; loopback, private and link-local addresses are refused unless named in the inputs (`--allow-private-network` to opt out); sitemaps and pages are size-capped after decompression; robots.txt matching and title/H1 extraction run in linear time; image/video/news sitemap entries are ignored; map headers are read by name in any order (and the run stops on an unreadable header); map loops, self-targets and duplicates are reported; external targets aren't rewritten onto `--base`; scheme/www/case variants of a target are a warning, not a wrong target; `--snapshot` files are never overwritten.
- Second QA round: an unreadable child sitemap stops the run (or, with `--allow-partial-sitemaps`, fails it as `sitemap-unread`); sitemap and page scanning are linear on malformed input; external hosts next to relative targets stay external; private-network trust follows the host names you give (80/443 and loopback names grouped); status codes survive slow bodies, raw deflate and cut-off gzip decode partially; candidate scoring precomputes and caps its pool (5,000 URLs: 28 s → 8 s); `old-pages.json` is merged, not shrunk; Romanian and generic map headers, UTF-16 without BOM and Windows-1252 maps.
- Third QA round: two mapped rows that meet on `--base` are both checked; `/,/` rows don't decide the host rule; private-network trust is pinned to the addresses seen at the start; slow unwanted bodies no longer hold sockets; unclosed image blocks can't swallow the next page; cut-off gzip is marked truncated; incomplete pages get a `page-incomplete` notice; timing tests measure CPU time.
- Browser interface: `redirect-map-check ui` runs a local page (127.0.0.1, access token, Host/Origin checks, strict CSP) to pick the files, follow progress live, filter, search and tick off problems, and download or save the reports. Input flags prefill the form. `--open` opens `report.html` after a command-line run.
- Browser interface, after its QA round: a dropped sitemap index can only read files dropped with it; local inputs must be regular files (a FIFO can't hang a run); every command-line flag fills in the form (file names only, never paths); a field for the old site's address; uploads keep their own names; one check at a time, even for simultaneous starts; cancel stops waits and requests in flight and interrupts scoring; the token leaves the address bar and downloads go through a header; a fixed default port so Done marks survive a restart; replay and slow event streams are capped; Save asks before replacing; tests clean up their temp folders.
- Final QA round: entries of a remote child sitemap are trusted only on that sitemap's host, even under a local index (they could otherwise open private addresses); a cancel while inputs load is reported as a cancel; page wording leaves `--` inside URLs alone and says "tick" for options; Done marks reset when a problem comes back different.
- Output: terminal summary, `report.csv`, `report.html`, `results.json`, `old-pages.json`. Exit code 1 on errors.
