// Browser script for the local interface. Plain JavaScript, no libraries.
// Every piece of data from a check is added with textContent; links are only made for
// http(s) URLs. Nothing here uses innerHTML.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // The token arrives once in the address; keep it for this tab and take it out of the
  // address bar (and this history entry), so it isn't left in history or shared by accident.
  let token = '';
  try {
    token = new URLSearchParams(location.search).get('t') || sessionStorage.getItem('rmc-token') || '';
    if (token) sessionStorage.setItem('rmc-token', token);
  } catch {
    token = new URLSearchParams(location.search).get('t') || '';
  }
  if (location.search) history.replaceState(null, '', location.pathname);
  if (!token) {
    $('no-token').hidden = false;
    $('form-section').hidden = true;
    return;
  }
  const PAGE = 200;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const isHttp = (value) => /^https?:\/\//i.test(String(value || ''));
  const link = (url) => {
    if (!url) return el('span', 'text-color-grey-dim', '–');
    if (!isHttp(url)) return el('span', '', url);
    const a = el('a', 'text-style-link', url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    return a;
  };
  const get = async (path) => {
    const res = await fetch(path, { headers: { 'x-rmc-token': token } });
    if (res.status === 403) {
      $('no-token').hidden = false;
      $('form-section').hidden = true;
      try {
        sessionStorage.removeItem('rmc-token');
      } catch {
        /* nothing stored */
      }
    }
    return res;
  };

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rmc-token': token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
    return data;
  };

  const readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] || '' });
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  // ---- Form: defaults from the command line, drop zones ----

  const showDefault = (key, text) => {
    $(`c-default-${key}`).hidden = false;
    $(`t-default-${key}`).textContent = text;
  };
  const applyDefaults = (d) => {
    if (d.sitemaps?.length) $('f-sitemaps').value = d.sitemaps.join('\n');
    if (d.base) $('f-base').value = d.base;
    if (d.oldBase) $('f-oldbase').value = d.oldBase;
    if (d.newSitemaps?.length) $('f-newsitemaps').value = d.newSitemaps.join('\n');
    if (d.oldSite) $('f-oldsite').value = d.oldSite;
    if (d.newHosts?.length) $('f-newhosts').value = d.newHosts.join(', ');
    $('f-ignore-robots').checked = Boolean(d.ignoreRobots);
    $('f-nocontent').checked = Boolean(d.noContent);
    $('f-private').checked = Boolean(d.allowPrivateNetwork);
    $('f-partial').checked = Boolean(d.allowPartialSitemaps);
    const fields = { delay: 'f-delay', concurrency: 'f-concurrency', timeout: 'f-timeout', retries: 'f-retries', maxHops: 'f-maxhops', limit: 'f-limit', minSimilarity: 'f-minsimilarity', minSuggestion: 'f-minsuggestion' };
    for (const [key, value] of Object.entries(d.numbers || {})) if (fields[key]) $(fields[key]).value = value;
    const files = (list) => (list.length === 1 ? list[0] : `${list.length} files: ${list.join(', ')}`);
    if (d.localOld?.length) showDefault('old', `Use ${files(d.localOld)} (from the command line)`);
    if (d.map) showDefault('map', `Use ${d.map} (from the command line)`);
    if (d.snapshot) showDefault('snapshot', `Use ${d.snapshot} (from the command line)`);
    if (d.localNew?.length) showDefault('new', `Also use ${files(d.localNew)} (from the command line)`);
    if (d.oldSite || d.snapshot || d.newHosts?.length || d.noContent || d.allowPrivateNetwork || d.allowPartialSitemaps || Object.keys(d.numbers || {}).length) $('advanced').open = true;
  };
  get('/api/defaults')
    .then((res) => (res.ok ? res.json() : null))
    .then((d) => d && applyDefaults(d))
    .catch(() => {});

  const dropZone = (zoneId, inputId, empty) => {
    const zone = $(zoneId);
    const input = $(inputId);
    const text = zone.querySelector('.ui_drop-text');
    const update = () => {
      const names = [...input.files].map((f) => f.name);
      zone.classList.toggle('has-file', names.length > 0);
      text.textContent = names.length ? names.join(', ') : empty;
    };
    input.addEventListener('change', update);
    for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, () => zone.classList.add('is-over'));
    for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('is-over'));
  };
  dropZone('d-old', 'f-oldfiles', 'Or drop a saved sitemap (.xml, .gz) or a list of URLs (.txt)');
  dropZone('d-map', 'f-map', 'Drop the map: CSV or TSV with the old URL and the new URL');
  dropZone('d-snapshot', 'f-snapshot', 'Or drop old-pages.json from a run before launch');

  const formError = (message) => {
    $('form-error').hidden = !message;
    $('form-error').textContent = message || '';
  };
  for (const id of ['f-sitemaps', 'f-map', 'f-oldfiles', 'f-base', 'f-newsitemaps', 'f-oldbase']) $(id).addEventListener('input', () => formError(''));

  $('rmc-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    formError('');
    const sitemaps = $('f-sitemaps').value.split(/\s+/).filter(Boolean);
    const bad = sitemaps.find((s) => !isHttp(s));
    if (bad) return formError(`"${bad}" isn't a web address. Paste a sitemap URL, or drop a saved file instead.`);
    const badNew = $('f-newsitemaps').value.split(/\s+/).filter(Boolean).find((u) => !isHttp(u));
    if (badNew) return formError(`"${badNew}" isn't a web address (it should start with https://).`);
    const useDefaultOld = !$('c-default-old').hidden && $('f-default-old').checked;
    const useDefaultMap = !$('c-default-map').hidden && $('f-default-map').checked;
    const mapFile = $('f-map').files[0];
    const oldFiles = [...$('f-oldfiles').files];
    if (!sitemaps.length && !oldFiles.length && !useDefaultOld && !mapFile && !useDefaultMap) {
      return formError('Add the old sitemap URL, a saved sitemap or URL list, or the redirect map.');
    }
    for (const id of ['f-base', 'f-oldsite', 'f-oldbase']) {
      const v = $(id).value.trim();
      if (v && !isHttp(v)) return formError(`"${v}" isn't a web address (it should start with https://).`);
    }
    $('run').disabled = true;
    $('run-hint').textContent = 'Starting…';
    try {
      const snapshotFile = $('f-snapshot').files[0];
      await post('/api/run', {
        sitemaps,
        useDefaultSitemaps: useDefaultOld,
        oldFiles: await Promise.all(oldFiles.map(readFile)),
        mapFile: mapFile ? await readFile(mapFile) : null,
        useDefaultMap,
        snapshotFile: snapshotFile ? await readFile(snapshotFile) : null,
        useDefaultSnapshot: !$('c-default-snapshot').hidden && $('f-default-snapshot').checked,
        base: $('f-base').value.trim(),
        newSitemaps: $('f-newsitemaps').value.split(/\s+/).filter(Boolean),
        useDefaultNewFiles: !$('c-default-new').hidden && $('f-default-new').checked,
        oldSite: $('f-oldsite').value.trim(),
        oldBase: $('f-oldbase').value.trim(),
        newHosts: $('f-newhosts').value,
        delay: $('f-delay').value,
        concurrency: $('f-concurrency').value,
        timeout: $('f-timeout').value,
        retries: $('f-retries').value,
        maxHops: $('f-maxhops').value,
        minSimilarity: $('f-minsimilarity').value,
        limit: $('f-limit').value,
        minSuggestion: $('f-minsuggestion').value,
        ignoreRobots: $('f-ignore-robots').checked,
        noContent: $('f-nocontent').checked,
        allowPartialSitemaps: $('f-partial').checked,
        allowPrivateNetwork: $('f-private').checked,
      });
      $('run-hint').textContent = '';
    } catch (err) {
      formError(err.message);
      $('run').disabled = false;
      $('run-hint').textContent = '';
    }
  });

  // ---- Progress (server-sent events) ----

  const PHASES = {
    inputs: 'Reading the sitemap and the map',
    crawl: 'Following the redirects',
    targets: 'Checking the mapped targets',
    'new-pages': "Reading the new site's pages",
    scoring: 'Scoring and writing the fixes',
  };
  let liveCount = 0;

  const resetForRun = () => {
    $('progress').hidden = false;
    for (const id of ['results', 'stats-section', 'list-section']) $(id).hidden = true;
    $('phase').textContent = 'Starting…';
    $('progress-count').textContent = '';
    $('bar-wrap').classList.add('is-indeterminate');
    $('bar').style.width = '0';
    $('live').replaceChildren();
    $('cancel').hidden = false;
    $('cancel').disabled = false;
    $('run').disabled = true;
    liveCount = 0;
  };

  const handle = async (event) => {
    switch (event.type) {
      case 'start':
        resetForRun();
        $('progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      case 'phase':
        $('phase').textContent = PHASES[event.name] || event.name;
        $('bar-wrap').classList.toggle('is-indeterminate', event.name !== 'crawl');
        break;
      case 'progress': {
        const pct = event.total ? Math.round((event.done / event.total) * 100) : 0;
        $('bar').style.width = `${pct}%`;
        $('progress-count').textContent = `${event.done} of ${event.total} URLs · ${pct}%`;
        break;
      }
      case 'url': {
        liveCount += 1;
        // Newest first; keep the latest 500 rows (the full list arrives with the results).
        const row = el('div', 'ui_live-row');
        row.append(el('span', '', event.chain || '…'), el('span', '', event.oldUrl));
        $('live').prepend(row);
        if ($('live').childElementCount > 500) $('live').lastElementChild.remove();
        break;
      }
      case 'done':
        $('phase').textContent = 'Done';
        $('bar-wrap').classList.remove('is-indeterminate');
        $('bar').style.width = '100%';
        $('cancel').hidden = true;
        $('run').disabled = false;
        await loadResults();
        break;
      case 'cancelled':
        $('phase').textContent = 'Cancelled';
        $('cancel').hidden = true;
        $('run').disabled = false;
        break;
      case 'error':
        $('phase').textContent = 'The check stopped';
        $('progress-count').textContent = event.message || '';
        $('cancel').hidden = true;
        $('run').disabled = false;
        break;
      default:
    }
  };

  const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  events.onmessage = (message) => {
    try {
      handle(JSON.parse(message.data));
    } catch {
      /* ignore a malformed event */
    }
  };

  $('cancel').addEventListener('click', async () => {
    $('cancel').disabled = true;
    try {
      await post('/api/cancel');
    } catch (err) {
      $('progress-count').textContent = err.message;
    }
  });

  // ---- Results ----

  const MARK = { error: 'ERR', warning: 'WARN', notice: 'NOTE' };
  const state = { data: null, severity: 'all', type: '', query: '', hideDone: false, shown: PAGE };
  // The status chain and landing page are part of the key: if a fix didn't work and the
  // problem comes back looking different, it shows as not done again.
  const doneKey = (p) => `rmc-done:${p.type}|${p.oldUrl}|${p.statusChain || ''}|${p.finalUrl || ''}`;
  const isDone = (p) => {
    try {
      return localStorage.getItem(doneKey(p)) === '1';
    } catch {
      return false;
    }
  };
  const setDone = (p, on) => {
    try {
      if (on) localStorage.setItem(doneKey(p), '1');
      else localStorage.removeItem(doneKey(p));
    } catch {
      /* storage unavailable: the mark lasts until the page reloads */
    }
  };

  const headline = (s) => {
    const urls = `${s.urlsChecked} URL${s.urlsChecked === 1 ? '' : 's'}`;
    const unchecked = s.urlsUnchecked || 0;
    const broken = s.urlsWithErrors - unchecked;
    const lost = s.sitemapsUnread ? ` ${s.sitemapsUnread} sitemap${s.sitemapsUnread === 1 ? '' : 's'} could not be read.` : '';
    if (unchecked && broken > 0) return `${broken} of ${urls} need fixing, and ${unchecked} could not be checked.${lost}`;
    if (unchecked) return `${unchecked} of ${urls} could not be checked.${lost}`;
    if (s.urlsWithErrors > 0) return `${s.urlsWithErrors} of ${urls} need fixing.${lost}`;
    if (lost) return lost.trim();
    if (s.urlsWithWarnings > 0) return `No errors in ${urls}. ${s.urlsWithWarnings} with warnings.`;
    return `All ${urls} redirect cleanly.`;
  };

  async function loadResults() {
    const res = await get('/api/results');
    if (!res.ok) return;
    const data = await res.json();
    state.data = data;
    state.shown = PAGE;
    const s = data.summary;
    $('results').hidden = false;
    $('stats-section').hidden = false;
    $('list-section').hidden = false;
    $('headline').textContent = headline(s);
    $('results-meta').textContent = `${s.urlsChecked} URLs · ${s.requests} requests · ${(s.durationMs / 1000).toFixed(1)} s${s.base ? ` · tested against ${s.base}` : ''}`;
    $('dl-old').hidden = !data.hasOldPages;
    $('saved').textContent = '';
    saveOverwrite = false;

    const stats = $('stats');
    stats.replaceChildren();
    for (const [n, label] of [
      [s.urlsChecked, 'URLs checked'],
      [s.urlsWithErrors, 'With errors'],
      [s.urlsWithWarnings, 'Warnings only'],
      [s.clean, 'Clean'],
    ]) {
      const cell = el('div', 'stats_cell');
      cell.append(el('p', 'stats_number', n), el('p', 'text-style-mono text-color-grey', label));
      stats.append(cell);
    }

    const chips = $('chips');
    chips.replaceChildren();
    const counts = { error: 0, warning: 0, notice: 0 };
    for (const p of data.problems) counts[p.severity] += 1;
    for (const [key, label] of [
      ['all', `All ${data.problems.length}`],
      ['error', `Errors ${counts.error}`],
      ['warning', `Warnings ${counts.warning}`],
      ['notice', `Notices ${counts.notice}`],
    ]) {
      const chip = el('button', 'ui_chip', label);
      chip.type = 'button';
      chip.dataset.severity = key;
      chip.setAttribute('aria-pressed', String(state.severity === key));
      chip.addEventListener('click', () => {
        state.severity = key;
        state.shown = PAGE;
        for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.severity === key));
        render();
      });
      chips.append(chip);
    }

    const type = $('type');
    type.replaceChildren(el('option', '', 'All types'));
    type.firstChild.value = '';
    const titles = new Map();
    for (const p of data.problems) titles.set(p.type, p.title);
    for (const [t, title] of titles) {
      const opt = el('option', '', title);
      opt.value = t;
      type.append(opt);
    }
    type.value = '';
    state.type = '';

    const notes = $('notes');
    notes.replaceChildren(...data.notes.map((n) => el('li', '', n)));
    $('notes-wrap').hidden = data.notes.length === 0;
    render();
  }

  function card(p) {
    const li = el('li', `item_card${isDone(p) ? ' is-done' : ''}`);
    const head = el('div', 'item_head');
    const left = el('div');
    const url = el('p', 'item_url');
    url.append(p.oldUrl ? link(p.oldUrl) : el('span', 'text-color-grey', 'Inputs'));
    const typeLine = el('p', 'item_type');
    typeLine.append(el('span', `mark is-${p.severity}`, `[${MARK[p.severity]}]`), document.createTextNode(` ${p.title}`));
    left.append(url, typeLine);
    const doneLabel = el('label', 'ui_check ui_done');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = isDone(p);
    box.addEventListener('change', () => {
      setDone(p, box.checked);
      li.classList.toggle('is-done', box.checked);
      if (state.hideDone) render();
    });
    doneLabel.append(box, el('span', '', 'Done'));
    head.append(left, doneLabel);
    li.append(head);

    if (p.fix) {
      const fix = el('div', 'item_fix');
      fix.append(el('p', 'text-style-mono item_fix-label', 'Recommended fix'), el('p', '', p.fix));
      li.append(fix);
    }
    const facts = el('dl', 'item_facts');
    const fact = (label, value) => {
      const row = el('div', 'item_fact');
      const dd = el('dd');
      dd.append(value);
      row.append(el('dt', '', label), dd);
      facts.append(row);
    };
    if (p.statusChain) fact('Statuses', el('span', 'chain', p.statusChain));
    if (p.finalUrl) fact('Lands on', link(p.finalUrl));
    if (p.expectedUrl && p.expectedUrl !== p.finalUrl) fact('Expected', link(p.expectedUrl));
    if (p.detail) fact('Details', document.createTextNode(p.detail));
    if (p.suggestions && p.suggestions.length) {
      const ol = el('ol', 'cand_list');
      for (const c of p.suggestions) {
        const item = el('li');
        item.append(link(c.url));
        if (c.title) item.append(document.createTextNode(' '), el('span', 'text-color-grey', c.title));
        item.append(document.createTextNode(' '), el('span', `cand_score is-${c.confidence}`, `${c.confidence} ${Number(c.score).toFixed(2)}`));
        ol.append(item);
      }
      fact('Candidates', ol);
    }
    if (facts.children.length) li.append(facts);
    return li;
  }

  function filtered() {
    const q = state.query.toLowerCase();
    return state.data.problems.filter(
      (p) =>
        (state.severity === 'all' || p.severity === state.severity) &&
        (!state.type || p.type === state.type) &&
        (!state.hideDone || !isDone(p)) &&
        (!q || `${p.oldUrl} ${p.finalUrl} ${p.expectedUrl} ${p.fix} ${p.detail}`.toLowerCase().includes(q)),
    );
  }

  function render() {
    if (!state.data) return;
    const items = filtered();
    $('list').replaceChildren(...items.slice(0, state.shown).map(card));
    $('more').hidden = items.length <= state.shown;
    $('shown').textContent = items.length ? `Showing ${Math.min(items.length, state.shown)} of ${items.length} problems` : 'No problems match these filters.';
  }

  $('search').addEventListener('input', () => {
    state.query = $('search').value;
    state.shown = PAGE;
    render();
  });
  $('type').addEventListener('change', () => {
    state.type = $('type').value;
    state.shown = PAGE;
    render();
  });
  $('hide-done').addEventListener('change', () => {
    state.hideDone = $('hide-done').checked;
    render();
  });
  $('more').addEventListener('click', () => {
    state.shown += PAGE;
    render();
  });
  // Downloads go through fetch with the token header, so no address with the token ends up
  // in the browser's history or download list.
  for (const button of document.querySelectorAll('[data-file]')) {
    button.addEventListener('click', async () => {
      const name = button.dataset.file;
      button.disabled = true;
      try {
        const res = await get(`/api/download/${name}`);
        if (!res.ok) throw new Error(`Could not get ${name} (HTTP ${res.status}).`);
        const blob = await res.blob();
        const href = URL.createObjectURL(name === 'report.html' ? new Blob([blob], { type: 'text/html' }) : blob);
        const a = document.createElement('a');
        a.href = href;
        if (name === 'report.html') {
          a.target = '_blank';
          a.rel = 'noopener';
        } else {
          a.download = name;
        }
        document.body.append(a);
        a.click();
        a.remove();
        // The report tab may be reloaded, so its link lives as long as this page; downloads don't need it after a minute.
        if (name !== 'report.html') setTimeout(() => URL.revokeObjectURL(href), 60_000);
      } catch (err) {
        $('saved').textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  let saveOverwrite = false;
  $('save').addEventListener('click', async () => {
    $('saved').textContent = 'Saving…';
    try {
      const answer = await post('/api/save', { overwrite: saveOverwrite });
      if (answer.exists) {
        saveOverwrite = true;
        $('save').textContent = 'Replace the saved report';
        $('saved').textContent = `${answer.path} already has a report. Click again to replace it.`;
        return;
      }
      $('saved').textContent = `Saved to ${answer.path}`;
      saveOverwrite = false;
      $('save').textContent = 'Save to folder';
    } catch (err) {
      $('saved').textContent = err.message;
    }
  });
})();
