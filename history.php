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
  .dfile { display: flex; align-items: baseline; gap: 8px; cursor: pointer;
           font-family: var(--mono); font-size: 11.5px; color: var(--amber); padding: 7px 14px; font-weight: 600; }
  .dfile:hover { background: var(--chrome-bg2); }
  .dfile .arr { flex-shrink: 0; display: inline-block; color: var(--muted); font-size: 9px; transition: transform .1s; }
  .file.open > .dfile .arr { transform: rotate(90deg); }
  .dfile .fsum { margin-left: auto; flex-shrink: 0; color: var(--muted); font-weight: 400; font-size: 10.5px; }
  .fbody { display: none; }
  .file.open > .fbody { display: block; }
  .file + .file { border-top: 1px solid var(--chrome-border); }
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
  /* Context menu + toast — trimmed copies of the main app's styles (assets/app.css). */
  .ctx-menu {
    position: fixed; z-index: 300; min-width: 200px; padding: 6px;
    background: var(--chrome-bg2); border: 1px solid var(--body-border);
    border-radius: 11px; box-shadow: 0 20px 50px -12px rgba(0,0,0,.7);
  }
  .ctx-item {
    display: flex; align-items: center; gap: 11px;
    padding: 8px 11px; font-size: 13px; font-weight: 500; border-radius: 7px;
    cursor: pointer; color: var(--text); white-space: nowrap; user-select: none;
  }
  .ctx-item:hover { background: rgba(255,255,255,.06); }
  .ctx-item[data-icon="diff"] .ico { color: var(--gold); opacity: 1; }
  .ctx-sep { height: 1px; margin: 4px 6px; background: var(--chrome-border); }
  .ico { flex: none; width: 14px; height: 14px; opacity: .8; position: relative; left: -4px; }
  .ctx-item:hover .ico { opacity: 1; }
  .ctx-item.has-sub { position: relative; }
  .ctx-arrow { margin-left: auto; padding-left: 12px; font-size: 9px; color: var(--muted); }
  .ctx-item.has-sub:hover .ctx-arrow { color: inherit; }
  .ctx-submenu { position: absolute; left: 100%; top: -5px; margin-left: 3px; display: none; }
  .ctx-item.has-sub:hover > .ctx-submenu { display: block; }
  .ctx-submenu.flip { left: auto; right: 100%; margin-left: 0; margin-right: 3px; }
  .toast {
    position: fixed; bottom: 18px; right: 18px; z-index: 200; max-width: 440px;
    background: var(--chrome-bg2); border: 1px solid var(--body-border); border-left: 3px solid var(--gold);
    border-radius: 6px; padding: 11px 14px; font-size: 12.5px; box-shadow: 0 10px 36px rgba(0,0,0,.5);
    white-space: pre-wrap; word-break: break-word;
  }
  .toast.err { border-left-color: var(--red); }
  .toast.ok { border-left-color: var(--green); }
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
let project = null;

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
    const fh = ev.target.closest('.dfile');
    if (fh) { fh.parentElement.classList.toggle('open'); return; }
    const head = ev.target.closest('.ehead');
    if (!head) return;
    toggle(head.parentElement);
  };

  list.oncontextmenu = ev => {
    const fh = ev.target.closest('.dfile');
    if (!fh) return;
    ev.preventDefault();
    openContextMenu(ev.clientX, ev.clientY, fileMenu(fh.dataset.path));
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

function diffLines(lines) {
  return lines.map(l => {
    const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
    return `<div class="dl ${cls}"><span class="pm">${l.t === ' ' ? '&nbsp;' : l.t}</span>${esc(l.s)}</div>`;
  }).join('');
}

function diffHtml(files) {
  if (!files.length) return '<div class="more">No textual changes in this revision for this path.</div>';
  return files.map(f => {
    const props = f.props || [];
    let add = 0, del = 0;
    for (const h of f.hunks) for (const l of h.lines) { if (l.t === '+') add++; else if (l.t === '-') del++; }
    const parts = [];
    if (f.binary) parts.push('binary');
    if (add || del) parts.push(`+${add} −${del}`);
    for (const p of props) parts.push(`${p.action.toLowerCase()} ${p.name}`);
    const sum = parts.join(' · ') || 'no changes';

    let body = '';
    if (f.binary) body += '<div class="more">Binary file — no text diff.</div>';
    else for (const h of f.hunks) {
      body += `<div class="dhunk">@@ -${h.oldStart} +${h.newStart} @@</div>` + diffLines(h.lines);
    }
    for (const p of props) {
      body += `<div class="dhunk">${esc(p.action)}: ${esc(p.name)}</div>` + diffLines(p.lines);
    }
    if (!body) body = '<div class="more">No changes recorded for this path.</div>';

    return `<div class="file">
      <div class="dfile" data-path="${esc(f.file)}"><span class="arr">▸</span><span>${esc(f.file)}</span><span class="fsum">${esc(sum)}</span></div>
      <div class="fbody">${body}</div>
    </div>`;
  }).join('');
}

// ---- file context menu — trimmed copy of the main app's menu (assets/app.js),
// limited to actions that make sense in a read-only history window.

const ICONS = {
  diff:    '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  open:    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  explorer:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  copy:    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
function icon(name) {
  const p = ICONS[name];
  return p
    ? `<svg class="ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
    : '';
}

let toastTimer = null;
function toast(msg, kind = '') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4500);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (!ok) return toast('Copy failed', 'err');
  }
  toast(`Copied ${what}`, 'ok');
}

let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  document.removeEventListener('mousedown', closeCtxMenu);
  document.removeEventListener('scroll', closeCtxMenu, true);
}

function buildMenu(items) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.separator) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.submenu ? ' has-sub' : '');
    if (it.icon) el.dataset.icon = it.icon;
    el.innerHTML = icon(it.icon) + `<span>${esc(it.label)}</span>` + (it.submenu ? '<span class="ctx-arrow">▸</span>' : '');
    if (it.submenu) {
      const sub = buildMenu(it.submenu);
      sub.classList.add('ctx-submenu');
      el.appendChild(sub);
      el.addEventListener('mouseenter', () => {
        sub.classList.remove('flip');
        if (sub.getBoundingClientRect().right > window.innerWidth - 4) sub.classList.add('flip');
      });
    } else {
      el.addEventListener('click', e => { e.stopPropagation(); closeCtxMenu(); it.onClick(); });
    }
    menu.appendChild(el);
  }
  return menu;
}

function openContextMenu(x, y, items) {
  closeCtxMenu();
  const menu = buildMenu(items);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menu.onmousedown = e => e.stopPropagation();
  ctxMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', closeCtxMenu);
    document.addEventListener('scroll', closeCtxMenu, true);
  }, 0);
}

async function apiToast(action, path, msg) {
  try { await api(action, { id: projectId, path }); toast(msg, 'ok'); }
  catch (err) { toast(err.message, 'err'); }
}

function fileMenu(relPath) {
  const isRoot = relPath === '.' || relPath === '';
  const fileName = isRoot ? (project?.name || '') : relPath.split('/').pop();
  const fullPath = ((project?.path || '') + (isRoot ? '' : '/' + relPath)).replace(/\//g, '\\');
  const items = [];
  if (!isRoot) {
    // Same action as double-clicking the row in the main file-list view.
    items.push({ label: 'Open Diff', icon: 'diff', onClick: () => apiToast('extdiff', relPath, `Opening diff for ${fileName}…`) });
    items.push({ label: 'Open', icon: 'open', onClick: () => apiToast('open_path', relPath, `Opening ${fileName}…`) });
  }
  items.push({ label: 'Open in Explorer', icon: 'explorer', onClick: () => apiToast('reveal', isRoot ? '' : relPath, `Showing ${fileName} in Explorer…`) });
  items.push({ label: 'Copy', icon: 'copy', submenu: [
    { label: 'Copy Filename', onClick: () => copyText(fileName, 'filename') },
    { label: 'Copy Relative Path', onClick: () => copyText(isRoot ? '.' : relPath, 'relative path') },
    { label: 'Copy Full Path', onClick: () => copyText(fullPath, 'full path') },
  ]});
  // A history window scoped to just this file (same as the main view's History…).
  if (!isRoot && relPath !== (qs.get('path') || '')) {
    items.push({ label: 'History…', icon: 'history', onClick: () => {
      const url = 'history.php?id=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent(relPath);
      window.open(url, '', 'width=1050,height=780,resizable=yes,scrollbars=yes');
    }});
  }
  return items;
}

async function loadMore() {
  try {
    const before = entries.length ? entries[entries.length - 1].rev : null;
    const data = await api('log', { id: projectId, path: relPath, limit, before });
    limit = data.limit;
    project = data.project;
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
