# redirect-map-check

Check a website migration's redirects before and after launch. Give it the old sitemap and your redirect map; it follows every old URL and tells you which ones end in a 404, loop, chain through several hops, use a temporary redirect, land on the homepage or an unrelated page, or are missing from the map altogether.

```bash
npx redirect-map-check --sitemap https://www.example.com/sitemap.xml --map redirects.csv
```

You get a short summary in the terminal, plus a CSV and an HTML report listing every problem with a recommended fix for each one.

Prefer a browser to the terminal? `npx redirect-map-check ui` opens a page where you drop in the files and watch the check run. It all stays on your computer ([details](#browser-interface)).

## Why we built it

We're [ITCrowd](https://itcrowd.work), and we move sites between platforms for a living: Webflow to Shopify, WordPress to custom code, one CMS to another. The redirect map is where migrations quietly lose traffic. A spreadsheet with a few hundred rows always has a typo, a target page nobody built, a rule that sends people to the homepage, or a 302 someone meant to be a 301. Search engines notice all of these.

We used to check them by hand. Now we run this before every launch and again the day after, and we've made it free for anyone doing the same job.

## What it checks

For every old URL (from the sitemap, a URL list, and the map itself), we follow the redirects one hop at a time and look at where they end up.

| Problem | Severity | What it means |
| --- | --- | --- |
| `unchecked` | error | We couldn't check the URL: robots.txt on the site under test disallows us, or answers 5xx. Never counted as clean. |
| `fetch-error` | error | DNS, TLS, timeout or connection failure, on the page or on its robots.txt. |
| `sitemap-unread` | error | With `--allow-partial-sitemaps`: a child sitemap failed, so its URLs weren't checked. Fails the run even if everything else is clean. |
| `rate-limited` | error | The server answered 429 and asked us to wait longer than 30 s. |
| `not-found` | error | The chain ends in a 404 or 410. |
| `client-error` / `server-error` | error | The chain ends in another 4xx, or a 5xx. A 503 is retried once first. |
| `redirect-loop` | error | The redirects send the URL back to itself. |
| `too-many-redirects` | error | More hops than `--max-hops` (default 10). |
| `redirect-without-location` | error | A 3xx response with no `Location` header. |
| `non-http-redirect` | error | A rule sends visitors to `javascript:`, `mailto:`, `file:` or similar. |
| `private-address` | error | A redirect or sitemap entry leads into a loopback, private or link-local address. We don't request it (see "Security"). |
| `not-redirected` | error | The URL is in the map but has no redirect: it still answers on its own (200, 404…). |
| `wrong-target` | error | The redirect ends somewhere other than the URL in the map. |
| `lands-on-homepage` | error | A deep URL ends on `/` (or a language root like `/en/`). Search engines treat this as a soft 404. |
| `map-conflict` | error | The same old URL appears in the map twice with different targets. |
| `map-loop` | error | Rows in the map send URLs to each other in a circle. |
| `check-failed` | error | Something unexpected went wrong on this URL; the rest of the run carried on. |
| `redirect-chain` | warning | More than one hop before the final page. |
| `temporary-redirect` | warning | A 302, 303 or 307 where a migration needs a 301 or 308. |
| `target-variant` | warning | Lands on the mapped page written differently (http/https, www, letter case, tracking parameters). Update the map. |
| `content-mismatch` | warning | The new page's title and H1 share almost no words with the old page's. Usually a copy-paste slip in the map. |
| `mapped-to-homepage` | warning | The map itself sends a deep URL to the homepage. |
| `map-chain` | warning | A row points at an old URL that another row redirects again. |
| `missing-from-map` | warning | An old URL has no row in the map and doesn't resolve to the same page. |
| `unchanged-not-in-map` | notice | Not in the map, but still answers 200 at the same address. Fine if intended. |
| `page-incomplete` | notice | The final page timed out or was cut off while downloading, so the title check used what arrived. |
| `target-not-checked` | notice | The redirect leaves for another site whose robots.txt disallows us; the redirect was checked, the final page wasn't. |
| `map-self-target` | notice | A row keeps the same URL. Fine as documentation; don't create a rule for it. |
| `map-duplicate` | notice | The same row appears twice. |
| `map-row-skipped` | notice | A row in the CSV didn't contain two URLs. |

One problem is reported once: a mapped URL with no redirect is `not-redirected`, not also `not-found`.

Every problem comes with a **recommended fix** written from what we saw: which rule to change, which map row to edit, whether the target page exists, and, where a page needs a new home, up to three candidate pages on the new site.

### How the candidate pages are picked

Each new page is scored against the old one on two signals:

- **Title and H1 words** shared with the old page, ignoring words that appear on most pages (like the brand name).
- **Slug words**, from the last part of the URL (`/products/rattan-chair` → rattan, chair). Slugs often survive a migration even when titles change.

With both signals the stronger counts 60% and the weaker 40%, so pages where they agree rank first. Scores of 0.75 and up are labelled **strong**; from `--min-suggestion` (default 0.5) up to 0.75, **possible**. Possible matches are worded as "check it before you use it".

To get the best suggestions:

1. **Give us the old titles.** Run before launch with `--base` (the old site is still live) and keep `old-pages.json`; after launch pass it with `--snapshot`. Without old titles we only have the slug, and every match is at most "possible" (one signal is never enough for "strong").
2. **Give us every new page.** `--new-sitemap` (or `--new-urls` with a plain list) lets us suggest pages nothing redirects to yet. Without it we only know the pages the crawl landed on. Check that the staging sitemap includes every CMS item and product.
3. **Let us read staging.** On your own staging, add `--ignore-robots` if robots.txt blocks crawlers.
4. **Specific titles help most.** "Walnut writing desk" matches; "Product" or the brand name alone doesn't.

It compares words, not meaning: a page renamed to different words ("Linen sofa" → "Lino couch") or translated into another language won't be found, and near-identical pages (variants, pagination) can rank a sibling first. Treat suggestions as a shortlist for a person to confirm.

A URL counts as "clean" when it has no errors or warnings. A URL we couldn't check is an error, never clean, and the report's headline says how many there were. The exit code is 1 when anything at error level was found, so it drops straight into CI.

## Worked example

The repository ships with a small demo: **Harbor & Pine**, a made-up furniture shop moving to a new site with new URLs. One local server plays the old live site (with its sitemap), another plays the new site on staging, and the staging redirect rules contain one mistake of each kind.

```bash
git clone <this repository> && cd redirect-map-check
npm run demo
```

That runs:

```bash
redirect-map-check \
  --sitemap http://127.0.0.1:4101/sitemap.xml \
  --map demo/redirect-map.csv \
  --base http://127.0.0.1:4102 \
  --new-sitemap http://127.0.0.1:4102/sitemap.xml
```

The map is an ordinary two-column CSV. Paths are fine; full URLs work too:

```csv
old_url,new_url
/about-us,/about
/products/walnut-desk,/shop/office/walnut-desk
/products/rattan-chair,/shop/living/rattan-armchair
/products/pine-bookshelf,/shop/dining/oak-dining-table
/delivery-information,/help/delivery
...
```

And the terminal summary:

```text
redirect-map-check  19 URLs checked in 0.1s (67 requests)
Tested against http://127.0.0.1:4102

  ✖ 9 with errors   ▲ 5 with warnings   ✔ 5 clean
  ? 1 URL could not be checked at all; it counts as an error, never as clean.

  Errors
       1  unchecked                  Could not be checked
       2  not-found                  Ends in a 404 / 410
       1  server-error               Ends in a 5xx server error
       1  redirect-loop              Redirect loop
       1  not-redirected             In the map, but not redirected
       2  wrong-target               Lands somewhere other than the mapped URL
       1  lands-on-homepage          Lands on the homepage
       1  map-conflict               Conflicting rows in the map

  Warnings
       2  redirect-chain             Redirect chain (more than one hop)
       2  temporary-redirect         Temporary redirect (302 / 303 / 307)
       2  content-mismatch           Lands on an unrelated page
       1  map-chain                  Map points at another old URL
       1  missing-from-map           Old URL missing from the map

  Notices
       1  unchanged-not-in-map       Not in the map, still works
       2  map-self-target            Row keeps the same URL
       1  map-row-skipped            Map row skipped

  Report:    demo-report/report.html
  CSV:       demo-report/report.csv
  Old pages: demo-report/old-pages.json (keep it: reuse after launch with --snapshot)
```

A few of the things it caught, with the fix it recommends:

- **`/products/walnut-desk` → 404.** *"The rule is right but /shop/office/walnut-desk doesn't exist. Publish /shop/office/walnut-desk, or point /products/walnut-desk (and row 6) at a live page."*
- **`/products/rattan-chair` → homepage.** *"Change the rule for /products/rattan-chair to a 301 straight to /shop/living/rattan-armchair, which is live. It currently lands on /."*
- **`/products/pine-bookshelf` → the oak dining table.** The redirect does exactly what the map says, so a URL-only check passes it. The old page's title and H1 share no words with the new page's, so it's flagged: *"Check row 10 of the map … A closer match on the new site is /shop/storage/pine-bookshelf, a strong match."*
- **`/blog/spring-collection` loops.** *"/journal/spring-collection sends visitors back to /blog/spring-collection. Remove that rule, then redirect /blog/spring-collection once, with a 301, to /journal/spring-collection-2026."*
- **`/blog/caring-for-solid-wood` takes two hops.** *"… The first hop only adds a trailing slash, so the migration rule never sees the original URL: make the rule match that form too, or put it first."*
- **`/cart`** is disallowed by staging's robots.txt, so it's an `unchecked` error, not a pass: *"robots.txt on … disallows /cart, so we didn't request it. If you own the site (staging usually blocks crawlers), re-run with --ignore-robots."*
- **`/gift-cards`** is in the old sitemap, has no row in the map and 404s. *"Add a row for /gift-cards to the map and a 301 to the page that replaces it. The closest live page we found is /shop/gift-vouchers, a strong match."* /shop/gift-wrapping is listed as a possible second.

Each problem in `report.html` and `report.csv` also carries the full status chain, the expected URL and the final URL.

## Browser interface

```bash
npx redirect-map-check ui
```

This starts a small server on your own computer (on 127.0.0.1, nobody else can reach it) and opens a page in your browser. On that page you:

1. paste the old sitemap URL, or drop a saved sitemap or a list of URLs;
2. drop the redirect map (CSV or TSV);
3. add the staging URL and the new site's sitemap if you're testing before launch;
4. press **Run the check** and watch each old URL being followed.

When it finishes you get the same results as the HTML report, but you can work through them: filter by errors, warnings or notices, pick one problem type, search URLs and fixes, and tick problems off as **Done**. The report, CSV, `results.json` and `old-pages.json` download from the page, or **Save to folder** writes them to `./redirect-report` (or `--out`); it asks before replacing a report that's already there.

If your map lists only paths (`/about`, the usual Webflow or Shopify export), fill in the old site's address under the map. All the other options (delay, requests at once, timeout, hosts that belong to the new site and so on) are under **More options**.

Any command-line flag fills in the form, so you can start from a command you already use:

```bash
npx redirect-map-check ui --sitemap https://www.example.com/sitemap.xml --map redirects.csv --base https://staging.example.com --delay 1000
```

Files named on the command line (a saved sitemap, the map, `--new-urls`) stay on your machine: the page shows their names and a tick box to use them.

It listens on port 47470 (or a free one if that's taken), so **Done** marks are kept in your browser between sessions. `--port <n>` picks another port and `--no-open` prints the address instead of opening the browser. Stop it with Ctrl+C. To try it on the demo sites: `npm run demo:ui`.

On a normal command-line run, `--open` opens `report.html` in your browser when the check finishes.

How it stays private:
- It listens on 127.0.0.1 only. Requests with another `Host` header are refused, so a website can't reach it through DNS tricks.
- Everything except the empty page itself needs the access token from the address the tool prints. The page keeps the token for that tab and removes it from the address bar; it sends it in a header, so downloads don't put it in your history. Don't share the printed address.
- Changes (start, cancel, save) also need this page's own origin and a JSON body, so other websites you have open can't start a check.
- Files you pick go from the page to the tool on your machine, into a temporary folder that's removed after the check; nothing is uploaded anywhere else. The page can't ask the tool to read files on your disk: only the files you pick, or the ones you named on the command line. A dropped sitemap index can only point at files dropped with it.
- The page has a strict Content Security Policy and shows check results as text only, so a hostile page title can't run code in it.

## Before launch: test against staging

Point `--base` at the new site's staging host. We request each old URL's path on staging, and any redirect or map target on your production domain is rewritten onto staging too, so the map can stay in production URLs.

```bash
npx redirect-map-check \
  --sitemap https://www.example.com/sitemap.xml \
  --map redirects.csv \
  --base https://staging.example.com \
  --new-sitemap https://staging.example.com/sitemap.xml
```

While the old site is still live, we also read each old page's title and H1 for the content check, and save them to `old-pages.json` in the report folder. Keep that file: a later run with `--snapshot` reads it and never writes over it.

Staging sites often block all crawlers in robots.txt. Those URLs then show up as `unchecked` errors (never as clean); if it's your own staging, add `--ignore-robots`.

## After launch

Run the same command without `--base`. The old URLs now redirect, so their old titles are gone; give us one of these for the content check:

```bash
# the old-pages.json saved by your pre-launch run
npx redirect-map-check --sitemap old-sitemap.xml --map redirects.csv --snapshot old-pages.json

# or a copy of the old site that is still online (e.g. the old *.webflow.io address)
npx redirect-map-check --sitemap old-sitemap.xml --map redirects.csv --old-site https://old-site.webflow.io
```

Save a copy of the old sitemap before launch: once the new site is live, the old `sitemap.xml` URL usually serves the new one.

If the domain changes in the migration, use full URLs in the map's second column so we know which host the targets belong to. When no row moves a page by path alone (rows that keep their URL, like `/,/`, don't count) and most full-URL targets point at one other host, we treat that host as the new domain and test its URLs on `--base`. When the map has relative targets (`/about`), it's about this site, so any other host is an external link and is left alone. A map that mostly points at an external knowledge base looks like a domain change; the run's note says so. The run's notes say which hosts were treated which way; pass `--new-host shop.example` to say so explicitly. With `--base`, a sitemap URL and a map row that become the same staging URL are checked once (old titles read from the sitemap's host); two map rows that collide are both checked, with a note.

## Inputs

- **`--sitemap <url|file>`**: the old site's sitemap. Sitemap indexes are followed (a local index finds its children next to it), `.gz` files are unpacked up to the protocol's 50 MB limit, and image, video and news entries are ignored. A child sitemap that fails stops the run, because its URLs would otherwise go unchecked without anyone noticing; with `--allow-partial-sitemaps` we check the rest and report it as a `sitemap-unread` error. Repeat the flag for several.
- **`--urls <file|url>`**: a plain list, one URL per line (anything after a space or tab is ignored). Blank lines and `#` comments are ignored. Repeatable.
- **`--map <file|url>`**: the redirect map. Two columns, old then new. A header row is optional; if there is one, we find the columns by name in any order: "old", "from", "source", "Source URL", "Redirect from"… and "new", "to", "target", "destination", "Destination URL", "Redirect to"… (Romanian too: "URL vechi", "URL nou", "Sursă", "Destinație"), with other columns (notes, a "Redirect" column holding 301) ignored. If there's a header we can't read, we stop and say so rather than guess. Commas, semicolons and tabs all work, and UTF-8, UTF-16 (Excel's "Unicode text", with or without a byte-order mark) or Windows-1252 files (with a note), so a spreadsheet export from any locale is fine. Rows that are only notes are ignored; rows with one URL are reported. URLs from the map are always checked, even if they aren't in the sitemap.
- **`--old-base <url>`**: the old site's origin, when every input is a relative path.

## Options

| Option | Default | |
| --- | --- | --- |
| `--base <url>` | | Test against this host (staging) instead of the live URLs. |
| `--old-site <url>` | | A live copy of the old site, used to read old titles/H1s. |
| `--snapshot <file>` | | `old-pages.json` from an earlier run, for the same purpose. |
| `--new-sitemap <url\|file>` | | The new site's sitemap. We read its pages' titles so fixes can name candidate pages. Repeatable. |
| `--new-urls <file\|url>` | | The same from a plain list of the new site's URLs. Repeatable. |
| `--min-suggestion <0-1>` | 0.5 | Lowest score for a candidate page. 0.75 and up is labelled strong. |
| `--new-host <host>` | | A host that belongs to the new site (e.g. after a domain change), rewritten onto `--base`. Repeatable. |
| `--allow-private-network` | off | Allow redirects and sitemap entries into loopback or private addresses (see "Security"). |
| `--allow-partial-sitemaps` | off | If a child sitemap fails, check the rest and report it as an error instead of stopping. |
| `--concurrency <n>` | 4 | Requests in flight at once (max 16). |
| `--delay <ms>` | 250 | Minimum gap between requests to the same host. |
| `--timeout <ms>` | 15000 | Per request. |
| `--retries <n>` | 1 | For 429, 503 and transient network errors. `Retry-After` is honoured up to 30 s. |
| `--max-hops <n>` | 10 | Redirects followed per URL. |
| `--user-agent <s>` | see below | |
| `--ignore-robots` | off | Only for sites you own. |
| `--limit <n>` | | Check the first n URLs only. |
| `--min-similarity <0-1>` | 0.25 | Title/H1 overlap below this counts as an unrelated page. |
| `--no-content` | | Skip the title/H1 comparison. |
| `--out <dir>` | `redirect-report` | Where the reports go. |
| `--fail-on <level>` | `error` | Exit 1 on `error`, `warning`, or `never`. |
| `--no-color`, `-q` | | Plain output; quiet progress. |

## Polite by default

This tool sends real requests to real servers, so it behaves:

- At most 4 requests in flight, and at least 250 ms between requests to the same host. Every redirect hop is a request of its own and waits its turn; we never let a library follow redirects for us.
- It identifies itself: `redirect-map-check/<version> (+https://itcrowd.work/tools/redirect-map-check/)`.
- It reads robots.txt for every host it visits, honours `Disallow`/`Allow` (with `*` and `$`), the group for its own name (`User-agent: redirect-map-check`) or `*`, and `Crawl-delay` (capped at 30 s), and skips what it's told to skip. If robots.txt answers 5xx, it stays off that host, as RFC 9309 asks. Skipped URLs are reported as `unchecked`, never as clean.
- It retries once, backing off, and respects `Retry-After` up to 30 s. A server that asks for longer gets a `rate-limited` result instead of an early retry, and after any 429 it slows down on that host.
- It only downloads the first 2 MB of a page (decompressed), and only when it needs the title and H1.

## Security

The tool fetches URLs that come from other people's servers (sitemap entries, redirect targets), so it's careful about where they lead:

- **Only http and https.** A redirect to `javascript:`, `mailto:`, `file:`, `data:` or anything else is reported, never followed.
- **No private network by surprise.** Redirects and sitemap entries that resolve to loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, including cloud metadata) or similar addresses are refused and reported as `private-address`. The check runs on the address actually connected to, so DNS tricks can't get round it. Host names you name yourself (a local `--base`, a sitemap on `localhost`, URLs in your own map or list file) are allowed on their port and on 80/443, but only for the private addresses they resolved to when the run started, so a later DNS change can't redirect that trust. `localhost`, `127.0.0.1` and `::1` count as one host, on the port you named only. Another name or a bare IP that resolves to the same private address isn't trusted, and a redirect to a different port on your machine is refused. `--allow-private-network` turns the check off.
- **Bounded input.** Sitemaps and lists stop at 50 MB decompressed, pages at 2 MB; title and H1 extraction and robots.txt matching run in linear time, so a hostile page or robots.txt can't stall the run.
- **Safe reports.** Everything in `report.html` is escaped and the page carries a Content Security Policy with no scripts; cells in `report.csv` that a spreadsheet would treat as a formula are prefixed with `'`.
- **One URL can't sink the run.** An unexpected failure on one URL becomes a `check-failed` error and the rest are still checked.

## Output

The `--out` folder contains:

- `report.html`: every problem with its recommended fix, as a self-contained page (no scripts, no external files, works offline) grouped by problem, with what to fix for each type. It follows the reader's light or dark setting and prints cleanly. The fonts (Geist and IBM Plex Mono, both SIL Open Font License 1.1) are embedded; their licences are in `assets/fonts/`.
- `report.csv`: one row per problem: `severity, issue, title, old_url, tested_url, expected_url, final_url, final_status, hops, status_chain, similarity, detail, recommended_fix, suggested_pages` (each as `url (strong 0.80)`). Hand it to whoever owns the redirect rules.
- `results.json`: every URL checked, with every hop.
- `old-pages.json`: old titles and H1s, when we read them from a live old site. Not written when you passed `--snapshot`, and otherwise merged with the existing file (new readings win), so a partial re-run never shrinks it.

## In CI

```yaml
- run: npx redirect-map-check --sitemap old-sitemap.xml --map redirects.csv --base "$STAGING_URL" --ignore-robots
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: redirect-report
    path: redirect-report/
```

A URL that robots.txt disallows on the site you're testing (say `/cart` on production after launch) is an `unchecked` error and keeps the build red: on your own site run with `--ignore-robots`, or leave such URLs out of the list you check.

Exit codes: `0` nothing at the `--fail-on` level, `1` problems found (URLs we couldn't check count), `2` bad arguments or a fatal error (for example, the sitemap couldn't be loaded, the map's header can't be read, a child sitemap failed without `--allow-partial-sitemaps`, or the report folder isn't writable; that last one is checked before crawling).

## As a library

```js
import { runCheck, writeReports } from 'redirect-map-check';

const run = await runCheck({
  sitemaps: ['https://www.example.com/sitemap.xml'],
  map: 'redirects.csv',
  base: 'https://staging.example.com',
  userAgent: 'my-script/1.0',
});
console.log(run.summary.byType);
await writeReports(run, 'redirect-report');
```

## What it doesn't do

- It doesn't run JavaScript, so redirects done in client-side JS or `<meta http-equiv="refresh">` aren't followed. (They also pass much less signal than a server redirect, which is worth knowing in itself.)
- The content check is a heuristic. It compares words in titles and H1s, ignoring words that appear on most pages of the site (like the brand name). It catches copy-paste slips well; it won't judge whether two related pages are a good match.
- It checks the URLs you give it. If a page isn't in the old sitemap or the map, list it with `--urls`.

## Development

Node.js 20 or newer, no runtime dependencies.

```bash
npm test        # unit tests + end-to-end tests against the demo sites
npm run demo    # the worked example above
npm run demo:ui # the same demo in the browser interface
```

Issues and pull requests are welcome.

## Licence

MIT © ITCrowd. See [LICENSE](LICENSE).

---

Planning a migration and want a second pair of eyes on the redirects, or someone to do the whole move? That's what we do: [itcrowd.work](https://itcrowd.work).
