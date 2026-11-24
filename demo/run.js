// npm run demo: start the Harbor & Pine demo sites and run the checker against
// staging, exactly as you would before a real launch.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemo } from './server.js';

const demo = await startDemo({ oldPort: Number(process.env.DEMO_OLD_PORT ?? 4101), newPort: Number(process.env.DEMO_NEW_PORT ?? 4102) });
const bin = fileURLToPath(new URL('../bin/redirect-map-check.js', import.meta.url));
const map = fileURLToPath(new URL('./redirect-map.csv', import.meta.url));

const child = spawn(
  process.execPath,
  [bin, '--sitemap', `${demo.oldOrigin}/sitemap.xml`, '--map', map, '--base', demo.newOrigin, '--new-sitemap', `${demo.newOrigin}/sitemap.xml`, '--delay', '0', '--out', 'demo-report', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', async (code) => {
  await demo.close();
  process.exit(code === 1 ? 0 : code); // finding problems is the point of the demo
});
