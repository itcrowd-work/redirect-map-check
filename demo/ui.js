// npm run demo:ui: start the Harbor & Pine demo sites and open the browser interface
// with the form filled in (sitemap, map, staging, new sitemap). Press Run.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemo } from './server.js';

const demo = await startDemo({ oldPort: Number(process.env.DEMO_OLD_PORT ?? 4101), newPort: Number(process.env.DEMO_NEW_PORT ?? 4102) });
const bin = fileURLToPath(new URL('../bin/redirect-map-check.js', import.meta.url));
const map = fileURLToPath(new URL('./redirect-map.csv', import.meta.url));

const child = spawn(
  process.execPath,
  [bin, 'ui', '--sitemap', `${demo.oldOrigin}/sitemap.xml`, '--map', map, '--base', demo.newOrigin, '--new-sitemap', `${demo.newOrigin}/sitemap.xml`, '--out', 'demo-report', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
const stop = async () => {
  child.kill('SIGINT');
  await demo.close();
  process.exit(0);
};
process.on('SIGINT', stop);
child.on('exit', async () => {
  await demo.close();
  process.exit(0);
});
