// A made-up furniture shop, "Harbor & Pine", used for the README example and
// the tests. Two local servers:
//   old site  – the live site before the migration (serves the sitemap)
//   new site  – the rebuilt site on staging, with redirect rules that contain
//               one deliberate mistake of each kind the checker looks for.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const BRAND = 'Harbor & Pine';

const OLD_PAGES = {
  '/': ['Harbor & Pine | Handmade Wooden Furniture', 'Handmade wooden furniture'],
  '/about-us': ['About Us | Harbor & Pine', 'Our workshop story'],
  '/contact-us': ['Contact Us | Harbor & Pine', 'Get in touch'],
  '/products/oak-dining-table': ['Oak Dining Table | Harbor & Pine', 'Oak dining table'],
  '/products/walnut-desk': ['Walnut Writing Desk | Harbor & Pine', 'Walnut writing desk'],
  '/products/linen-sofa': ['Linen Sofa | Harbor & Pine', 'Linen three-seat sofa'],
  '/products/rattan-chair': ['Rattan Armchair | Harbor & Pine', 'Rattan armchair'],
  '/products/teak-bench': ['Teak Garden Bench | Harbor & Pine', 'Teak garden bench'],
  '/products/pine-bookshelf': ['Pine Bookshelf | Harbor & Pine', 'Pine bookshelf'],
  '/blog/caring-for-solid-wood': ['Caring for Solid Wood Furniture | Harbor & Pine Blog', 'How to care for solid wood furniture'],
  '/blog/spring-collection': ['Our Spring Collection | Harbor & Pine Blog', 'The spring collection'],
  '/delivery-information': ['Delivery Information | Harbor & Pine', 'Delivery information'],
  '/showroom': ['Visit Our Showroom | Harbor & Pine', 'Visit our showroom'],
  '/gift-cards': ['Gift Cards | Harbor & Pine', 'Gift cards'],
  '/faq': ['FAQ | Harbor & Pine', 'Frequently asked questions'],
  '/careers': ['Careers | Harbor & Pine', 'Work with us'],
  '/cart': ['Your Cart | Harbor & Pine', 'Your cart'],
};

const NEW_PAGES = {
  '/': [`Handmade Wooden Furniture – ${BRAND}`, 'Furniture made to last'],
  '/about': [`About – ${BRAND}`, 'Our workshop story'],
  '/contact': [`Contact – ${BRAND}`, 'Get in touch'],
  '/shop': [`Shop – ${BRAND}`, 'Shop all furniture'],
  '/shop/dining/oak-dining-table': [`Oak Dining Table – ${BRAND}`, 'Oak dining table'],
  '/shop/living/linen-sofa': [`Linen Sofa – ${BRAND}`, 'Linen sofa'],
  '/shop/living/rattan-armchair': [`Rattan Armchair – ${BRAND}`, 'Rattan armchair'],
  '/shop/outdoor/teak-bench': [`Teak Bench – ${BRAND}`, 'Teak garden bench'],
  '/journal/caring-for-solid-wood': [`Caring for Solid Wood – ${BRAND} Journal`, 'Caring for solid wood furniture'],
  '/journal/spring-collection-2026': [`Spring Collection 2026 – ${BRAND} Journal`, 'The spring collection'],
  '/help/delivery': [`Delivery – ${BRAND}`, 'Delivery'],
  '/help/returns': [`Returns & Refunds – ${BRAND}`, 'Returns and refunds'],
  '/visit-us': [`Visit Us – ${BRAND}`, 'Visit our showroom'],
  '/faq': [`FAQ – ${BRAND}`, 'Frequently asked questions'],
  '/careers': [`Careers – ${BRAND}`, 'Work with us'],
  '/jobs': [`Jobs – ${BRAND}`, 'Work with us'],
  '/cart': [`Cart – ${BRAND}`, 'Your cart'],
  '/shop/storage/pine-bookshelf': [`Pine Bookshelf – ${BRAND}`, 'Pine bookshelf'],
  '/shop/gift-vouchers': [`Gift Vouchers – ${BRAND}`, 'Gift cards and vouchers'],
  '/shop/gift-wrapping': [`Gift Wrapping – ${BRAND}`, 'Gift wrapping'],
};

// [status, location] — the staging redirect rules, mistakes included.
const NEW_REDIRECTS = {
  '/about-us': [301, '/about'],
  '/contact-us': [301, '/contact'],
  '/products/oak-dining-table': [301, '/shop/dining/oak-dining-table'],
  '/products/walnut-desk': [301, '/shop/office/walnut-desk'], // target page was never built → 404
  '/products/linen-sofa': [302, '/shop/living/linen-sofa'], // temporary instead of permanent
  '/products/rattan-chair': [301, '/'], // dumped on the homepage
  '/products/pine-bookshelf': [301, '/shop/dining/oak-dining-table'], // follows a copy-paste slip in the map
  '/blog/caring-for-solid-wood': [301, '/blog/caring-for-solid-wood/'], // trailing-slash hop → chain
  '/blog/caring-for-solid-wood/': [301, '/journal/caring-for-solid-wood'],
  '/blog/spring-collection': [301, '/journal/spring-collection'], // two rules pointing at each other → loop
  '/journal/spring-collection': [301, '/blog/spring-collection'],
  '/delivery-information': [301, '/help/returns'], // wrong page
  '/showroom': [307, '/visit-us'], // temporary 307
  '/old-promo-2023': [301, '/shop'],
  '/summer-sale-2022': [301, '/old-promo-2023'], // the map itself chains
};

function page([title, h1]) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title.replace(/&(?!amp;)/g, '&amp;')}</title></head>
<body><header><a href="/">${BRAND.replace('&', '&amp;')}</a></header><main><h1>${h1}</h1><p>Demo page.</p></main></body></html>`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}

function oldSite(origin) {
  return (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /account/\n', 'text/plain');
    if (path === '/sitemap.xml') {
      const urls = Object.keys(OLD_PAGES)
        .map((p) => `  <url><loc>${origin()}${p}</loc></url>`)
        .join('\n');
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 'application/xml');
    }
    if (OLD_PAGES[path]) return send(res, 200, page(OLD_PAGES[path]));
    return send(res, 404, page(['Not found', 'Page not found']));
  };
}

function newSite() {
  return (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /cart\n', 'text/plain');
    if (path === '/sitemap.xml') {
      const origin = `http://${req.headers.host}`;
      const urls = Object.keys(NEW_PAGES)
        .filter((p) => p !== '/cart')
        .map((p) => `  <url><loc>${origin}${p}</loc></url>`)
        .join('\n');
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 'application/xml');
    }
    if (path === '/products/teak-bench') return send(res, 503, 'Service unavailable', 'text/plain', { 'retry-after': '0' });
    const rule = NEW_REDIRECTS[path];
    if (rule) {
      res.writeHead(rule[0], { location: rule[1] });
      return res.end();
    }
    if (NEW_PAGES[path]) return send(res, 200, page(NEW_PAGES[path]));
    return send(res, 404, page([`Page not found – ${BRAND}`, 'Page not found']));
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/**
 * Start both demo sites. Port 0 picks free ports (used by the tests). publicOrigin sets the
 * address the old site's sitemap uses, for running the demo behind made-up host names.
 */
export async function startDemo({ oldPort = 0, newPort = 0, publicOrigin } = {}) {
  let oldOrigin = '';
  const oldServer = createServer(oldSite(() => publicOrigin ?? oldOrigin));
  const newServer = createServer(newSite());
  oldOrigin = await listen(oldServer, oldPort);
  const newOrigin = await listen(newServer, newPort);
  return {
    oldOrigin,
    newOrigin,
    close: () => Promise.all([oldServer, newServer].map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = await startDemo({ oldPort: 4101, newPort: 4102 });
  console.log(`Old site (live):    ${demo.oldOrigin}  (sitemap: ${demo.oldOrigin}/sitemap.xml)`);
  console.log(`New site (staging): ${demo.newOrigin}`);
  console.log('Press Ctrl+C to stop.');
}
