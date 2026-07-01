<?php declare(strict_types=1); /* Bixi — standalone commit-history window (read-only). */
require_once __DIR__ . '/lib/preflight.php';
svn_preflight_gate();   // missing / too-old svn → renders the setup page and exits
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>History — Bixi</title>
<style>
  /* IBM Plex Sans/Mono, vendored locally (offline / no CDN) — see assets/vendor/fonts/. */
  @font-face { font-family:'IBM Plex Sans'; font-weight:400; font-display:swap; src:url(assets/vendor/fonts/ibm-plex-sans-latin-400.woff2) format('woff2'); }
  @font-face { font-family:'IBM Plex Sans'; font-weight:600; font-display:swap; src:url(assets/vendor/fonts/ibm-plex-sans-latin-600.woff2) format('woff2'); }
  @font-face { font-family:'IBM Plex Sans'; font-weight:700; font-display:swap; src:url(assets/vendor/fonts/ibm-plex-sans-latin-700.woff2) format('woff2'); }
  @font-face { font-family:'IBM Plex Mono'; font-weight:400; font-display:swap; src:url(assets/vendor/fonts/ibm-plex-mono-latin-400.woff2) format('woff2'); }
  @font-face { font-family:'IBM Plex Mono'; font-weight:600; font-display:swap; src:url(assets/vendor/fonts/ibm-plex-mono-latin-600.woff2) format('woff2'); }
  :root {
    --chrome-bg: #101216; --chrome-bg2: #14161b; --chrome-border: #1d2027;
    --body-bg: #0d0e11; --body-border: #262a33; --text: #e6e8ec; --muted: #8b909a;
    --gold: #f5b13d; --green: #4ec97a; --red: #f0616a; --amber: #e8a13a; --blue: #5aa9f0;
    --mono: 'IBM Plex Mono', 'Cascadia Code', Consolas, monospace;
  }
  * { box-sizing: border-box; font-variant-ligatures: none; }
  body {
    margin: 0; background: var(--body-bg); color: var(--text);
    font-family: 'IBM Plex Sans', -apple-system, system-ui, sans-serif; font-size: 13px;
  }
  .topbar {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: baseline; gap: 10px;
    padding: 10px 16px; background: var(--chrome-bg); border-bottom: 1px solid var(--chrome-border);
  }
  .topbar .t { font-weight: 700; font-size: 14px; }
  .topbar .p { font-family: var(--mono); font-size: 11.5px; color: var(--muted);
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #list { padding: 10px 16px 28px; max-width: 1200px; }
  .msg { padding: 28px; color: var(--muted); text-align: center; }
  .entry { border: 1px solid var(--body-border); border-radius: 6px; margin-bottom: 8px; background: var(--chrome-bg); }
  .ehead { display: flex; align-items: baseline; gap: 12px; padding: 8px 12px; cursor: pointer; }
  .ehead:hover { background: var(--chrome-bg2); }
  .ehead .rev { font-family: var(--mono); font-weight: 700; color: var(--gold); flex-shrink: 0; min-width: 64px; }
  .ehead .author { color: var(--blue); flex-shrink: 0; min-width: 90px; font-size: 12px; }
  .ehead .date { color: var(--muted); font-family: var(--mono); font-size: 11px; flex-shrink: 0; }
  .ehead .m1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .ebody { display: none; border-top: 1px solid var(--chrome-border); }
  .entry.open .ebody { display: block; }
  .fullmsg { white-space: pre-wrap; padding: 10px 14px; color: var(--text); font-size: 12.5px;
             border-bottom: 1px solid var(--chrome-border); background: var(--chrome-bg2); }
  .dfile { font-family: var(--mono); font-size: 11.5px; color: var(--amber); padding: 7px 14px 4px; font-weight: 600; }
  .dhunk { font-family: var(--mono); font-size: 10px; color: var(--muted); padding: 3px 14px;
           background: var(--chrome-bg2); border-top: 1px solid var(--chrome-border);
           border-bottom: 1px solid var(--chrome-border); }
  .dl { font-family: var(--mono); font-size: 11.5px; line-height: 1.45; padding: 0 14px;
        white-space: pre-wrap; word-break: break-all; }
  .dl.add { background: rgba(78,201,122,.10); color: #BFE8D2; }
  .dl.del { background: rgba(240,97,106,.10); color: #EFC4C4; }
  .dl .pm { display: inline-block; width: 14px; color: var(--muted); user-select: none; }
  .dl.add .pm { color: var(--green); }
  .dl.del .pm { color: var(--red); }
  .more, .loading-diff { padding: 8px 14px; color: var(--muted); font-size: 12px; }
  button.loadmore {
    display: block; margin: 14px auto; padding: 7px 18px; border-radius: 6px; cursor: pointer;
    background: var(--chrome-bg2); color: var(--text); border: 1px solid var(--body-border); font-size: 12.5px;
  }
  button.loadmore:hover { border-color: var(--gold); color: var(--gold); }
</style>
</head>
<body>
<div class="topbar">
  <span class="t">History</span>
  <span class="p" id="hd-path">…</span>
</div>
<div id="list"><div class="msg">Loading history…</div></div>

<script>
'use strict';
const qs = new URLSearchParams(location.search);
const projectId = qs.get('id') || '';
const relPath = qs.get('path') || '';
let limit = 100;
let entries = [];
let lastBatch = 0;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(action, params = {}) {
  const res = await fetch('api.php?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function render() {
  const list = $('#list');
  if (!entries.length) { list.innerHTML = '<div class="msg">No history found.</div>'; return; }
  list.innerHTML = entries.map((e, i) => `
    <div class="entry" data-i="${i}">
      <div class="ehead">
        <span class="rev">r${e.rev}</span>
        <span class="author">${esc(e.author)}</span>
        <span class="date">${fmtDate(e.date)}</span>
        <span class="m1">${esc(e.msg.split('\n')[0])}</span>
      </div>
      <div class="ebody"></div>
    </div>`).join('')
    + (lastBatch >= limit ? '<button class="loadmore">Load older revisions…</button>' : '');

  list.onclick = ev => {
    const more = ev.target.closest('.loadmore');
    if (more) { more.disabled = true; loadMore(); return; }
    const head = ev.target.closest('.ehead');
    if (!head) return;
    toggle(head.parentElement);
  };
}

async function toggle(card) {
  const open = card.classList.toggle('open');
  const e = entries[+card.dataset.i];
  const body = $('.ebody', card);
  if (!open || body.dataset.loaded) return;
  body.dataset.loaded = '1';
  body.innerHTML = `<div class="fullmsg">${esc(e.msg) || '<i>(no commit message)</i>'}</div>
                    <div class="loading-diff">Loading diff for r${e.rev}…</div>`;
  try {
    const data = await api('revdiff', { id: projectId, path: relPath, rev: e.rev });
    body.innerHTML = `<div class="fullmsg">${esc(e.msg) || '<i>(no commit message)</i>'}</div>` + diffHtml(data.files);
  } catch (err) {
    body.innerHTML += `<div class="more">⚠ ${esc(err.message)}</div>`;
    delete body.dataset.loaded;   // allow retry on re-open
  }
}

function diffHtml(files) {
  if (!files.length) return '<div class="more">No textual changes in this revision for this path.</div>';
  return files.map(f => {
    let out = `<div class="dfile">${esc(f.file)}</div>`;
    if (f.binary) return out + '<div class="more">Binary file — no text diff.</div>';
    if (!f.hunks.length) return out + '<div class="more">Property-only change.</div>';
    for (const h of f.hunks) {
      out += `<div class="dhunk">@@ -${h.oldStart} +${h.newStart} @@</div>`;
      out += h.lines.map(l => {
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
        return `<div class="dl ${cls}"><span class="pm">${l.t === ' ' ? '&nbsp;' : l.t}</span>${esc(l.s)}</div>`;
      }).join('');
    }
    return out;
  }).join('');
}

async function loadMore() {
  try {
    const before = entries.length ? entries[entries.length - 1].rev : null;
    const data = await api('log', { id: projectId, path: relPath, limit, before });
    limit = data.limit;
    lastBatch = data.entries.length;
    entries = entries.concat(data.entries);
    if (!$('#hd-path').dataset.set) {
      $('#hd-path').dataset.set = '1';
      const label = relPath || '(project root)';
      $('#hd-path').textContent = `${data.project.name} / ${label}`;
      document.title = `History — ${relPath || data.project.name}`;
    }
    render();
  } catch (err) {
    $('#list').innerHTML = `<div class="msg">⚠ ${esc(err.message)}</div>`;
  }
}

loadMore();
</script>
</body>
</html>
