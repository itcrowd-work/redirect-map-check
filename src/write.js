import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCsv } from './report/csv.js';
import { renderHtml } from './report/html.js';

/** Write report.csv, report.html, results.json and (when we read old pages) old-pages.json. */
export async function writeReports(run, outDir, { version } = {}) {
  await mkdir(outDir, { recursive: true });
  const files = {
    csv: join(outDir, 'report.csv'),
    html: join(outDir, 'report.html'),
    json: join(outDir, 'results.json'),
  };
  await writeFile(files.csv, renderCsv(run));
  await writeFile(files.html, renderHtml(run, { version }));
  await writeFile(
    files.json,
    JSON.stringify(
      {
        summary: run.summary,
        notes: run.notes,
        mapRowIssues: run.mapRowIssues,
        results: run.results.map(({ mapIssues, ...rest }) => rest),
      },
      null,
      2,
    ),
  );
  // Never write old-pages.json when the old titles came from --snapshot: that file is
  // irreplaceable after launch, and this run may have seen only part of it.
  if (!run.oldPagesFromSnapshot && Object.keys(run.oldPages).length) {
    files.snapshot = join(outDir, 'old-pages.json');
    // Merge with an existing file (new readings win), so a partial re-run (--limit, a
    // trimmed sitemap) never shrinks the old titles you'll need after launch.
    let existing = {};
    try {
      const data = JSON.parse(await readFile(files.snapshot, 'utf8'));
      if (data && typeof data.pages === 'object' && data.pages) existing = data.pages;
    } catch {
      /* no file yet, or unreadable: start fresh */
    }
    const pages = { ...existing, ...run.oldPages };
    files.snapshotKept = Object.keys(existing).filter((k) => !(k in run.oldPages)).length;
    await writeFile(files.snapshot, JSON.stringify({ version: 1, updatedAt: run.summary.generatedAt, pages }, null, 2));
  }
  return files;
}
