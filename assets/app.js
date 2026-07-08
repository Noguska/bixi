/* Bixi (BixiSVN) — frontend. Vanilla JS, virtualized file list, side-by-side diff. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const ROW_H = 30;

const STATUS_CHAR = {
  modified: 'M', added: 'A', deleted: 'D', unversioned: '?',
  missing: '!', replaced: 'R', conflicted: 'C', ignored: 'I', unmodified: '·',
};
const STATUS_ORDER = ['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted', 'unversioned', 'ignored', 'unmodified'];
const STATUS_COLORS = {
  modified: 'var(--amber)', added: 'var(--green)', replaced: 'var(--green)',
  deleted: 'var(--red)', missing: 'var(--red)', conflicted: 'var(--red)', unversioned: 'var(--blue)',
};
// Statuses with something for `svn revert` to undo. Unversioned/ignored aren't
// under version control; unmodified has no local change — none are revertable.
const REVERTABLE = new Set(['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted']);

const state = {
  view: 'dashboard',
  projects: [],
  project: null,
  rootRevision: null,   // working-copy root base revision
  files: [],            // [{path, status, isDir, revision, review, notes}]
  dirs: [],             // all working-copy directory paths (for the tree, incl. change-free ones)
  selectedDir: '',      // '' = project root
  expandedDirs: new Set(['']),
  // Default active status filters on load (empty Set would mean "all"). Covers
  // every change status; 'ignored' / 'unmodified' remain their own fetch toggles.
  statusFilter: new Set(['modified', 'unversioned', 'missing', 'deleted', 'added', 'conflicted', 'replaced']),
  reviewFilter: '',         // '' = all, 'approved', 'unapproved'
  kindFilter: '',           // '' = all, 'files', 'folders'
  showIgnored: false,       // when on, status fetch includes svn-ignored items
  showUnmodified: false,    // when on, status fetch is verbose (includes unchanged files)
  search: '',
  sort: [],             // [{k: status|name|dir|mtime, d: 1|-1}, ...] primary first; [] = path order
  visible: [],          // filtered file list (what the virtual list shows)
  selPath: null,        // selected file path (review panel target) — only when exactly one row is selected
  selPaths: new Set(),  // multi-selection (Ctrl/Shift click); drives row highlight
  selAnchor: null,      // anchor path for Shift range-select
  diff: null,           // loaded diff for selPath
  commitStats: null,    // {revision, total, mine, percent} for the perf bar
  eol: new Map(),       // path -> EOL token (lazy, visible rows only; null = loading)
  loading: false,
  busyCount: 0,         // >0 while a write op is in flight (locks the commit bar)
  committing: false,    // commit specifically — drives the Commit button spinner
  busyPaths: new Set(), // paths with an in-flight op (read/revert/…): row spinner
  auth: { configured: false, username: null, unlocked: false },  // master-password / SVN credential state
  activeOps: new Map(), // id -> {label, ctrl} for the bottom status bar (ctrl set = abortable)
};

// ------------------------------------------------------- busy / lock helpers

// The commit bar (message box + Commit + ⋯) is locked while any write op runs
// or a status refresh is loading.
function commitBarBusy() { return state.busyCount > 0 || state.loading; }

// Bump/drop the global write-lock and re-render the commit bar to reflect it.
function lockUI()   { state.busyCount++; renderCommitBar(); }
function unlockUI() { state.busyCount = Math.max(0, state.busyCount - 1); renderCommitBar(); }

// Toggle the per-row spinner for a path (read/revert/update/etc.). '' = whole
// working copy, which has no row — only the global lock applies.
function setPathBusy(path, busy) {
  if (path === '' || path == null) return;
  if (busy) state.busyPaths.add(path); else state.busyPaths.delete(path);
  paintRowBusy();
}

// Paint the .busy class onto currently-rendered rows (cheap, no rebuild).
function paintRowBusy() {
  const wrap = $('#vrows');
  if (!wrap) return;
  for (const row of wrap.children) {
    row.classList.toggle('busy', state.busyPaths.has(row.dataset.path));
  }
}

// Run a file/folder write op with the row spinner + commit-bar lock held for
// its duration. `fn` does the api call + any refresh; its result is returned.
async function runFileOp(path, fn) {
  lockUI();
  setPathBusy(path, true);
  try { return await fn(); }
  finally { setPathBusy(path, false); unlockUI(); }
}

// ------------------------------------------------------------------ helpers

// Actions that are safe to abandon mid-flight: read-only on the server, so
// aborting the fetch just stops waiting (any svn call it started has no effects).
// These get an AbortController — the status bar shows an × for them, and callers
// may pass opts.timeoutMs for an automatic client-side abort.
const ABORTABLE_ACTIONS = new Set([
  'projects', 'status', 'dirs', 'diff', 'update_check', 'log', 'revdiff',
  'eol_info', 'eol_scan', 'props_get', 'get_ignore',
  'merge_list', 'merge_log', 'merge_eligible', 'merge_preview',
  'master_status', 'settings_get',
]);

async function api(action, params = {}, opts = {}) {
  const ctrl = ABORTABLE_ACTIONS.has(action) ? new AbortController() : null;
  let timedOut = false;
  const timer = (ctrl && opts.timeoutMs)
    ? setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs) : null;
  const opId = pushOp(opLabel(action), ctrl);   // surface this request in the bottom status bar
  try {
    // Attach the per-session unlock token+key (if any) so the server can resolve the
    // SVN credential for credential-gated actions (commit).
    const sess = masterSession();
    const body = { ...params };
    if (sess) { body.mtoken = sess.token; body.mkey = sess.key; }

    let res;
    try {
      res = await fetch('api.php?action=' + encodeURIComponent(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (err) {
      if (ctrl && ctrl.signal.aborted) {
        throw new Error(timedOut
          ? `Timed out after ${Math.round(opts.timeoutMs / 1000)}s — repository unreachable?`
          : 'Cancelled');
      }
      throw err;
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));

    // Server says this action needs an unlocked session: prompt (unlock, or first-time
    // setup), then retry the original request exactly once — transparent to callers.
    if (data && data.ok === false && data.needMaster && !opts.retried) {
      popOp(opId);                          // stop showing this op while the modal is up
      if (sess) setMasterSession(null);     // our session was missing/expired
      const ok = await promptMasterGate({ configured: !!data.configured });
      if (!ok) throw new Error('Master password required');
      await loadAuth(); renderAuthArea();
      return await api(action, params, { ...opts, retried: true });
    }

    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  } finally {
    if (timer) clearTimeout(timer);
    popOp(opId);                            // harmless if already popped above
  }
}

// ----------------------------------------------------------- status bar
// Every server round-trip goes through api(), so tracking it here covers all AJAX
// — and since the PHP side runs the svn CLI synchronously within the request, a
// label like "Committing…" stays up for the whole svn/TortoiseSVN operation.
const OP_LABELS = {
  status: 'Refreshing status…', dirs: 'Loading folders…', diff: 'Loading diff…',
  eol_info: 'Checking line endings…', eol_scan: 'Scanning line endings…', eol_fix: 'Fixing line endings…',
  commit: 'Committing…', revert: 'Reverting…', update: 'Updating from SVN…', update_check: 'Checking for updates…',
  add: 'Adding to SVN…', delete: 'Deleting…', move: 'Moving…', cleanup: 'Running svn cleanup…', review: 'Saving review…',
  log: 'Loading history…', revdiff: 'Loading revision diff…',
  extdiff: 'Opening diff in TortoiseSVN…', open_path: 'Opening file…', reveal: 'Revealing in Explorer…',
  hide: 'Updating svn:ignore…', unhide: 'Updating svn:ignore…', get_ignore: 'Loading svn:ignore…', set_ignore: 'Saving svn:ignore…',
  props_get: 'Loading properties…', props_save: 'Saving properties…',
  merge_list: 'Listing branches…', merge_log: 'Loading branch history…', merge_eligible: 'Finding eligible revisions…',
  merge_preview: 'Previewing merge…', merge_apply: 'Merging…',
  master_status: 'Checking credentials…', master_setup: 'Saving credentials…', master_unlock: 'Unlocking…',
  master_lock: 'Locking…', master_change: 'Changing master password…', master_reset: 'Deleting credentials…',
  projects: 'Loading projects…', project_save: 'Saving project…', project_delete: 'Removing project…',
  checkout: 'Checking out…',
  settings_get: 'Loading settings…', settings_save: 'Saving settings…',
};
function opLabel(action) { return OP_LABELS[action] || 'Working…'; }

let opSeq = 0;
function pushOp(label, ctrl = null) { const id = ++opSeq; state.activeOps.set(id, { label, ctrl }); renderStatusBar(); return id; }
function popOp(id) { state.activeOps.delete(id); renderStatusBar(); }

// Render the bar from the active-op set. Two debounces keep it from flickering:
//  - SHOW is delayed (~150ms) so sub-150ms requests never flash the bar on.
//  - HIDE lingers (~450ms) so when one op finishes and another starts a moment
//    later (e.g. status → dirs → eol on a refresh), the bar stays up seamlessly
//    instead of blinking off and back on.
let sbShowTimer = null;
let sbHideTimer = null;
function renderStatusBar() {
  const el = document.getElementById('statusbar');
  if (!el) return;
  const ops = [...state.activeOps.values()];

  if (ops.length) {                                  // work in flight
    clearTimeout(sbHideTimer); sbHideTimer = null;   // cancel any pending hide — keep it up
    const extra = ops.length > 1 ? ` (+${ops.length - 1})` : '';
    const abortable = ops.filter(o => o.ctrl);       // read-only ops we can abandon
    el.innerHTML = `<span class="sb-label">${esc(ops[ops.length - 1].label + extra)}</span>`
      + `<span class="sb-bar"><span class="sb-fill"></span></span>`
      + (abortable.length ? `<button class="sb-abort" title="Cancel">×</button>` : '');
    const btn = el.querySelector('.sb-abort');
    if (btn) btn.onclick = () => { for (const o of abortable) o.ctrl.abort(); };
    if (!el.classList.contains('active') && !sbShowTimer) {
      sbShowTimer = setTimeout(() => {
        sbShowTimer = null;
        if (state.activeOps.size) el.classList.add('active');
      }, 150);
    }
    return;
  }

  // nothing in flight
  clearTimeout(sbShowTimer); sbShowTimer = null;     // a fast op finished before it ever showed
  if (!el.classList.contains('active')) return;      // never shown — nothing to hide
  if (!sbHideTimer) sbHideTimer = setTimeout(() => { // linger, in case another op starts right away
    sbHideTimer = null;
    if (!state.activeOps.size) el.classList.remove('active');
  }, 450);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function hl(line, lang) {
  if (!line) return '';
  try { return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value; }
  catch { return esc(line); }
}

// --------------------------------------------------------------------- icons
// Inline stroke icons (Lucide-style, 24×24, currentColor) — offline, no binary
// font, theme-aware. icon('name') returns an <svg> string; unknown name => ''.
const ICONS = {
  diff:    '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  update:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  add:     '<path d="M5 12h14"/><path d="M12 5v14"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  revert:  '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  delete:  '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  cleanup: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9z"/><path d="M5 16l.9 2.1L8 19l-2.1.9L5 22l-.9-2.1L2 19z"/>',
  hide:    '<path d="M10.7 5.1A9.6 9.6 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-2.2 3.1"/><path d="M6.6 6.6A16.6 16.6 0 0 0 2 12s4 7 10 7a9.5 9.5 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',
  unhide:  '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  open:    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  explorer:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  copy:    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eol:     '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  props:   '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  merge:   '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  folder:  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  up:      '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  move:    '<path d="M21 11V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6"/><path d="M14 16h7"/><path d="M18 13l3 3-3 3"/>',
  lock:    '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  edit:    '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  recheck: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
function icon(name) {
  const p = ICONS[name];
  return p
    ? `<svg class="ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
    : '';
}

// Bixi brand mark ("A3" solid shell) for the top bar: amber hexagon with the
// scute lines knocked out in the bar's surface colour. See Bixi.dc.html.
const LOGO_MARK =
  '<svg class="logo-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">'
  + '<path d="M20 4.5 L33 12 V28 L20 35.5 L7 28 V12 Z" fill="#f5b13d"/>'
  + '<path d="M20 13.5 L26.5 17.5 V23.5 L20 27.5 L13.5 23.5 V17.5 Z" stroke="#101216" stroke-width="2"/>'
  + '<path d="M20 4.5 V13.5 M33 12 L26.5 17.5 M33 28 L26.5 23.5 M20 35.5 V27.5 M7 28 L13.5 23.5 M7 12 L13.5 17.5" stroke="#101216" stroke-width="1.6" stroke-linecap="round"/>'
  + '</svg>';

// ---- Moon: the dashboard backdrop shows tonight's real lunar phase, by date ----
// Phase fraction p: 0 = new · 0.25 = first quarter · 0.5 = full · 0.75 = last quarter.
function moonPhaseFraction(date) {
  const SYNODIC = 29.530588853;                 // mean synodic month (days)
  const REF = Date.UTC(2000, 0, 6, 18, 14, 0);  // a known new moon (2000-01-06 18:14 UT)
  let p = (((date.getTime() - REF) / 86400000) % SYNODIC) / SYNODIC;
  if (p < 0) p += 1;
  return p;
}
function moonPhaseName(p) {
  return ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
          'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'][Math.round(p * 8) % 8];
}
// Path tracing the lit portion of the disc; the terminator is a half-ellipse
// whose horizontal radius shrinks to 0 at the quarters and flips past them.
function moonLitPath(cx, cy, R, p) {
  const cosv = Math.cos(2 * Math.PI * p);
  const rx = Math.max(0.01, R * Math.abs(cosv));
  const waxing = p < 0.5;
  const outerSweep = waxing ? 1 : 0;                              // lit limb: right (waxing) / left (waning)
  // Terminator bulges toward the lit limb for a crescent (cosv>0), away from it
  // for a gibbous (cosv<0) — so the lit region grows past a half-disc.
  const termSweep = waxing ? (cosv >= 0 ? 0 : 1) : (cosv >= 0 ? 1 : 0);
  return `M${cx} ${cy - R} A${R} ${R} 0 0 ${outerSweep} ${cx} ${cy + R} A${rx} ${R} 0 0 ${termSweep} ${cx} ${cy - R} Z`;
}
// The scene is viewed from Bixi's homeland: the lit limb is tilted as for an
// observer at Mount Tai (36.25°N — Bixi steles stand at its Dai Temple).
// Schematic: the terminator leans (90° − latitude) from vertical — clockwise
// while waxing, counter-clockwise while waning. Exact at the limits (equatorial
// "boat" crescent, upright polar limb); season/hour variation is ignored.
const MOON_VIEW_LAT = 36.25;

// Faint moon overlay: soft glow + a light full outline (always shown, even at new
// moon) + the lit shape for the current phase.
function moonSvg(date = new Date()) {
  const p = moonPhaseFraction(date);
  const cx = 100, cy = 100, R = 70;
  const rot = (p < 0.5 ? 1 : -1) * (90 - MOON_VIEW_LAT);
  return `
    <svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true">
      <defs><radialGradient id="dm-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f5d99a" stop-opacity="0.16"/>
        <stop offset="55%" stop-color="#f5b13d" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#f5b13d" stop-opacity="0"/>
      </radialGradient></defs>
      <circle cx="${cx}" cy="${cy}" r="98" fill="url(#dm-glow)"/>
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#f5b13d" stroke-opacity="0.28" stroke-width="1"/>
      <path d="${moonLitPath(cx, cy, R, p)}" transform="rotate(${rot.toFixed(1)} ${cx} ${cy})"
        fill="#f4e6c6" fill-opacity="0.55" stroke="#f5cf86" stroke-opacity="0.3" stroke-width="0.8"/>
    </svg>`;
}

// Inline the decorative backdrop into .dash-bg (once), and gate the Bixi easter
// egg on the moon phase — the dragon-tortoise only roams the scene under a full
// moon. (It's drawn inline, not as a background-image, so CSS can hide #bixi-egg.)
const BIXI_MOON = 'Full moon';
function mountDashBg() {
  const el = document.querySelector('.dash-bg');
  if (!el) return;
  el.classList.toggle('no-egg', moonPhaseName(moonPhaseFraction(new Date())) !== BIXI_MOON);
  if (el.dataset.loaded) return;
  el.dataset.loaded = '1';
  fetch('assets/dashboard-bg.svg').then(r => r.text()).then(svg => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('svg parse error');
    el.prepend(document.importNode(doc.documentElement, true));   // proper SVG-namespace parse
  }).catch(() => { el.dataset.loaded = ''; });   // allow a retry on next render if it failed
}

// ------------------------------------------------------------------ routing

function navigate(view, projectId = null) {
  state.view = view;
  location.hash = view === 'project' && projectId ? 'p=' + projectId : '';
  render();
}

async function boot() {
  const m = location.hash.match(/p=([a-f0-9]+)/);
  await Promise.all([loadProjects(), loadAuth()]);
  if (m && state.projects.some(p => p.id === m[1])) {
    await openProject(m[1]);
  } else {
    state.view = 'dashboard';
    render();
  }
  // No master-password prompt on load — unlocking happens lazily, only when an action
  // needs it (the commit gate triggers it via api()'s needMaster handling).
}

async function loadProjects() {
  const data = await api('projects');
  state.projects = data.projects;
}

async function loadAuth() {
  try {
    const data = await api('master_status');
    state.auth = {
      configured: !!data.configured,
      username: data.username || null,
      unlocked: !!data.unlocked,
    };
  } catch {
    state.auth = { configured: false, username: null, unlocked: false };
  }
}

// ---------------------------------------------------------------- dashboard

// Derive a sensible project name from a repo URL: the last path segment, skipping
// a conventional trunk/tags/branches layout folder.
function deriveProjectName(url) {
  const parts = String(url).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  let last = parts.pop() || '';
  if (['trunk', 'tags', 'branches'].includes(last.toLowerCase())) last = parts.pop() || last;
  return last;
}

function renderDashboard(app) {
  app.innerHTML = `
    <div class="topbar">
      <div class="logo">${LOGO_MARK}<span>Bixi</span></div>
      <div class="spacer"></div>
      <button class="btn sm ghost" id="settings-btn" title="Settings">${icon('settings')} Settings</button>
      <div class="auth-area" id="auth-area"></div>
    </div>
    <div class="dash-bg" aria-hidden="true"></div>
    <div class="dash-moon" title="${moonPhaseName(moonPhaseFraction(new Date()))}" aria-hidden="true">${moonSvg()}</div>
    <div class="dashboard">
      <div class="dash-head">
        <h1>Projects</h1>
        ${state.projects.length ? `<button class="btn sm" id="btn-update-all" title="Run svn update on every project, one at a time">${icon('update')} Update All</button>` : ''}
      </div>
      <div class="sub">SVN working copies registered for review. Click one to open it.</div>
      <div id="proj-list"></div>
      <div class="proj-add">
        <div class="proj-add-tabs">
          <button class="tab active" data-mode="existing">Register existing</button>
          <button class="tab" data-mode="checkout">Check out new</button>
        </div>
        <div class="proj-form" data-form="existing">
          <div class="field"><label>Name</label><input type="text" id="np-name" placeholder="My Project"></div>
          <div class="field grow"><label>Working copy path</label><input type="text" id="np-path" placeholder="D:\\htdocs\\myproject"></div>
          <button class="btn primary" id="np-add">Add Project</button>
        </div>
        <div class="proj-form" data-form="checkout" style="display:none">
          <div class="field grow"><label>Repository URL</label><input type="text" id="co-url" placeholder="https://svn.example.com/acme/trunk"></div>
          <div class="field grow"><label>Destination folder</label><input type="text" id="co-path" placeholder="D:\\dev\\acme"></div>
          <div class="field"><label>Name</label><input type="text" id="co-name" placeholder="acme"></div>
          <div class="field sm"><label>Revision</label><input type="text" id="co-rev" placeholder="HEAD"></div>
          <div class="field"><label>Depth</label>
            <select id="co-depth">
              <option value="infinity">Fully recursive</option>
              <option value="immediates">Immediate children</option>
              <option value="files">Files only</option>
              <option value="empty">This folder only</option>
            </select>
          </div>
          <button class="btn primary" id="co-add">Check out</button>
        </div>
      </div>
    </div>`;

  mountDashBg();   // inline the backdrop scene + gate the Bixi easter egg by moon phase

  const list = $('#proj-list', app);
  if (!state.projects.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">No projects yet</div>Add an SVN working copy path below to get started.</div>`;
  } else {
    list.innerHTML = state.projects.map(p => `
      <div class="proj-card" data-id="${p.id}">
        <div class="grow">
          <div class="pname">${esc(p.name)} <span class="pcount" data-pcount="${p.id}"></span></div>
          <div class="ppath">${esc(p.path)}${p.url ? ' &nbsp;·&nbsp; ' + esc(p.url) : ''}</div>
        </div>
        <button class="btn sm ghost" data-edit="${p.id}">Edit</button>
        <button class="btn sm ghost danger" data-del="${p.id}">Remove</button>
        <div class="proj-update" data-upd="${p.id}"><button class="btn sm" disabled><span class="spinner"></span> Update</button></div>
      </div>`).join('');
    // Kick off an update check per project (queued one-at-a-time inside
    // checkProjectUpdate; every card shows its spinner immediately). Cards whose
    // check already completed this session restore the cached result instead —
    // this is how the queue resumes after a trip into a project.
    state.projects.forEach(p => {
      const cached = updCheckCache.get(p.id);
      if (cached) applyUpdateCheckResult(p.id, cached);
      else if (!updateCheckPending(p.id)) checkProjectUpdate(p.id);
    });
    pumpUpdateChecks();   // resume anything queued while a project view was open
    const updAll = $('#btn-update-all', app);
    if (updAll) updAll.onclick = updateAllProjects;
  }

  list.onclick = e => {
    const upd = e.target.closest('[data-update-btn]');
    if (upd) { e.stopPropagation(); runProjectUpdate(upd.dataset.updateBtn); return; }
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (del) {
      e.stopPropagation();
      removeProject(state.projects.find(x => x.id === del.dataset.del));
      return;
    }
    if (edit) {
      e.stopPropagation();
      editProject(state.projects.find(x => x.id === edit.dataset.edit));
      return;
    }
    const card = e.target.closest('.proj-card');
    if (card) openProject(card.dataset.id);
  };

  list.oncontextmenu = e => {
    const card = e.target.closest('.proj-card');
    if (!card) return;
    e.preventDefault();
    const p = state.projects.find(x => x.id === card.dataset.id);
    if (p) openContextMenu(e.clientX, e.clientY, dashProjectMenu(p));
  };

  $('#np-add', app).onclick = async () => {
    const name = $('#np-name', app).value.trim();
    const path = $('#np-path', app).value.trim();
    if (!name || !path) return toast('Name and path are required', 'err');
    try {
      await api('project_save', { name, path });
      await loadProjects(); render();
    } catch (err) { toast(err.message, 'err'); }
  };

  // Toggle between the "register existing" and "check out new" forms.
  app.querySelectorAll('.proj-add-tabs .tab').forEach(tab => {
    tab.onclick = () => {
      const mode = tab.dataset.mode;
      app.querySelectorAll('.proj-add-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
      app.querySelectorAll('.proj-form[data-form]').forEach(f => {
        f.style.display = f.dataset.form === mode ? '' : 'none';
      });
    };
  });

  // Auto-fill the project name from the URL's last meaningful segment, until the
  // user types their own name.
  const coName = $('#co-name', app);
  $('#co-url', app).oninput = e => {
    if (coName.dataset.touched) return;
    coName.value = deriveProjectName(e.target.value);
  };
  coName.oninput = () => { coName.dataset.touched = '1'; };

  $('#co-add', app).onclick = async () => {
    const url   = $('#co-url', app).value.trim();
    const path  = $('#co-path', app).value.trim();
    const name  = coName.value.trim();
    const rev   = $('#co-rev', app).value.trim();
    const depth = $('#co-depth', app).value;
    if (!url || !path || !name) return toast('URL, destination, and name are required', 'err');
    if (rev && !/^\d+$/.test(rev)) return toast('Revision must be a whole number', 'err');
    const params = { url, path, name, depth };
    if (rev) params.rev = parseInt(rev, 10);
    try {
      const chk = await api('checkout', { ...params, precheck: true });
      if (chk.isFile) return toast('Destination is a file, not a folder', 'err');
      if (chk.exists && !confirm(chk.isWc
          ? 'That folder is already a working copy. Check out into it anyway?'
          : 'The destination folder already exists. Check out into it anyway?')) return;
      const res = await api('checkout', params);
      await loadProjects(); render();
      if (res.project) openProject(res.project.id);
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#settings-btn', app).onclick = openSettingsModal;
  renderAuthArea();
}

async function editProject(p) {
  const name = prompt('Project name:', p.name); if (name === null) return;
  const path = prompt('Working copy path:', p.path); if (path === null) return;
  try { await api('project_save', { id: p.id, name, path }); await loadProjects(); render(); }
  catch (err) { toast(err.message, 'err'); }
}

async function removeProject(p) {
  if (!confirm(`Remove project "${p.name}"? (Review state JSON is deleted too; the working copy is untouched.)`)) return;
  await api('project_delete', { id: p.id }).catch(err => toast(err.message, 'err'));
  saveCommitDraft(p.id, '');  // drop any saved commit-message draft
  await loadProjects(); render();
}

// Right-click menu for a dashboard project card. Everything here runs against an
// explicit project id — state.project is null on the dashboard.
function dashProjectMenu(p) {
  const copyItems = [
    { label: 'Copy Name', onClick: () => copyText(p.name, 'name') },
    { label: 'Copy Path', onClick: () => copyText(p.path, 'path') },
  ];
  if (p.url) copyItems.push({ label: 'Copy Repo URL', onClick: () => copyText(p.url, 'repo URL') });
  return [
    { label: 'Open', icon: 'open', onClick: () => openProject(p.id) },
    { label: 'Open in Explorer', icon: 'explorer', onClick: async () => {
        try { await api('reveal', { id: p.id, path: '' }); toast(`Showing ${p.name} in Explorer…`, 'ok'); }
        catch (err) { toast(err.message, 'err'); }
      } },
    { label: 'Copy', icon: 'copy', submenu: copyItems },
    { separator: true },
    { label: 'Update', icon: 'update', onClick: () => runProjectUpdate(p.id) },
    { label: 'Re-check Status', icon: 'recheck', onClick: () => checkProjectUpdate(p.id) },
    { label: 'History…', icon: 'history', onClick: () => openHistory('', p.id) },
    { label: 'SVN Cleanup…', icon: 'cleanup', onClick: () => openCleanupModal('', p.name, p) },
    { separator: true },
    { label: 'Edit…', icon: 'edit', onClick: () => editProject(p) },
    { label: 'Remove…', icon: 'delete', danger: true, onClick: () => removeProject(p) },
  ];
}

// Per-project update slot on the dashboard. Renders the spinner/up-to-date/
// update-available state into the card's [data-upd] cell (no-op if the card
// has since been re-rendered away).
function setProjectUpdateSlot(id, html) {
  const slot = document.querySelector(`.proj-update[data-upd="${id}"]`);
  if (slot) slot.innerHTML = html;
}

// Ajax check whether the repo is ahead of this working copy. The Update button
// stays disabled (greyed) while loading, then becomes an active primary button
// if an update is available, or shows a disabled "Up to date" state otherwise.
//
// Checks run through a one-at-a-time queue: the app is normally served by PHP's
// built-in server, which handles a single request at a time (its worker pool is
// fork-based — unavailable on Windows). Firing every project's check concurrently
// made them queue server-side while each one's 20s client timer kept ticking, so
// every project behind one slow check falsely reported "Unreachable". Queuing
// client-side scopes each timeout to its own request.
//
// The queue only runs while the dashboard is showing: opening a project drops
// whatever is still queued so those checks don't compete with the project view's
// own requests (an already in-flight check just finishes). Completed results are
// cached, so returning to the dashboard resumes where the queue left off —
// already-checked cards restore instantly and only the rest re-check.
let updCheckQueue = [];            // [{id, resolve}] awaiting a check
let updCheckBusy = false;          // a checkProjectUpdateNow is in flight
let updCheckInFlight = null;       // id of the check currently in flight
const updCheckCache = new Map();   // id → last successful result (see applyUpdateCheckResult)

// True if a fresh result for this project is already on its way (queued or in
// flight) — renderDashboard uses this to avoid queueing duplicate checks.
function updateCheckPending(id) {
  return updCheckInFlight === id || updCheckQueue.some(j => j.id === id);
}

function checkProjectUpdate(id) {
  setProjectUpdateSlot(id, `<button class="btn sm" disabled><span class="spinner"></span> Update</button>`);
  return new Promise(resolve => {
    updCheckQueue.push({ id, resolve });
    pumpUpdateChecks();
  });
}

async function pumpUpdateChecks() {
  if (updCheckBusy) return;
  updCheckBusy = true;
  while (updCheckQueue.length && state.view === 'dashboard') {
    const job = updCheckQueue.shift();
    updCheckInFlight = job.id;
    await checkProjectUpdateNow(job.id);
    updCheckInFlight = null;
    job.resolve();
  }
  updCheckBusy = false;
}

// Called when leaving the dashboard. Unsent checks are dropped, not deferred —
// renderDashboard re-queues any project without a cached result on the way back.
function dropQueuedUpdateChecks() {
  for (const job of updCheckQueue.splice(0)) job.resolve();
}

function applyUpdateCheckResult(id, r) {
  setProjectUpdateSlot(id, r.slot);
  const cnt = document.querySelector(`[data-pcount="${id}"]`);
  if (cnt && r.pcount) { cnt.className = r.pcount.cls; cnt.textContent = r.pcount.text; }
}

async function checkProjectUpdateNow(id) {   // never rejects, so the queue can't stall
  try {
    // Client-side backstop over the server's own 15s svn timeout, so the spinner
    // clears even if the request itself stalls (VPN down / IP-firewalled repo).
    const d = await api('update_check', { id }, { timeoutMs: 20000 });
    const r = {
      pcount: d.pendingCount > 0
        ? { cls: 'pcount pending', text: `${d.pendingCount} pending` }
        : { cls: 'pcount clean', text: '✓ Clean' },
      slot: d.updateAvailable
        ? `<button class="btn sm primary" data-update-btn="${id}" title="r${d.localRevision} → r${d.headRevision}">`
          + `${icon('update')} Update <span class="upd-rev">r${d.headRevision}</span></button>`
        : `<button class="btn sm" disabled title="r${d.localRevision} — up to date">Up to date</button>`,
    };
    updCheckCache.set(id, r);   // failures aren't cached — they retry on the next dashboard visit
    applyUpdateCheckResult(id, r);
  } catch (err) {
    const unreachable = /timed out|unreachable/i.test(err.message);
    setProjectUpdateSlot(id,
      `<button class="btn sm" disabled title="${esc(err.message)}">${unreachable ? 'Unreachable' : 'Check failed'}</button>`);
  }
}

// Run `svn update` for one project (user-triggered), then re-check.
async function runProjectUpdate(id) {
  setProjectUpdateSlot(id, `<button class="btn sm" disabled><span class="spinner"></span> Updating…</button>`);
  try {
    const d = await api('update', { id });
    toast(d.output || 'Updated.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await checkProjectUpdate(id);
}

// Update All: `svn update` every registered project, strictly one at a time —
// updates are state-changing, and the single-worker server would serialize them
// anyway, so sequential is both the safe and the honest ordering. Each card
// re-checks right after its update; one summary toast at the end (per-project
// success toasts would stack up).
async function updateAllProjects() {
  const btn = document.querySelector('#btn-update-all');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Updating All…`; }
  state.projects.forEach(p => setProjectUpdateSlot(p.id,
    `<button class="btn sm" disabled><span class="spinner"></span> Queued…</button>`));
  let done = 0;
  const failures = [];
  for (const p of state.projects) {
    setProjectUpdateSlot(p.id, `<button class="btn sm" disabled><span class="spinner"></span> Updating…</button>`);
    try { await api('update', { id: p.id }); done++; }
    catch (err) { failures.push(`${p.name}: ${err.message}`); }
    await checkProjectUpdate(p.id);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = `${icon('update')} Update All`; }
  if (failures.length) toast(`Updated ${done} of ${state.projects.length} — failed: ${failures.join(' · ')}`, 'err');
  else toast(done === 1 ? 'Project updated.' : `All ${done} projects updated.`, 'ok');
}

// ------------------------------------------------ master password / SVN account
//
// The SVN password is encrypted at rest under a master password (see lib/master.php).
// Unlocking once per browser session yields a {token, key} we keep in sessionStorage;
// api() attaches it so the server can resolve the credential for commit. The master
// password and SVN password are never held in JS beyond the moment they're submitted.

const MASTER_SS_KEY = 'svnreview:master';
function masterSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(MASTER_SS_KEY) || 'null');
    return (s && s.token && s.key) ? s : null;
  } catch { return null; }
}
function setMasterSession(s) {
  try { s ? sessionStorage.setItem(MASTER_SS_KEY, JSON.stringify(s)) : sessionStorage.removeItem(MASTER_SS_KEY); }
  catch {}
}

// Which modal to show when an action needs an unlock: set up first if unconfigured.
function promptMasterGate({ configured }) {
  return configured ? openMasterUnlockModal() : openMasterSetupModal();
}

function renderAuthArea() {
  const el = $('#auth-area');
  if (!el) return;
  const a = state.auth;

  if (!a.configured) {
    el.innerHTML = `
      <span class="user-chip muted" title="No SVN credential stored yet">
        <span class="avatar empty">?</span>
        <span class="uname">Not set up</span>
      </span>
      <button class="btn sm primary" id="auth-setup">Set SVN password</button>`;
    $('#auth-setup', el).onclick = () => openMasterSetupModal().then(ok => { if (ok) { loadAuth().then(renderAuthArea); } });
    return;
  }

  const u = a.username || '?';
  const initial = u.trim().charAt(0).toUpperCase();

  if (a.unlocked) {
    el.innerHTML = `
      <span class="user-chip" title="Unlocked — SVN credential available this session">
        <span class="avatar">${esc(initial)}</span>
        <span class="uname">${esc(u)}</span>
      </span>
      <button class="btn sm ghost" id="auth-change">Change…</button>
      <button class="btn sm ghost danger" id="auth-lock">Lock</button>`;
    $('#auth-change', el).onclick = () => openMasterChangeModal();
    $('#auth-lock', el).onclick = doLock;
  } else {
    el.innerHTML = `
      <span class="user-chip muted locked" title="Locked — unlock to commit">
        <span class="avatar">${esc(initial)}</span>
        <span class="uname">${esc(u)}</span>
        <span class="lock-badge">${icon('lock')}</span>
      </span>
      <button class="btn sm primary" id="auth-unlock">Unlock</button>`;
    $('#auth-unlock', el).onclick = () =>
      openMasterUnlockModal().then(ok => { if (ok) { loadAuth().then(renderAuthArea); } });
  }
}

// A small password-form modal. fields: [{id, label, type, placeholder}]. onSubmit(values)
// returns the success toast text (or throws to show an error and keep the modal open).
// Resolves true if the action completed, false if cancelled.
function passwordModal({ title, intro, fields, submitLabel, onSubmit }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="mpath">${intro}</div>
        ${fields.map(f => `
          <div class="section-label"${f.gap ? ' style="margin-top:12px"' : ''}>${esc(f.label)}</div>
          <input type="${f.type || 'password'}" id="${f.id}" autocomplete="off" placeholder="${esc(f.placeholder || '')}">
        `).join('')}
        <div class="macts">
          <button class="btn" id="pm-cancel">Cancel</button>
          <button class="btn primary" id="pm-ok">${esc(submitLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inputs = fields.map(f => $('#' + f.id, overlay));
    inputs[0].focus();

    let done = false;
    const finish = v => { if (done) return; done = true; overlay.remove(); resolve(v); };
    $('#pm-cancel', overlay).onclick = () => finish(false);
    overlay.onclick = e => { if (e.target === overlay) finish(false); };

    const submit = async () => {
      const values = {};
      fields.forEach((f, i) => values[f.id] = inputs[i].value);
      const btn = $('#pm-ok', overlay);
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = 'Working…';
      try {
        const msg = await onSubmit(values);
        if (msg) toast(msg, 'ok');
        finish(true);
      } catch (err) {
        btn.disabled = false; btn.textContent = prev;
        toast(err.message, 'err');
      }
    };
    $('#pm-ok', overlay).onclick = submit;
    inputs.forEach((inp, i) => inp.onkeydown = e => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') { (i < inputs.length - 1) ? inputs[i + 1].focus() : submit(); }
    });
  });
}

function openMasterUnlockModal() {
  return passwordModal({
    title: 'Unlock SVN credentials',
    intro: 'Enter your master password to unlock the stored SVN password for this browser session. ' +
           'You can skip this — committing will ask again.',
    fields: [{ id: 'masterPassword', label: 'Master password', placeholder: 'master password' }],
    submitLabel: 'Unlock',
    onSubmit: async ({ masterPassword }) => {
      if (!masterPassword) throw new Error('Master password is required');
      const data = await api('master_unlock', { masterPassword });
      setMasterSession({ token: data.token, key: data.key });
      return 'Unlocked';
    },
  });
}

function openMasterSetupModal() {
  return passwordModal({
    title: 'Set up SVN credentials',
    intro: 'Choose a master password and enter your SVN login. The SVN password is encrypted with the ' +
           'master password and stored on this server; the master password itself is never stored.',
    fields: [
      { id: 'masterPassword', label: 'Master password', placeholder: 'choose a master password' },
      { id: 'masterConfirm',  label: 'Confirm master password', placeholder: 'repeat master password', gap: true },
      { id: 'username', label: 'SVN username', type: 'text', placeholder: 'svn username', gap: true },
      { id: 'password', label: 'SVN password', placeholder: 'svn password', gap: true },
    ],
    submitLabel: 'Save & unlock',
    onSubmit: async ({ masterPassword, masterConfirm, username, password }) => {
      if (!masterPassword) throw new Error('Master password is required');
      if (masterPassword !== masterConfirm) throw new Error('Master passwords do not match');
      if (!username.trim()) throw new Error('SVN username is required');
      if (!password) throw new Error('SVN password is required');
      await api('master_setup', { masterPassword, username, password });   // validates against the repo
      const u = await api('master_unlock', { masterPassword });            // start a session right away
      setMasterSession({ token: u.token, key: u.key });
      return 'SVN credentials saved and unlocked';
    },
  });
}

function openMasterChangeModal() {
  return passwordModal({
    title: 'Change master password',
    intro: 'Re-encrypts the stored SVN password under a new master password. This signs out any other ' +
           'unlocked sessions.',
    fields: [
      { id: 'oldPassword', label: 'Current master password', placeholder: 'current master password' },
      { id: 'newPassword', label: 'New master password', placeholder: 'new master password', gap: true },
      { id: 'newConfirm',  label: 'Confirm new master password', placeholder: 'repeat new master password', gap: true },
    ],
    submitLabel: 'Change',
    onSubmit: async ({ oldPassword, newPassword, newConfirm }) => {
      if (!newPassword) throw new Error('New master password is required');
      if (newPassword !== newConfirm) throw new Error('New master passwords do not match');
      await api('master_change', { oldPassword, newPassword });
      const u = await api('master_unlock', { masterPassword: newPassword });   // re-establish our session
      setMasterSession({ token: u.token, key: u.key });
      await loadAuth(); renderAuthArea();
      return 'Master password changed';
    },
  });
}

async function doLock() {
  const sess = masterSession();
  try { await api('master_lock', sess ? { mtoken: sess.token } : {}); } catch {}
  setMasterSession(null);
  await loadAuth();
  renderAuthArea();
  toast('Locked', 'ok');
}

// ---------------------------------------------------------------- settings

async function openSettingsModal() {
  let data;
  try { data = await api('settings_get'); }
  catch (err) { return toast(err.message, 'err'); }

  const modeText = data.launchMode === 'direct'
    ? `Direct — desktop tools launch straight into your session (served via <code>${esc(data.sapi)}</code>).`
    : `Queue — served by Apache as a service, so desktop tools route through the Windows helper task. ` +
      `Tip: launch with <b>run.cmd</b> for direct launching with no helper task.`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal settings-dlg">
      <h3>${icon('settings')} Settings</h3>
      <div class="mpath">Host: ${esc(data.os)} · launch mode: <b>${esc(data.launchMode)}</b></div>

      <div class="section-label">External diff tool</div>
      <p class="set-help">Command run for <b>Diff…</b> / double-click. Placeholders:
        <code>{path}</code> (working-copy path, for self-diffing tools like TortoiseSVN),
        or <code>{base}</code> &amp; <code>{working}</code> (two files to compare).</p>
      <input type="text" id="set-diff" spellcheck="false"
             placeholder="${esc(data.defaults.diff || 'e.g. code --wait --diff {base} {working}')}"
             value="${esc(data.tools.diff || '')}">
      <div class="set-row">
        <button class="btn sm ghost" id="set-detect">Use detected default</button>
        <span class="set-detected">${data.defaults.diff
          ? 'Detected: <code>' + esc(data.defaults.diff) + '</code>'
          : 'No diff tool auto-detected on this machine.'}</span>
      </div>

      <div class="section-label">Desktop launch</div>
      <div class="dl-opts">
        <label class="dl-opt"><input type="radio" name="set-dl" value="auto" ${data.directLaunch === null ? 'checked' : ''}>
          <span class="dl-text"><b>Automatic</b> <em>direct when served by <code>php -S</code>, else the Windows helper task</em></span></label>
        <label class="dl-opt"><input type="radio" name="set-dl" value="true" ${data.directLaunch === true ? 'checked' : ''}>
          <span class="dl-text"><b>Always launch directly</b> <em>use when Apache runs in your own session</em></span></label>
        <label class="dl-opt"><input type="radio" name="set-dl" value="false" ${data.directLaunch === false ? 'checked' : ''}>
          <span class="dl-text"><b>Always use the Windows helper task</b> <em>Apache-as-a-service</em></span></label>
      </div>

      <p class="set-help">${modeText}</p>

      <div class="section-label danger">Danger zone</div>
      <p class="set-help">Delete the stored SVN credential, the master-password verifier, the
        device key, and all unlock sessions. Use this if you've forgotten the master password —
        you'll set it up again from scratch. This can't be undone.</p>
      <button class="btn sm ghost danger" id="set-reset">Delete stored SVN credentials</button>

      <div class="macts">
        <button class="btn" id="set-cancel">Cancel</button>
        <button class="btn primary" id="set-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#set-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  $('#set-detect', overlay).onclick = () => { $('#set-diff', overlay).value = data.defaults.diff || ''; };

  $('#set-reset', overlay).onclick = async () => {
    if (!confirm('Delete ALL stored SVN credential data?\n\n' +
                 'This removes the encrypted SVN password, the master-password verifier, the ' +
                 'device key, and any active unlock sessions. You will need to set up the SVN ' +
                 'password again. This cannot be undone.')) return;
    const btn = $('#set-reset', overlay);
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      const r = await api('master_reset');
      setMasterSession(null);
      await loadAuth();
      renderAuthArea();
      close();
      const what = (r.removed && r.removed.length) ? r.removed.join(', ') : 'nothing to delete';
      toast('Deleted: ' + what, 'ok');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Delete stored SVN credentials';
      toast(err.message, 'err');
    }
  };

  $('#set-save', overlay).onclick = async () => {
    const btn = $('#set-save', overlay);
    const dl = (overlay.querySelector('input[name="set-dl"]:checked') || {}).value || 'auto';
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('settings_save', {
        tools: { diff: $('#set-diff', overlay).value.trim() },
        directLaunch: dl === 'auto' ? null : dl,
      });
      toast('Settings saved', 'ok');
      close();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(err.message, 'err');
    }
  };
}

// ------------------------------------------------------------- project view

async function openProject(id) {
  // Stop dashboard update checks from competing with the project view's requests:
  // drop everything still queued, and forget this project's cached result — its
  // pending count is about to change while we work in it.
  dropQueuedUpdateChecks();
  updCheckCache.delete(id);
  state.view = 'project';
  state.project = state.projects.find(p => p.id === id) || null;
  state.files = [];
  state.dirs = [];            // cleared so a stale tree from another project never flashes
  state.selectedDir = '';
  state.expandedDirs = new Set(['']);
  state.selPath = null;
  state.diff = null;
  state.loading = true;
  location.hash = 'p=' + id;
  render();
  await refreshStatus();
}

async function refreshStatus() {
  state.loading = true;
  renderStats();
  renderCommitBar();   // reflect the loading lock immediately
  try {
    const data = await api('status', { id: state.project.id, includeIgnored: state.showIgnored, includeUnmodified: state.showUnmodified });
    state.project = data.project;
    state.rootRevision = data.rootRevision ?? null;
    state.files = data.files;
    state.eol.clear();   // EOL is lazy per-file; stale after a refresh
    state.commitStats = data.commitStats ?? null;
    if (state.selPath && !state.files.some(f => f.path === state.selPath)) {
      state.selPath = null; state.diff = null;
    }
    // Drop selections for files that are no longer pending.
    const live = new Set(state.files.map(f => f.path));
    for (const p of [...state.selPaths]) if (!live.has(p)) state.selPaths.delete(p);
    if (state.selAnchor && !live.has(state.selAnchor)) state.selAnchor = null;
  } catch (err) {
    toast(err.message, 'err');
    state.files = [];
  }
  state.loading = false;
  render();
  // Re-pull the diff for the file that's still open so the panel reflects the
  // current working copy (e.g. after an external edit or an svn operation).
  if (state.selPath && state.files.some(f => f.path === state.selPath)) loadDiff(state.selPath);
  loadDirs();   // fetch the full directory tree separately so it never blocks this render
}

// Load every working-copy directory (for change-free folders in the tree) out of
// band — its full-tree scan is too slow to sit in the status round-trip. The tree
// already renders from pending files immediately; this fills in the rest when it
// arrives. A token guards against a stale response applying after the user has
// switched projects or toggled show-ignored (which kicks off a newer load).
let dirsToken = 0;
async function loadDirs() {
  const token = ++dirsToken;
  const projectId = state.project?.id;
  const includeIgnored = state.showIgnored;
  if (!projectId) return;
  try {
    const data = await api('dirs', { id: projectId, includeIgnored });
    if (token !== dirsToken || state.project?.id !== projectId) return;   // superseded
    state.dirs = data.dirs ?? [];
    renderTree();
  } catch { /* tree still works from the pending-file dirs */ }
}

// Directory tree built from every working-copy directory (so change-free folders
// show too), with pending-change counts layered on from the file list.
function buildTree() {
  const counts = new Map(); // dir -> pending count (recursive)
  const revs = new Map();   // dir -> Set of base revisions of files beneath it
  const addRev = (dir, rev) => {
    if (rev == null) return;
    if (!revs.has(dir)) revs.set(dir, new Set());
    revs.get(dir).add(rev);
  };
  // Seed every directory (and its ancestors) at count 0 so the full tree renders
  // even where nothing is pending. File counts below are added on top.
  counts.set('', counts.get('') || 0);
  for (const d of state.dirs) {
    let acc = '';
    for (const part of d.split('/')) {
      acc = acc ? acc + '/' + part : part;
      if (!counts.has(acc)) counts.set(acc, 0);
    }
  }
  for (const f of state.files) {
    let dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (f.isDir) dir = f.path; // a pending dir counts as its own node
    counts.set('', (counts.get('') || 0) + 1);
    addRev('', f.revision);
    let acc = '';
    if (dir) for (const part of dir.split('/')) {
      acc = acc ? acc + '/' + part : part;
      counts.set(acc, (counts.get(acc) || 0) + 1);
      addRev(acc, f.revision);
    }
  }
  // children map
  const children = new Map();
  for (const dir of counts.keys()) {
    if (dir === '') continue;
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(dir);
  }
  for (const kids of children.values()) kids.sort();
  return { counts, children, revs };
}

// Revision a tree node should display: the root node always shows the root
// revision; a child dir shows a revision only when everything beneath it sits at
// a single revision that differs from root (i.e. that subtree was updated apart).
function nodeRevision(dir, revs) {
  if (dir === '') return state.rootRevision;
  const set = revs.get(dir);
  if (!set || set.size !== 1) return null;
  const rev = [...set][0];
  return rev !== state.rootRevision ? rev : null;
}

// Compile the filter box into a path matcher. With no `*`/`?` it's a plain
// case-insensitive substring match (unchanged); with wildcards it's an anchored
// glob where `*` matches any run of characters (including `/`) and `?` one char.
function compileSearch(term) {
  term = term.trim();
  if (!term) return null;
  if (/[*?]/.test(term)) {
    const re = '^' + term.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try { const rx = new RegExp(re, 'i'); return p => rx.test(p); } catch { /* fall through */ }
  }
  const low = term.toLowerCase();
  return p => p.toLowerCase().includes(low);
}

function filteredFiles() {
  const dir = state.selectedDir;
  const prefix = dir ? dir + '/' : '';
  const match = compileSearch(state.search);
  const sf = state.statusFilter;
  const rf = state.reviewFilter;
  const kf = state.kindFilter;
  return state.files.filter(f => {
    if (dir && f.path !== dir && !f.path.startsWith(prefix)) return false;
    if (sf.size && !sf.has(f.status)) return false;
    if (rf === 'approved' && f.review !== 'approved') return false;
    if (rf === 'unapproved' && f.review === 'approved') return false;
    if (kf === 'files' && f.isDir) return false;
    if (kf === 'folders' && !f.isDir) return false;
    if (match && !match(f.path)) return false;
    return true;
  });
}

function relTo(path) {
  const dir = state.selectedDir;
  if (!dir) return path;
  if (path === dir) return '.';
  return path.slice(dir.length + 1);
}

// name / directory of a path relative to the selected dir (what the list shows)
function relName(f) { const r = relTo(f.path), i = r.lastIndexOf('/'); return i >= 0 ? r.slice(i + 1) : r; }
function relDir(f)  { const r = relTo(f.path), i = r.lastIndexOf('/'); return i >= 0 ? r.slice(0, i) : ''; }

function fmtMtime(t) {
  if (!t) return '';
  const d = new Date(t * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Sort the filtered list by the active key chain (primary, then secondary);
// empty chain = server (path) order. Path is always the final tie-break.
const SORT_CMP = {
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  name:   (a, b) => relName(a).localeCompare(relName(b)),
  dir:    (a, b) => relDir(a).localeCompare(relDir(b)),
  mtime:  (a, b) => (a.mtime || 0) - (b.mtime || 0),
  review: (a, b) => reviewRank(a) - reviewRank(b),
};
function reviewRank(f) { return f.review === 'approved' ? 0 : f.review === 'rejected' ? 1 : 2; }

function sortFiles(list) {
  const chain = state.sort.filter(s => SORT_CMP[s.k]);
  if (!chain.length) return list;
  return list.sort((a, b) => {
    for (const { k, d } of chain) {
      const c = d * SORT_CMP[k](a, b);
      if (c) return c;
    }
    return a.path.localeCompare(b.path);
  });
}

// Small, unlabeled "performance" bar: the signed-in user's share of the last 50
// commits. Fill width = percent; colour interpolates red (0%) → green at a
// 1/divisor share. The divisor comes from data/config.json's
// work_performance_divisor — when it's unset or <=1 the bar isn't shown at all.
function perfBarHtml() {
  const s = state.commitStats;
  const divisor = s && Number(s.divisor) > 1 ? Number(s.divisor) : 0;
  if (!divisor) return '';                      // not configured (unset / 1) → hide the bar
  const threshold = 100 / divisor;             // commit-share % that counts as "full" (green)
  if (!s || s.percent == null) {
    const why = state.auth && !state.auth.username ? ' (set up SVN credentials to track)' : '';
    return `<div class="perfbar empty" title="Commit share unavailable${why}"><span style="width:0"></span></div>`;
  }
  const pct = Math.max(0, Math.min(100, s.percent));
  const t = Math.min(pct, threshold) / threshold;   // 0% → red … threshold+ → green
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  const color = `rgb(${lerp(242, 52)},${lerp(100, 199)},${lerp(100, 124)})`;
  const title = `You authored ${s.mine} of the last ${s.total} commits (${pct}%)`;
  return `<div class="perfbar" title="${esc(title)}"><span style="width:${pct}%;background:${color}"></span></div>`;
}

function renderProject(app) {
  // The rebuild below replaces the #file-list scroll container, which would reset
  // scrollTop to 0. Capture it first so a refresh (e.g. after a file action)
  // doesn't yank the user back to the top.
  const prevScroll = $('#file-list')?.scrollTop ?? 0;
  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" id="go-back" title="Back to projects" aria-label="Back to projects">‹</button>
      <div class="logo" id="go-home">${LOGO_MARK}<span>Bixi</span></div>
      <div class="crumb">/ <b>${esc(state.project.name)}</b></div>
      <span class="wc-path">${esc(state.project.path)}</span>
      <div class="spacer"></div>
      ${perfBarHtml()}
      <button class="btn sm" id="btn-merge" title="Merge changes from another branch">${icon('merge')} Merge…</button>
      <button class="btn sm" id="btn-update" title="Update working copy from SVN (svn update)">${icon('update')} Update</button>
      <button class="btn sm" id="btn-history" title="Show revision history for this working copy">${icon('history')} History</button>
      <button class="btn sm" id="btn-refresh">↻ Refresh</button>
      <button class="btn sm ghost" id="settings-btn" title="Settings">${icon('settings')}</button>
      <div class="auth-area" id="auth-area"></div>
    </div>
    <div class="project-view">
      <div class="work-area">
        <div class="dir-tree" id="dir-tree"></div>
        <div class="file-pane">
          <div class="file-toolbar" id="file-toolbar"></div>
          <div class="file-head" id="file-head"></div>
          <div class="file-list" id="file-list" tabindex="0">
            <div class="spacer" id="vspacer"></div>
            <div id="vrows"></div>
          </div>
        </div>
      </div>
      <div class="review-panel" id="review-panel" style="display:none"></div>
      <div class="commit-bar" id="commit-bar"></div>
    </div>`;

  const goHome = () => { state.project = null; navigate('dashboard'); };
  $('#go-home', app).onclick = goHome;
  $('#go-back', app).onclick = goHome;
  $('#btn-merge', app).onclick = () => openMergeModal();
  $('#btn-update', app).onclick = () => svnUpdate('', state.project.name);
  $('#btn-history', app).onclick = () => openHistory('');
  $('#btn-refresh', app).onclick = () => refreshStatus();
  $('#settings-btn', app).onclick = openSettingsModal;

  renderAuthArea();
  renderTree();
  renderToolbar();
  renderFileHead();
  initVirtualList();
  // Restore the pre-rebuild scroll position. refreshList() (via initVirtualList)
  // has already sized #vspacer, so the container can accept the offset; the browser
  // clamps it if the list got shorter. Re-window the rows at the restored position.
  const fl = $('#file-list');
  if (fl && prevScroll) { fl.scrollTop = prevScroll; renderVisibleRows(true); }
  renderCommitBar();
  renderPanel();

  // Document-level so nav keys keep working after focus leaves the file list
  // (e.g. clicking the review panel's Prev/Next/Approve buttons). Named handler
  // => addEventListener dedupes across re-renders.
  document.addEventListener('keydown', onKeydown);
}

// ----------------------------------------------------------- context menu

let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  document.removeEventListener('mousedown', closeCtxMenu);
  document.removeEventListener('scroll', closeCtxMenu, true);
}

// Build a menu element from items: [{label, icon?, danger?, onClick?, submenu?:[…]}]
function buildMenu(items) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.separator) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.submenu ? ' has-sub' : '');
    if (it.icon) el.dataset.icon = it.icon;
    el.innerHTML = icon(it.icon) + `<span>${esc(it.label)}</span>` + (it.submenu ? '<span class="ctx-arrow">▸</span>' : '');
    if (it.submenu) {
      const sub = buildMenu(it.submenu);
      sub.classList.add('ctx-submenu');
      el.appendChild(sub);
      // Flip the flyout to the left edge if it would run past the viewport.
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

  menu.onmousedown = e => e.stopPropagation(); // don't trigger the close-on-outside listener
  ctxMenuEl = menu;
  // defer so the originating event doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('mousedown', closeCtxMenu);
    document.addEventListener('scroll', closeCtxMenu, true);
  }, 0);
}

// Copy text to the clipboard (with a fallback for non-secure contexts).
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

// The Copy submenu: filename / repo-relative path / absolute path for a row.
function copyMenu(relPath) {
  const fileName = relPath === '' ? (state.project?.name || '') : relPath.split('/').pop();
  const fullPath = (state.project.path + (relPath ? '/' + relPath : '')).replace(/\//g, '\\');
  return {
    label: 'Copy', icon: 'copy', submenu: [
      { label: 'Copy Filename', onClick: () => copyText(fileName, 'filename') },
      { label: 'Copy Relative Path', onClick: () => copyText(relPath || '.', 'relative path') },
      { label: 'Copy Full Path', onClick: () => copyText(fullPath, 'full path') },
    ],
  };
}

function menuFor(relPath, label, isDir, status, opts = {}) {
  const inRepo = status !== 'unversioned' && status !== 'added' && status !== 'ignored';
  const onDisk = status !== 'deleted' && status !== 'missing'; // the file still exists
  const items = [];
  // Review verdict actions (file rows only) — same as the row's ✓ / ✕ / ↺ buttons.
  const rf = opts.review;
  if (rf) {
    items.push({ label: 'Approve', icon: 'add', onClick: () => setReview(rf, 'approved') });
    items.push({ label: 'Reject…', icon: 'delete', danger: true, onClick: () => openRejectModal(rf) });
    if (rf.review) items.push({ label: 'Clear review', icon: 'revert', onClick: () => setReview(rf, 'clear') });
    items.push({ separator: true });
  }
  // External (TortoiseSVN) diff — needs a committed base, so not for new items.
  if (inRepo) items.push({ label: 'Diff…', icon: 'diff', onClick: () => extDiff(relPath, label) });
  // Open with default program (files only) / reveal in Explorer (anything).
  if (!isDir && onDisk) items.push({ label: 'Open', icon: 'open', onClick: () => openPath(relPath, label) });
  items.push({ label: 'Open in Explorer', icon: 'explorer', onClick: () => revealInExplorer(relPath, label) });
  items.push(copyMenu(relPath));
  // Move into another folder (svn move for versioned items, disk move otherwise).
  // Not for the project root or items with no working file to relocate.
  const movable = relPath !== '' && status !== 'deleted' && status !== 'missing';
  if (movable && !opts.noDestructive) {
    items.push({ label: 'Move To…', icon: 'move',
      onClick: () => openMoveModal([{ path: relPath, label, isDir, status }]) });
  }
  // Line endings: scan one file, or a directory's children recursively.
  if (isDir || onDisk) items.push({ label: 'Line Endings…', icon: 'eol', onClick: () => openEolModal(relPath, label, isDir) });
  items.push({ label: 'Update', icon: 'update', onClick: () => svnUpdate(relPath, label) });
  // Adding a folder offers a recursive / this-folder-only choice; a file is added directly.
  if (status === 'unversioned') {
    if (isDir) items.push({ label: 'Add…', icon: 'add', onClick: () => openAddFolderModal(relPath, label) });
    else items.push({ label: 'Add', icon: 'add', onClick: () => svnAdd(relPath, label) });
  }

  // Ignore / Unignore via svn:ignore. Directories edit their own rule list; an
  // unversioned file is ignored by name; an already-ignored file is unignored.
  if (isDir) items.push({ label: 'Ignore…', icon: 'hide', onClick: () => openIgnoreModal(relPath, label) });
  else if (status === 'ignored') items.push({ label: 'Unignore', icon: 'unhide', onClick: () => svnUnhide(relPath, label) });
  else if (status === 'unversioned') items.push({ label: 'Ignore', icon: 'hide', onClick: () => svnHide(relPath, label) });

  // SVN properties editor (curated well-known props). Only for versioned items
  // that still exist on disk — unversioned/ignored/deleted items can't carry props.
  const versioned = status !== 'unversioned' && status !== 'ignored';
  if (versioned && onDisk) items.push({ label: 'Properties…', icon: 'props', onClick: () => openPropsModal(relPath, label, isDir) });

  if (inRepo) items.push({ label: 'History…', icon: 'history', onClick: () => openHistory(relPath) });
  // Destructive actions are suppressed inside the commit picker dialog.
  if (!opts.noDestructive) {
    // For a scheduled add (status A), `svn revert` just un-schedules the add and
    // leaves the file on disk — so offer it as the clearer, non-destructive
    // "Undo Add…" rather than the generic (and misleading) "Revert…".
    if (status === 'added') items.push({ label: 'Undo Add…', icon: 'revert', onClick: () => confirmRemoveAdd(relPath, label, isDir) });
    else if (status !== 'ignored') items.push({ label: 'Revert…', icon: 'revert', danger: true, onClick: () => confirmRevert(relPath, label, isDir) });
    if (relPath !== '') items.push({ label: 'Delete…', icon: 'delete', danger: true, onClick: () => confirmDelete(relPath, label, isDir, status) });
  }
  // Merge another branch into this folder (versioned dirs; preselects the target).
  if (isDir && versioned && !opts.noDestructive) {
    items.push({ label: 'Merge into this folder…', icon: 'merge', onClick: () => openMergeModal(relPath, label) });
  }
  if (isDir) items.push({ label: 'SVN Cleanup…', icon: 'cleanup', onClick: () => openCleanupModal(relPath, label) });
  return items;
}

// ------------------------------------------------------ batch (multi-select)

// Context menu for a multi-selection: review verdicts + batch SVN operations.
function batchMenuFor(paths) {
  const files = paths.map(p => state.files.find(x => x.path === p)).filter(Boolean);
  const n = files.length;
  const unversioned = files.filter(f => f.status === 'unversioned');
  const added = files.filter(f => f.status === 'added');
  // Reverting an added item only undoes the scheduled add (see confirmRemoveAdd),
  // so it gets its own "Undo Add" entry below; keep it out of the destructive Revert.
  const revertable = files.filter(f => f.status !== 'unversioned' && f.status !== 'ignored' && f.status !== 'added');
  const items = [];
  items.push({ label: `Approve ${n}`, icon: 'add', onClick: () => batchReview(files, 'approved') });
  items.push({ label: `Reject ${n}…`, icon: 'delete', danger: true, onClick: () => openBatchRejectModal(files) });
  items.push({ label: `Clear review (${n})`, icon: 'revert', onClick: () => batchReview(files, 'clear') });
  items.push({ separator: true });
  if (unversioned.length) items.push({ label: `Add ${unversioned.length} to SVN`, icon: 'add', onClick: () => batchAdd(unversioned) });
  const movable = files.filter(f => f.status !== 'deleted' && f.status !== 'missing');
  if (movable.length) items.push({ label: `Move ${movable.length}…`, icon: 'move',
    onClick: () => openMoveModal(movable.map(f => ({ path: f.path, label: f.path.split('/').pop(), isDir: f.isDir, status: f.status }))) });
  items.push({ label: `Update ${n}`, icon: 'update', onClick: () => batchUpdate(files) });
  items.push({ label: 'Line Endings…', icon: 'eol', onClick: () => openEolModalMulti(paths) });
  items.push({ separator: true });
  if (added.length) items.push({ label: `Undo Add (${added.length})…`, icon: 'revert', onClick: () => confirmBatchRemoveAdd(added) });
  if (revertable.length) items.push({ label: `Revert ${revertable.length}…`, icon: 'revert', danger: true, onClick: () => confirmBatchRevert(revertable) });
  items.push({ label: `Delete ${n}…`, icon: 'delete', danger: true, onClick: () => confirmBatchDelete(files) });
  return items;
}

// Run an async op over each file sequentially, holding the row spinner + commit
// lock, then refresh once. `fn(file)` does the api call; failures are tallied.
async function runBatch(files, verb, fn) {
  if (!files.length) return;
  lockUI();
  let ok = 0; const failed = [];
  for (const f of files) {
    setPathBusy(f.path, true);
    try { await fn(f); ok++; }
    catch { failed.push(f.path); }
    finally { setPathBusy(f.path, false); }
  }
  unlockUI();
  state.selPath = null; state.diff = null;
  await refreshStatus();
  if (failed.length) toast(`${verb} ${ok} file(s); ${failed.length} failed:\n${failed.join('\n')}`, 'err');
  else toast(`${verb} ${ok} file(s).`, 'ok');
}

// Batch-save the same review verdict across the selection (no SVN side effects).
async function batchReview(files, verdict, notes = '') {
  lockUI();
  let ok = 0; const failed = [];
  for (const f of files) {
    try {
      await api('review', { id: state.project.id, path: f.path, verdict, notes, svnStatus: f.status });
      f.review = verdict === 'clear' ? null : verdict;
      f.notes = verdict === 'rejected' ? notes : null;
      ok++;
    } catch { failed.push(f.path); }
  }
  unlockUI();
  renderVisibleRows(true);
  renderCommitBar();
  const verb = verdict === 'clear' ? 'Cleared' : verdict === 'approved' ? 'Approved' : 'Rejected';
  if (failed.length) toast(`${verb} ${ok}; ${failed.length} failed.`, 'err');
  else toast(`${verb} ${ok} file(s).`, 'ok');
}

function openBatchRejectModal(files) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Reject ${files.length} file(s)</h3>
      <div class="mpath">${esc(files.length)} selected file(s) will share these rejection notes.</div>
      <div class="section-label">Notes (optional)</div>
      <textarea id="brej-notes" placeholder="What needs to change before these can be approved?"></textarea>
      <div class="macts">
        <button class="btn" id="brej-cancel">Cancel</button>
        <button class="btn danger" id="brej-save">Reject ${files.length}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = $('#brej-notes', overlay);
  ta.focus();
  const close = () => overlay.remove();
  $('#brej-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  $('#brej-save', overlay).onclick = async () => {
    const notes = ta.value.trim();
    await batchReview(files, 'rejected', notes);
    close();
  };
  ta.onkeydown = e => { if (e.key === 'Escape') close(); };
}

function batchAdd(files) {
  runBatch(files, 'Added', f => api('add', { id: state.project.id, path: f.path }));
}

function batchUpdate(files) {
  runBatch(files, 'Updated', f => api('update', { id: state.project.id, path: f.path }));
}

// Expand a multi-selection into the concrete files an EOL scan should consider
// (each directory fans out to its pending children), then open the EOL dialog.
function openEolModalMulti(paths) {
  const cands = [...new Set(paths.flatMap(p => {
    const f = state.files.find(x => x.path === p);
    return f ? eolCandidates(p, f.isDir) : [p];
  }))];
  openEolModalCore(cands, `${paths.length} selected item(s)`, '');
}

function confirmBatchRevert(files) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Revert ${files.length} item(s)?</h3>
      <div class="mpath">${esc(files.length)} selected item(s)</div>
      <p class="warn-text">This discards all local changes to the selected item(s) and cannot be undone.
      (Unversioned files are left in place.)</p>
      <div class="macts">
        <button class="btn" id="brv-cancel">Cancel</button>
        <button class="btn danger" id="brv-confirm">Revert ${files.length}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#brv-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#brv-confirm', overlay).onclick = () => {
    close();
    runBatch(files, 'Reverted', f => api('revert', { id: state.project.id, path: f.path }));
  };
}

// Batch "Undo Add": un-schedules the add on each selected A item (svn revert),
// leaving them on disk as unversioned. Non-destructive, so worded gently.
function confirmBatchRemoveAdd(files) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Undo add of ${files.length} item(s)?</h3>
      <div class="mpath">${esc(files.length)} selected item(s)</div>
      <p class="warn-text">This un-schedules the selected item(s) from being added to SVN.
      They stay on disk as unversioned items — nothing is deleted.</p>
      <div class="macts">
        <button class="btn" id="bua-cancel">Cancel</button>
        <button class="btn primary" id="bua-confirm">Undo Add</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#bua-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#bua-confirm', overlay).onclick = () => {
    close();
    runBatch(files, 'Undid add of', f => api('revert', { id: state.project.id, path: f.path }));
  };
}

function confirmBatchDelete(files) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Delete ${files.length} item(s)?</h3>
      <div class="mpath">${esc(files.length)} selected item(s)</div>
      <p class="warn-text">Versioned items are scheduled for deletion in SVN (commit to make permanent);
      unversioned items are removed from disk.</p>
      <p class="warn-text"><b>Move To Trash</b> sends recoverable copies to the Windows Recycle Bin.
        <b>Delete Forever</b> cannot be undone.</p>
      <div class="macts">
        <button class="btn" id="bdel-cancel">Cancel</button>
        <button class="btn" id="bdel-trash">Move To Trash</button>
        <button class="btn danger" id="bdel-forever">Delete Forever</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#bdel-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  const run = mode => {
    close();
    runBatch(files, 'Deleted', f => api('delete', { id: state.project.id, path: f.path, mode, status: f.status }));
  };
  $('#bdel-trash', overlay).onclick = () => run('trash');
  $('#bdel-forever', overlay).onclick = () => run('forever');
}

function openHistory(relPath, projId = state.project.id) {
  const url = 'history.php?id=' + encodeURIComponent(projId)
            + '&path=' + encodeURIComponent(relPath);
  window.open(url, '', 'width=1050,height=780,resizable=yes,scrollbars=yes');
}

async function extDiff(relPath, label) {
  try {
    await api('extdiff', { id: state.project.id, path: relPath });
    toast(`Opening diff for ${label} in TortoiseSVN…`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function openPath(relPath, label) {
  try {
    await api('open_path', { id: state.project.id, path: relPath });
    toast(`Opening ${label}…`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function revealInExplorer(relPath, label) {
  try {
    await api('reveal', { id: state.project.id, path: relPath });
    toast(`Showing ${label} in Explorer…`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function svnUpdate(relPath, label) {
  await runFileOp(relPath, async () => {
    try {
      const data = await api('update', { id: state.project.id, path: relPath });
      toast(`${label}\n${data.output}`, 'ok');
      state.selPath = null; state.diff = null;
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function svnAdd(relPath, label, recursive = true) {
  await runFileOp(relPath, async () => {
    try {
      const data = await api('add', { id: state.project.id, path: relPath, recursive });
      toast(`Added ${label}\n${data.output}`, 'ok');
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// Adding an unversioned folder: let the user choose between adding the whole
// subtree (svn's default) and adding just the folder node (--depth=empty), since
// the contents may include files they don't want versioned yet.
function openAddFolderModal(relPath, label) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Add folder to SVN</h3>
      <div class="mpath">${esc(relPath)}</div>
      <p class="warn-text"><b>Add Recursively</b> schedules <b>${esc(label)}</b> and everything
        inside it. <b>This Folder Only</b> adds just the folder node — its contents stay
        unversioned until you add them yourself.</p>
      <div class="macts">
        <button class="btn" id="af-cancel">Cancel</button>
        <button class="btn" id="af-empty">This Folder Only</button>
        <button class="btn primary" id="af-recursive">Add Recursively</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#af-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#af-empty', overlay).onclick = () => { close(); svnAdd(relPath, label, false); };
  $('#af-recursive', overlay).onclick = () => { close(); svnAdd(relPath, label, true); };
}

async function svnHide(relPath, label) {
  await runFileOp(relPath, async () => {
    try {
      await api('hide', { id: state.project.id, path: relPath });
      toast(`Now ignoring ${label} — added to the folder's svn:ignore (commit to apply).`, 'ok');
      if (state.selPath === relPath) { state.selPath = null; state.diff = null; }
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function svnUnhide(relPath, label) {
  await runFileOp(relPath, async () => {
    try {
      const data = await api('unhide', { id: state.project.id, path: relPath });
      // Glob match: removing the pattern un-ignores everything else it covered, so confirm.
      if (data.confirm) return confirmUnhideGlob(relPath, label, data.patterns);
      toast(`No longer ignoring ${label} — removed from the folder's svn:ignore.`, 'ok');
      await refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// A file matched by a glob (e.g. *.log) can only be un-ignored by dropping the
// matching pattern, which also un-ignores its siblings — so spell that out first.
function confirmUnhideGlob(relPath, label, patterns) {
  const pats = patterns.map(p => `<code>${esc(p)}</code>`).join(', ');
  const plural = patterns.length > 1 ? 'these patterns' : 'this pattern';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Remove ignore pattern?</h3>
      <div class="mpath">${esc(relPath)}</div>
      <p class="warn-text"><b>${esc(label)}</b> isn't ignored by name — it's matched by ${pats}.
      Unignoring it removes ${plural} from the folder's <code>svn:ignore</code>, which will also
      stop ignoring any other items the pattern covered. (A pending change you then commit.)</p>
      <div class="macts">
        <button class="btn" id="ug-cancel">Cancel</button>
        <button class="btn primary" id="ug-confirm">Remove pattern</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#ug-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#ug-confirm', overlay).onclick = async () => {
    const btn = $('#ug-confirm', overlay);
    btn.disabled = true; btn.textContent = 'Removing…';
    try {
      await api('unhide', { id: state.project.id, path: relPath, remove: patterns });
      toast(`No longer ignoring ${label} — removed ${patterns.join(', ')} from svn:ignore.`, 'ok');
      close();
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Remove pattern';
      toast(err.message, 'err');
    }
  };
}

// Directory svn:ignore rule editor (one pattern per line).
async function openIgnoreModal(relPath, label) {
  let value = '';
  try {
    const data = await api('get_ignore', { id: state.project.id, path: relPath });
    value = data.value || '';
  } catch (err) { return toast(err.message, 'err'); }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Ignored items (svn:ignore)</h3>
      <div class="mpath">${esc(relPath || state.project.name)}</div>
      <p class="warn-text">One pattern per line — names or globs like <code>*.log</code>, <code>tmp</code>,
        <code>node_modules</code>. Sets this folder's <code>svn:ignore</code> property (a pending change you
        then commit). Only ignores <em>unversioned</em> items.</p>
      <textarea id="ign-val" class="ign-text" spellcheck="false" placeholder="*.log&#10;tmp&#10;build">${esc(value)}</textarea>
      <div class="macts">
        <button class="btn" id="ign-cancel">Cancel</button>
        <button class="btn primary" id="ign-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = $('#ign-val', overlay);
  ta.focus();
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#ign-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  $('#ign-save', overlay).onclick = async () => {
    const btn = $('#ign-save', overlay);
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('set_ignore', { id: state.project.id, path: relPath, value: ta.value });
      toast('svn:ignore updated (commit to apply).', 'ok');
      close();
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(err.message, 'err');
    }
  };
}

// SmartSVN-style properties editor for the curated well-known svn props. Shows
// only the fields that apply to the target (svn:ignore + executable gating), edits
// each property independently (custom props on the item are left alone), and can
// apply recursively to a directory's children. All edits are pending changes the
// user then commits.
const EOL_OPTS = [['', '(unset)'], ['native', 'native'], ['LF', 'LF'], ['CRLF', 'CRLF'], ['CR', 'CR']];
async function openPropsModal(relPath, label, isDir) {
  let p;
  try {
    const data = await api('props_get', { id: state.project.id, path: relPath });
    p = data.props;
  } catch (err) { return toast(err.message, 'err'); }

  const eolSel = EOL_OPTS.map(([v, t]) =>
    `<option value="${esc(v)}"${p['eol-style'] === v ? ' selected' : ''}>${esc(t)}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Properties</h3>
      <div class="mpath">${esc(relPath || state.project.name)}</div>
      <div class="prop-grid">
        <label for="pr-eol">svn:eol-style</label>
        <select id="pr-eol" class="prop-in">${eolSel}</select>
        <label for="pr-mime">svn:mime-type</label>
        <input id="pr-mime" class="prop-in" type="text" spellcheck="false"
               placeholder="text/plain, application/octet-stream…" value="${esc(p['mime-type'])}">
        <label for="pr-kw">svn:keywords</label>
        <input id="pr-kw" class="prop-in" type="text" spellcheck="false"
               placeholder="Id Author Date Revision HeadURL" value="${esc(p['keywords'])}">
        <span class="prop-lab">flags</span>
        <div class="prop-flags">
          ${!isDir ? `<label class="chk"><input type="checkbox" id="pr-exec"${p['executable'] ? ' checked' : ''}>
            <span>svn:executable</span></label>` : ''}
          <label class="chk"><input type="checkbox" id="pr-lock"${p['needs-lock'] ? ' checked' : ''}>
            <span>svn:needs-lock</span></label>
        </div>
        ${isDir ? `<label for="pr-ign">svn:ignore</label>
          <textarea id="pr-ign" class="ign-text" spellcheck="false"
            placeholder="*.log&#10;tmp&#10;build">${esc(p['ignore'])}</textarea>` : ''}
      </div>
      <div class="macts">
        <button class="btn" id="pr-cancel">Cancel</button>
        <button class="btn primary" id="pr-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pr-eol', overlay).focus();
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#pr-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  $('#pr-save', overlay).onclick = async () => {
    const btn = $('#pr-save', overlay);
    btn.disabled = true; btn.textContent = 'Saving…';
    const props = {
      'eol-style': $('#pr-eol', overlay).value,
      'mime-type': $('#pr-mime', overlay).value,
      'keywords':  $('#pr-kw', overlay).value,
      'needs-lock': $('#pr-lock', overlay).checked,
    };
    if (!isDir) props['executable'] = $('#pr-exec', overlay).checked;
    if (isDir)  props['ignore'] = $('#pr-ign', overlay).value;
    try {
      await api('props_save', { id: state.project.id, path: relPath, props });
      toast('Properties updated (commit to apply).', 'ok');
      close();
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast(err.message, 'err');
    }
  };
}

// The pending new/modified files (existing on disk) under a target: the file
// itself for a file target, or every such pending file beneath a directory.
function eolCandidates(relPath, isDir) {
  if (!isDir) return [relPath];
  const prefix = relPath === '' ? '' : relPath + '/';
  return state.files
    .filter(f => !f.isDir
      && f.status !== 'deleted' && f.status !== 'missing' && f.status !== 'ignored'
      && (relPath === '' || f.path.startsWith(prefix)))
    .map(f => f.path);
}

// Scan pending new/modified files (one file, or all under a directory) for mixed
// line endings. The dialog opens immediately in a loading state, then fills in.
function openEolModal(relPath, label, isDir) {
  openEolModalCore(eolCandidates(relPath, isDir), relPath || state.project.name, relPath);
}

// Core line-endings dialog over an explicit candidate file list. `mpathLabel` is
// the header subtitle; `base` scopes auto's svn:eol-style lookup ('' = root).
async function openEolModalCore(paths, mpathLabel, base) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal eol-modal">
      <h3>Line endings</h3>
      <div class="mpath">${esc(mpathLabel)}</div>
      <div id="eol-body">
        <p class="warn-text eol-loading">Checking ${paths.length.toLocaleString()} new/modified file(s)…</p>
      </div>
      <div class="macts" id="eol-acts"><button class="btn" id="eol-cancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(overlay);
  let cancelled = false;
  const close = () => { cancelled = true; overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  const bindCancel = () => overlay.querySelectorAll('[data-eol-cancel]').forEach(b => b.onclick = close);
  $('#eol-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  if (!paths.length) {
    $('#eol-body', overlay).innerHTML = `<p class="warn-text">No new/modified files to check here.</p>`;
    $('#eol-acts', overlay).innerHTML = `<button class="btn primary" data-eol-cancel>Close</button>`;
    bindCancel();
    return;
  }

  let data;
  try { data = await api('eol_scan', { id: state.project.id, paths }); }
  catch (err) { close(); return toast(err.message, 'err'); }
  if (cancelled) return;

  const body = $('#eol-body', overlay), acts = $('#eol-acts', overlay);
  const files = data.files || [];
  const scannedNote = `Checked ${data.scanned.toLocaleString()} new/modified file(s)`
    + (data.binary ? `, skipped ${data.binary} binary` : '')
    + (data.skipped ? `, skipped ${data.skipped} large/unreadable` : '');

  if (!files.length) {
    body.innerHTML = `<p class="warn-text"><b>✓ No mixed line endings found.</b><br>${scannedNote}.</p>`;
    acts.innerHTML = `<button class="btn primary" data-eol-cancel>Close</button>`;
    bindCancel();
    return;
  }

  const comp = f => [f.crlf ? `CRLF ${f.crlf}` : '', f.lf ? `LF ${f.lf}` : '', f.cr ? `CR ${f.cr}` : '']
    .filter(Boolean).join(' · ');
  body.innerHTML = `
    <p class="warn-text">${scannedNote}. <b>${files.length}</b> file(s) mix CRLF with LF/CR.
      Fixing rewrites the selected files (a working-copy change you then review &amp; commit).</p>
    <div class="section-label">Normalize to</div>
    <div class="eol-target">
      <label><input type="radio" name="eol" value="auto" checked> Auto</label>
      <label><input type="radio" name="eol" value="lf"> LF <span class="dim">(Unix)</span></label>
      <label><input type="radio" name="eol" value="crlf"> CRLF <span class="dim">(Windows)</span></label>
    </div>
    <p class="eol-hint"><b>Auto</b>: each file keeps its <code>svn:eol-style</code> if set, otherwise its majority style.</p>
    <div class="eol-list">
      ${files.map(f => `
        <label class="eol-row">
          <input type="checkbox" value="${esc(f.path)}" checked>
          <span class="eol-path">${esc(f.path)}</span>
          <span class="eol-comp">${esc(comp(f))}</span>
        </label>`).join('')}
    </div>`;
  acts.innerHTML = `
    <label class="eol-all"><input type="checkbox" id="eol-toggle" checked> Select all</label>
    <button class="btn" data-eol-cancel>Cancel</button>
    <button class="btn primary" id="eol-fix">Fix selected</button>`;
  bindCancel();

  const boxes = () => [...overlay.querySelectorAll('.eol-list input[type=checkbox]')];
  $('#eol-toggle', overlay).onclick = e => boxes().forEach(b => { b.checked = e.target.checked; });

  $('#eol-fix', overlay).onclick = async () => {
    const paths = boxes().filter(b => b.checked).map(b => b.value);
    if (!paths.length) return toast('No files selected', 'err');
    const style = overlay.querySelector('input[name=eol]:checked').value;
    const btn = $('#eol-fix', overlay);
    btn.disabled = true; btn.textContent = 'Fixing…';
    try {
      const res = await api('eol_fix', { id: state.project.id, paths, style, base });
      let msg = `Normalized ${res.fixed.length} file(s)` + (style === 'auto' ? '' : ` to ${style.toUpperCase()}`) + '.';
      if (res.failed.length) msg += ` ${res.failed.length} could not be fixed.`;
      toast(msg, res.failed.length ? 'err' : 'ok');
      close();
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Fix selected';
      toast(err.message, 'err');
    }
  };
}

function confirmDelete(relPath, label, isDir, status) {
  const versioned = status !== 'unversioned' && status !== 'ignored';
  const kind = isDir ? 'folder' : 'file';
  const scope = isDir ? `the folder <b>${esc(label)}</b> and everything under it` : `<b>${esc(label)}</b>`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Delete ${kind}?</h3>
      <div class="mpath">${esc(relPath)}</div>
      <p class="warn-text">${versioned
        ? `This schedules ${scope} for deletion in SVN (commit to make it permanent in the repository).`
        : `This removes ${scope} from disk.`}</p>
      <p class="warn-text">${versioned
        ? `<b>SVN Delete Only</b> schedules the deletion but keeps the ${kind} on disk (it becomes
           unversioned after you commit). <b>Move To Trash</b> sends a recoverable copy to the Windows
           Recycle Bin. <b>Delete Forever</b> cannot be undone.`
        : `<b>Move To Trash</b> sends a recoverable copy to the Windows Recycle Bin.
           <b>Delete Forever</b> cannot be undone.`}</p>
      <label class="chk"><input type="checkbox" id="del-ignore">
        <span>Also add <code>${esc(label)}</code> to the parent folder's <code>svn:ignore</code></span></label>
      <div class="macts">
        <button class="btn" id="del-cancel">Cancel</button>
        ${versioned ? `<button class="btn" id="del-svn">SVN Delete Only</button>` : ''}
        <button class="btn" id="del-trash">Move To Trash</button>
        <button class="btn danger" id="del-forever">Delete Forever</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#del-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  const run = async (mode, btn) => {
    const orig = btn.textContent;
    const ignore = $('#del-ignore', overlay).checked;
    overlay.querySelectorAll('button').forEach(b => b.disabled = true);
    btn.textContent = 'Deleting…';
    lockUI(); setPathBusy(relPath, true);
    try {
      await api('delete', { id: state.project.id, path: relPath, mode, status, ignore });
      toast(ignore ? `Deleted ${label} (now ignored — commit to apply)` : `Deleted ${label}`, 'ok');
      close();
      if (state.selPath === relPath) { state.selPath = null; state.diff = null; }
      await refreshStatus();
    } catch (err) {
      overlay.querySelectorAll('button').forEach(b => b.disabled = false);
      btn.textContent = orig;
      toast(err.message, 'err');
    } finally {
      setPathBusy(relPath, false); unlockUI();
    }
  };
  if (versioned) $('#del-svn', overlay).onclick = e => run('svn', e.currentTarget);
  $('#del-trash', overlay).onclick = e => run('trash', e.currentTarget);
  $('#del-forever', overlay).onclick = e => run('forever', e.currentTarget);
}

// proj lets the dashboard run cleanup on a project that isn't open (state.project
// is null there); inside the project view it defaults to the current project.
function openCleanupModal(relPath, label, proj = state.project) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>SVN Cleanup</h3>
      <div class="mpath">${esc(relPath || proj.name)}</div>
      <p class="warn-text">Clears stale working-copy locks and finishes interrupted operations on
        ${relPath === '' ? 'the working copy' : `<b>${esc(label)}</b>`}.
        The options below are all optional — leave everything unchecked for a plain lock-clearing cleanup.</p>
      <label class="chk"><input type="checkbox" id="cl-vacuum">
        <span>Vacuum pristine copies<br><em>Reclaims disk space from SVN's internal cache. Safe.</em></span></label>
      <div class="danger-zone">
        <div class="dz-label">Danger zone — deletes files from disk</div>
        <label class="chk"><input type="checkbox" id="cl-ignored">
          <span>Remove ignored files<br><em>Permanently deletes every file matched by svn:ignore under this folder.</em></span></label>
        <label class="chk"><input type="checkbox" id="cl-unversioned">
          <span>Remove unversioned files<br><em>Permanently deletes every unversioned file under this folder.</em></span></label>
      </div>
      <div class="macts">
        <button class="btn" id="cl-cancel">Cancel</button>
        <button class="btn primary" id="cl-run">Run Cleanup</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#cl-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  $('#cl-run', overlay).onclick = async () => {
    const btn = $('#cl-run', overlay);
    const opts = {
      removeUnversioned: $('#cl-unversioned', overlay).checked,
      removeIgnored: $('#cl-ignored', overlay).checked,
      vacuum: $('#cl-vacuum', overlay).checked,
    };
    btn.disabled = true; btn.textContent = 'Cleaning…';
    lockUI(); setPathBusy(relPath, true);
    try {
      const data = await api('cleanup', { id: proj.id, path: relPath, opts });
      toast(`Cleanup complete\n${data.output}`, 'ok');
      close();
      // In the project view, re-pull status; on the dashboard, refresh the card
      // (removing ignored/unversioned files changes its pending count).
      if (state.project) await refreshStatus();
      else checkProjectUpdate(proj.id);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Run Cleanup';
      toast(err.message, 'err');
    } finally {
      setPathBusy(relPath, false); unlockUI();
    }
  };
}

function confirmRevert(relPath, label, isDir) {
  const scope = relPath === ''
    ? 'the entire working copy'
    : isDir ? `the folder <b>${esc(label)}</b> and everything under it` : `<b>${esc(label)}</b>`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Revert changes?</h3>
      <div class="mpath">${esc(relPath || state.project.name)}</div>
      <p class="warn-text">This discards all local changes to ${scope} and cannot be undone.
      (Unversioned files are left in place.)</p>
      <div class="macts">
        <button class="btn" id="rv-cancel">Cancel</button>
        <button class="btn danger" id="rv-confirm">Revert</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  $('#rv-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
  $('#rv-confirm', overlay).onclick = async () => {
    const btn = $('#rv-confirm', overlay);
    btn.disabled = true; btn.textContent = 'Reverting…';
    lockUI(); setPathBusy(relPath, true);
    try {
      const data = await api('revert', { id: state.project.id, path: relPath });
      toast(`Reverted ${label}\n${data.output}`, 'ok');
      close();
      state.selPath = null; state.diff = null;
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Revert';
      toast(err.message, 'err');
    } finally {
      setPathBusy(relPath, false); unlockUI();
    }
  };
}

// Un-schedule a pending `svn add` (status A). This runs `svn revert`, which only
// removes the add scheduling — the item stays on disk as an unversioned file/dir,
// so nothing the user created is lost. Worded separately from confirmRevert so the
// non-destructive nature is clear.
function confirmRemoveAdd(relPath, label, isDir) {
  const scope = isDir
    ? `the folder <b>${esc(label)}</b> and everything newly added under it`
    : `<b>${esc(label)}</b>`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Undo add?</h3>
      <div class="mpath">${esc(relPath)}</div>
      <p class="warn-text">This un-schedules ${scope} from being added to SVN.
      The item stays on disk as an unversioned item — nothing is deleted.</p>
      <div class="macts">
        <button class="btn" id="ua-cancel">Cancel</button>
        <button class="btn primary" id="ua-confirm">Undo Add</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#ua-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#ua-confirm', overlay).onclick = async () => {
    const btn = $('#ua-confirm', overlay);
    btn.disabled = true; btn.textContent = 'Undoing…';
    lockUI(); setPathBusy(relPath, true);
    try {
      await api('revert', { id: state.project.id, path: relPath });
      toast(`Undid add of ${label}`, 'ok');
      close();
      if (state.selPath === relPath) { state.selPath = null; state.diff = null; }
      await refreshStatus();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Undo Add';
      toast(err.message, 'err');
    } finally {
      setPathBusy(relPath, false); unlockUI();
    }
  };
}

// -------------------------------------------------------------------- move

// Items currently being dragged (file rows / tree nodes), as [{path,label,isDir,status}].
let dragSources = [];
function clearDropHints() {
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}
// Reset once a drag ends anywhere (dropped, cancelled, or left the window).
document.addEventListener('dragend', () => { dragSources = []; clearDropHints(); });

// Build a drag-source descriptor from a file-list entry (skips un-movable ones).
function moveSrcFromFile(f) {
  return { path: f.path, label: f.path.split('/').pop(), isDir: f.isDir, status: f.status };
}

// Is `destRel` a legal place to drop these sources? Mirrors the server's guards:
// not into a source's own current parent (no-op), not onto/into a folder source
// itself, and not into that folder's own subtree. ('' = working-copy root.)
function canMoveInto(destRel, sources) {
  if (!sources || !sources.length) return false;
  for (const s of sources) {
    const srcParent = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
    if (destRel === srcParent) return false;                       // already there
    if (destRel === s.path) return false;                          // onto itself
    if (s.isDir && (destRel + '/').startsWith(s.path + '/')) return false; // into own subtree
  }
  return true;
}

// Do the move: POST to the `move` action, then refresh status + the dir tree.
async function performMove(sources, destRel, destLabel) {
  lockUI();
  sources.forEach(s => setPathBusy(s.path, true));
  try {
    const data = await api('move', { id: state.project.id, paths: sources.map(s => s.path), dest: destRel });
    toast(`Moved ${data.moved.length} item(s) to ${destLabel}`, 'ok');
    state.selPath = null; state.diff = null; state.selPaths = new Set();
    await refreshStatus();
    loadDirs();                                  // tree shape may have changed
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    sources.forEach(s => setPathBusy(s.path, false));
    unlockUI();
  }
}

// Lightweight confirm used by drag-and-drop (the destination is already chosen).
function confirmMove(sources, destRel, destLabel) {
  if (!canMoveInto(destRel, sources)) return;    // belt-and-suspenders
  const n = sources.length;
  const list = sources.slice(0, 8).map(s => `<div>${esc(s.path)}</div>`).join('')
    + (n > 8 ? `<div class="dim">…and ${n - 8} more</div>` : '');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Move ${n} item${n === 1 ? '' : 's'}?</h3>
      <div class="mpath">into <b>${esc(destLabel)}</b></div>
      <div class="move-srclist">${list}</div>
      <p class="warn-text">Versioned items move with history (<code>svn move</code>, committable);
        unversioned items are moved on disk.</p>
      <div class="macts">
        <button class="btn" id="mv-cancel">Cancel</button>
        <button class="btn primary" id="mv-go">${icon('move')} Move</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#mv-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);
  $('#mv-go', overlay).onclick = () => { close(); performMove(sources, destRel, destLabel); };
}

// Folder picker: choose a destination from the working-copy directory tree.
// `sources` is [{path,label,isDir,status}]. Used by the "Move To…" menu items.
function openMoveModal(sources) {
  if (!sources || !sources.length) return;
  let selected = null;     // chosen dest rel ('' = root is valid); null = nothing picked
  let filter = '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal move-dlg">
      <h3>${icon('move')} Move ${sources.length} item${sources.length === 1 ? '' : 's'}</h3>
      <div class="mpath">Choose a destination folder</div>
      <input type="text" id="mv-search" placeholder="Filter folders…" autocomplete="off">
      <div class="move-pick-list" id="mv-list"></div>
      <div class="macts">
        <button class="btn" id="mv-cancel">Cancel</button>
        <button class="btn primary" id="mv-go" disabled>Move here</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#mv-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  const listEl = $('#mv-list', overlay);
  const goBtn = $('#mv-go', overlay);

  // Candidate destinations: the root plus every working-copy directory.
  const candidates = ['', ...state.dirs];

  function renderList() {
    const low = filter.trim().toLowerCase();
    const rows = candidates.map(dir => {
      const label = dir === '' ? (state.project?.name || '(root)') : dir.split('/').pop();
      const full = dir === '' ? '' : dir;
      if (low && !(full.toLowerCase().includes(low) || (dir === '' && 'root'.includes(low)))) return '';
      const depth = dir === '' ? 0 : dir.split('/').length;
      const ok = canMoveInto(dir, sources);
      const sel = selected === dir && selected !== null;
      return `<div class="move-pick-row ${ok ? '' : 'disabled'} ${sel ? 'sel' : ''}"
                   data-dir="${esc(dir)}" style="padding-left:${8 + depth * 14}px">
                ${icon('folder')}<span class="mp-name">${esc(label)}</span>
                ${full ? `<span class="mp-path">${esc(full)}</span>` : ''}</div>`;
    }).join('');
    listEl.innerHTML = rows || '<div class="diff-msg">No matching folders.</div>';
  }
  renderList();

  listEl.onclick = e => {
    const row = e.target.closest('.move-pick-row');
    if (!row || row.classList.contains('disabled')) return;
    selected = row.dataset.dir;
    goBtn.disabled = false;
    renderList();
  };
  $('#mv-search', overlay).oninput = e => { filter = e.target.value; renderList(); };

  goBtn.onclick = () => {
    if (selected === null) return;
    const destLabel = selected === '' ? (state.project?.name || 'root') : selected;
    close();
    performMove(sources, selected, destLabel);
  };
}

// ------------------------------------------------------------ directory tree

function renderTree() {
  const el = $('#dir-tree');
  if (!el) return;
  const { counts, children, revs } = buildTree();
  const rows = [];
  const walk = (dir, depth) => {
    const kids = children.get(dir) || [];
    const isOpen = state.expandedDirs.has(dir);
    const label = dir === '' ? (state.project?.name || '(project root)') : dir.split('/').pop();
    const rev = nodeRevision(dir, revs);
    rows.push(`
      <div class="dir-node ${state.selectedDir === dir ? 'active' : ''}" data-dir="${esc(dir)}" draggable="${dir !== ''}"
           style="padding-left:${8 + depth * 14}px">
        <span class="twisty" data-twisty="${esc(dir)}">${kids.length ? (isOpen ? '▾' : '▸') : ''}</span>
        <span>${esc(label)}</span>
        ${rev != null ? `<span class="rev">r${rev}</span>` : ''}
        ${counts.get(dir) ? `<span class="count">${counts.get(dir)}</span>` : ''}
      </div>`);
    if (isOpen) for (const kid of kids) walk(kid, depth + 1);
  };
  walk('', 0);
  el.innerHTML = rows.join('');

  el.onclick = e => {
    const tw = e.target.closest('[data-twisty]');
    const node = e.target.closest('.dir-node');
    if (!node) return;
    const dir = node.dataset.dir;
    if (tw && tw.textContent.trim()) {
      state.expandedDirs.has(dir) ? state.expandedDirs.delete(dir) : state.expandedDirs.add(dir);
      renderTree();
      return;
    }
    state.selectedDir = dir;
    state.expandedDirs.add(dir);
    refreshList();
    renderTree();
  };

  el.oncontextmenu = e => {
    const node = e.target.closest('.dir-node');
    if (!node) return;
    const dir = node.dataset.dir;
    const label = dir === '' ? (state.project?.name || 'project root') : dir.split('/').pop();
    const sf = state.files.find(x => x.path === dir);
    openContextMenu(e.clientX, e.clientY, menuFor(dir, label, true, sf ? sf.status : ''));
    e.preventDefault();
  };

  // ---- drag to move: folders are both sources and drop targets ----
  el.ondragstart = e => {
    const node = e.target.closest('.dir-node');
    const dir = node && node.dataset.dir;
    if (!node || dir === '') { e.preventDefault(); return; }   // can't move the root
    const sf = state.files.find(x => x.path === dir);
    dragSources = [{ path: dir, label: dir.split('/').pop(), isDir: true, status: sf ? sf.status : '' }];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dir);
  };
  el.ondragover = e => {
    clearDropHints();
    const node = e.target.closest('.dir-node');
    if (!node || !canMoveInto(node.dataset.dir, dragSources)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drag-over');
  };
  el.ondrop = e => {
    const node = e.target.closest('.dir-node');
    clearDropHints();
    if (!node || !canMoveInto(node.dataset.dir, dragSources)) return;
    e.preventDefault();
    const dir = node.dataset.dir;
    const srcs = dragSources; dragSources = [];
    const label = dir === '' ? (state.project?.name || 'root') : dir.split('/').pop();
    confirmMove(srcs, dir, label);
  };
}

// --------------------------------------------------------- toolbar / filters

function renderToolbar() {
  const el = $('#file-toolbar');
  if (!el) return;
  // 'ignored' / 'unmodified' are controlled by dedicated toggles below (they trigger
  // a re-fetch), not auto status chips.
  const present = [...new Set(state.files.map(f => f.status))].filter(s => s !== 'ignored' && s !== 'unmodified');
  present.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
  const colors = STATUS_COLORS;
  const rf = state.reviewFilter;
  const kf = state.kindFilter;
  el.innerHTML = `
    <span class="f-search-wrap">
      <input type="text" id="f-search" placeholder="Filter paths… (* wildcard)" value="${esc(state.search)}" title="Substring match, or use * / ? wildcards (e.g. *Controller.php, src/*, ??.js)">
      <button type="button" id="f-search-clear" class="f-search-clear ${state.search ? '' : 'hidden'}" title="Clear filter" aria-label="Clear filter"><span class="x">×</span></button>
    </span>
    ${present.map(s => `
      <span class="chip ${state.statusFilter.has(s) ? 'on' : ''}" data-chip="${s}">
        <span class="dot" style="background:${colors[s] || 'var(--muted)'}"></span>${s}
      </span>`).join('')}
    <span class="chip ${rf === 'approved' ? 'on' : ''}" data-review="approved">
      <span class="dot" style="background:var(--green)"></span>approved
    </span>
    <span class="chip ${rf === 'unapproved' ? 'on' : ''}" data-review="unapproved">
      <span class="dot" style="background:var(--muted)"></span>unapproved
    </span>
    <span class="chip ${kf === 'files' ? 'on' : ''}" data-kind="files" title="Show only files">
      <span class="dot" style="background:var(--blue)"></span>files
    </span>
    <span class="chip ${kf === 'folders' ? 'on' : ''}" data-kind="folders" title="Show only folders">
      <span class="dot" style="background:var(--gold)"></span>folders
    </span>
    <span class="chip ${state.showUnmodified ? 'on' : ''}" data-toggle="unmodified" title="Also list unchanged (committed) files — runs a full-tree scan, slower">
      <span class="dot" style="background:var(--muted)"></span>unmodified
    </span>
    <span class="chip ${state.showIgnored ? 'on' : ''}" data-toggle="ignored" title="Show svn-ignored items (so they can be unhidden)">
      <span class="dot" style="background:var(--muted)"></span>ignored
    </span>
    <span class="file-stats" id="file-stats"></span>
    <span class="file-nav">
      <button class="btn sm ghost" id="nav-prev" title="Previous file (k / ↑)">↑</button>
      <button class="btn sm ghost" id="nav-next" title="Next file (j / ↓)">↓</button>
    </span>`;

  let debounce = null;
  const searchEl = $('#f-search', el);
  const clearEl = $('#f-search-clear', el);
  searchEl.oninput = e => {
    clearEl.classList.toggle('hidden', !e.target.value);
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.search = e.target.value; refreshList(); }, 120);
  };
  clearEl.onclick = () => {
    clearTimeout(debounce);
    searchEl.value = '';
    state.search = '';
    clearEl.classList.add('hidden');
    searchEl.focus();
    refreshList();
  };
  el.onclick = e => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const s = chip.dataset.chip;
      state.statusFilter.has(s) ? state.statusFilter.delete(s) : state.statusFilter.add(s);
      renderToolbar();
      refreshList();
      return;
    }
    const rev = e.target.closest('[data-review]');
    if (rev) {
      const v = rev.dataset.review;
      state.reviewFilter = state.reviewFilter === v ? '' : v;
      renderToolbar();
      refreshList();
      return;
    }
    const kind = e.target.closest('[data-kind]');
    if (kind) {
      const v = kind.dataset.kind;
      state.kindFilter = state.kindFilter === v ? '' : v;
      renderToolbar();
      refreshList();
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      // Changing what's fetched (svn --no-ignore / verbose) requires a server refresh.
      if (tog.dataset.toggle === 'unmodified') state.showUnmodified = !state.showUnmodified;
      else state.showIgnored = !state.showIgnored;
      refreshStatus();
      return;
    }
  };
  $('#nav-prev', el).onclick = () => stepFile(-1);
  $('#nav-next', el).onclick = () => stepFile(1);
  renderStats();
}

function renderStats() {
  const el = $('#file-stats');
  if (!el) return;
  const noun = state.showUnmodified ? 'files' : 'pending';
  el.textContent = state.loading
    ? 'loading…'
    : `${state.visible.length.toLocaleString()} shown / ${state.files.length.toLocaleString()} ${noun}`;
}

// ------------------------------------------------- virtualized file list

const FILE_COLS = [
  ['review', 'Review'], ['status', 'State'], ['name', 'File'], ['dir', 'Directory'], ['mtime', 'Modified'],
];

function renderFileHead() {
  const el = $('#file-head');
  if (!el) return;
  el.innerHTML = FILE_COLS.map(([k, label]) => {
    const i = state.sort.findIndex(s => s.k === k);
    const s = i >= 0 ? state.sort[i] : null;
    return `
      <span class="fh ${i === 0 ? 'on' : i > 0 ? 'on2' : ''}" data-sort="${k}"
            title="${i > 0 ? 'Secondary sort key' : 'Sort by ' + label.toLowerCase()}">
        ${label}${s ? (s.d > 0 ? ' ▲' : ' ▼') : ''}${i > 0 ? '<sup>2</sup>' : ''}
      </span>`;
  }).join('');
  el.onclick = e => {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const k = h.dataset.sort;
    const [primary] = state.sort;
    if (primary && primary.k === k) {
      primary.d = -primary.d;          // re-click primary: flip direction, keep secondary
    } else {
      // clicked column becomes primary (keeping its direction if it was already
      // in the chain); old primary demotes to the secondary key
      const prev = state.sort.find(s => s.k === k);
      state.sort = [{ k, d: prev ? prev.d : 1 }, ...(primary ? [primary] : [])];
    }
    renderFileHead();
    refreshList();
  };
}

function initVirtualList() {
  const fl = $('#file-list');
  fl.onscroll = () => renderVisibleRows();
  refreshList();
}

function refreshList() {
  state.visible = sortFiles(filteredFiles());
  const sp = $('#vspacer');
  if (sp) sp.style.height = (state.visible.length * ROW_H) + 'px';
  renderStats();
  renderVisibleRows(true);
}

// Inline quick-action shown beside the status char: Add for unversioned files,
// Revert for anything with local changes to undo. (Directories get neither here
// — folder-wide add/revert stays in the right-click menu.)
function rowActionBtn(f) {
  if (f.isDir) return '';
  if (f.status === 'unversioned')
    return `<button class="st-act add" data-add title="Add to SVN">${icon('add')}</button>`;
  if (REVERTABLE.has(f.status))
    return `<button class="st-act revert" data-revert title="Revert changes">${icon('revert')}</button>`;
  return '';
}

function renderVisibleRows(force = false) {
  const fl = $('#file-list');
  const wrap = $('#vrows');
  if (!fl || !wrap) return;
  const first = Math.max(0, Math.floor(fl.scrollTop / ROW_H) - 10);
  const last = Math.min(state.visible.length, Math.ceil((fl.scrollTop + fl.clientHeight) / ROW_H) + 10);

  if (!force && wrap.dataset.range === first + ':' + last) { syncRowClasses(wrap); return; }
  wrap.dataset.range = first + ':' + last;

  const out = [];
  for (let i = first; i < last; i++) {
    const f = state.visible[i];
    const offRev = f.revision != null && f.revision !== state.rootRevision;
    out.push(`
      <div class="frow ${state.selPaths.has(f.path) ? 'sel' : ''} ${state.busyPaths.has(f.path) ? 'busy' : ''}" data-path="${esc(f.path)}" draggable="true" style="top:${i * ROW_H}px"
           title="${esc(f.path)}${offRev ? '\nRevision ' + f.revision + ' (root is r' + state.rootRevision + ')' : ''}${f.notes ? '\nRejected: ' + esc(f.notes) : ''}">
        <span class="fctl">
          ${f.review === 'approved'
            ? `<button class="rv-chip approved" data-clear title="Approved — click to un-approve">✓ Approved</button>`
            : f.review === 'rejected'
            ? `<button class="rv-chip rejected" data-clear title="Rejected${f.notes ? ' — ' + esc(f.notes) : ''} — click to clear">✕ Rejected</button>`
            : `<button class="rv-approve" data-approve title="Approve">✓ Approve</button><button class="rv-reject" data-reject title="Reject with note">✕</button>`}
        </span>
        <span class="st st-${f.status}"><span class="st-char">${STATUS_CHAR[f.status] || '?'}</span><span class="row-spin spinner"></span>${rowActionBtn(f)}</span>
        <span class="fname">${esc(relName(f))}${f.isDir ? '<span class="dim">/</span>' : ''}${offRev ? ` <span class="rev">r${f.revision}</span>` : ''}<span class="eolb"></span></span>
        <span class="fdir">${esc(relDir(f))}</span>
        <span class="fmod">${fmtMtime(f.mtime)}</span>
      </div>`);
  }
  wrap.innerHTML = out.join('');
  paintEolBadges();      // fill from cache
  scheduleEolLoad();     // lazily fetch EOL for any visible rows not yet known

  // Shift-click would otherwise start a native text selection across rows.
  wrap.onmousedown = e => { if (e.shiftKey) e.preventDefault(); };

  wrap.onclick = e => {
    const row = e.target.closest('.frow');
    if (!row) return;
    const f = state.files.find(x => x.path === row.dataset.path);
    if (!f) return;
    if (e.target.closest('[data-approve]')) return void setReview(f, 'approved');
    if (e.target.closest('[data-reject]')) return void openRejectModal(f);
    if (e.target.closest('[data-clear]')) return void setReview(f, 'clear');
    if (e.target.closest('[data-add]')) return void svnAdd(f.path, relName(f));
    if (e.target.closest('[data-revert]')) return void confirmRevert(f.path, relName(f), f.isDir);
    // The "mixed" line-ending badge is a shortcut to the Line Endings dialog.
    if (e.target.closest('.eolb-mixed')) return void openEolModal(f.path, relName(f), false);
    handleRowSelect(f.path, e);
  };

  wrap.ondblclick = e => {
    const row = e.target.closest('.frow');
    if (!row) return;
    if (e.target.closest('[data-approve],[data-reject],[data-clear]')) return; // don't fire on the approve/reject buttons
    const f = state.files.find(x => x.path === row.dataset.path);
    if (!f || f.status === 'unversioned' || f.status === 'added') return; // no base to diff
    extDiff(f.path, relName(f));
  };

  wrap.oncontextmenu = e => {
    const row = e.target.closest('.frow');
    if (!row) return;
    e.preventDefault();
    const f = state.files.find(x => x.path === row.dataset.path);
    if (!f) return;
    // Right-clicking a row outside the current multi-selection reduces the
    // selection to just that row (without opening the review panel).
    if (!state.selPaths.has(f.path)) {
      state.selPaths = new Set([f.path]);
      state.selAnchor = f.path;
      state.selPath = null; state.diff = null;
      renderPanel();
      syncRowClasses($('#vrows'));
    }
    const paths = [...state.selPaths];
    if (paths.length > 1) openContextMenu(e.clientX, e.clientY, batchMenuFor(paths));
    else openContextMenu(e.clientX, e.clientY, menuFor(f.path, f.path, f.isDir, f.status, { review: f }));
  };

  // ---- drag to move: rows are sources; folder rows are drop targets ----
  wrap.ondragstart = e => {
    const row = e.target.closest('.frow');
    const f = row && state.files.find(x => x.path === row.dataset.path);
    if (!f) return;
    // Drag the whole multi-selection when the grabbed row is part of it.
    const picked = (state.selPaths.has(f.path) && state.selPaths.size > 1)
      ? [...state.selPaths].map(p => state.files.find(x => x.path === p)).filter(Boolean)
      : [f];
    dragSources = picked
      .filter(x => x.status !== 'deleted' && x.status !== 'missing')
      .map(moveSrcFromFile);
    if (!dragSources.length) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSources.map(s => s.path).join('\n'));
  };
  wrap.ondragover = e => {
    clearDropHints();
    const row = e.target.closest('.frow');
    const f = row && state.files.find(x => x.path === row.dataset.path);
    if (!f || !f.isDir || !canMoveInto(f.path, dragSources)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  };
  wrap.ondrop = e => {
    const row = e.target.closest('.frow');
    const f = row && state.files.find(x => x.path === row.dataset.path);
    clearDropHints();
    if (!f || !f.isDir || !canMoveInto(f.path, dragSources)) return;
    e.preventDefault();
    const srcs = dragSources; dragSources = [];
    confirmMove(srcs, f.path, f.path.split('/').pop());
  };
}

// Apply a click on a file row: plain = single select (opens review panel),
// Ctrl/Cmd = toggle membership, Shift = range from the anchor (visible order).
function handleRowSelect(path, e) {
  $('#file-list')?.focus({ preventScroll: true }); // own keyboard focus (enables Ctrl+A select-all)
  if (e.shiftKey && state.selAnchor) {
    const order = state.visible.map(f => f.path);
    let i = order.indexOf(state.selAnchor);
    const j = order.indexOf(path);
    if (i < 0) i = j;
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    state.selPaths = new Set(order.slice(lo, hi + 1));
    // anchor stays put for further range extension
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selPaths.has(path)) state.selPaths.delete(path);
    else state.selPaths.add(path);
    state.selAnchor = path;
  } else {
    state.selPaths = new Set([path]);
    state.selAnchor = path;
  }
  applySelection();
}

// Reconcile the review panel with the multi-selection: a lone selection opens
// the panel/diff; zero or many never show the panel (per spec).
function applySelection() {
  if (state.selPaths.size === 1) {
    selectFile([...state.selPaths][0]);
  } else {
    state.selPath = null;
    state.diff = null;
    renderPanel();
    syncRowClasses($('#vrows'));
  }
}

function syncRowClasses(wrap) {
  if (!wrap) return;
  for (const row of wrap.children) {
    row.classList.toggle('sel', state.selPaths.has(row.dataset.path));
  }
}

// ------------------------------------------------- EOL badges (lazy, visible)

const EOL_BADGE = { crlf: 'CRLF', lf: 'LF', cr: 'CR', mixed: 'mixed' };

// Paint each visible row's EOL badge from the cache (empty if unknown/loading/n-a).
function paintEolBadges() {
  const wrap = $('#vrows');
  if (!wrap) return;
  for (const row of wrap.children) {
    const span = row.querySelector('.eolb');
    if (!span) continue;
    const tok = state.eol.get(row.dataset.path);
    const label = typeof tok === 'string' ? EOL_BADGE[tok] : undefined;
    span.className = label ? 'eolb eolb-' + tok : 'eolb';
    span.textContent = label || '';
    span.title = tok === 'mixed' ? 'Mixed line endings — click to open Line Endings…' : '';
  }
}

let eolLoadTimer = null;
function scheduleEolLoad() {
  clearTimeout(eolLoadTimer);
  eolLoadTimer = setTimeout(loadVisibleEol, 80);
}

// Fetch EOL classification for the visible rows we don't know yet, then repaint.
async function loadVisibleEol() {
  const wrap = $('#vrows');
  if (!wrap || !state.project) return;
  const need = [];
  for (const row of wrap.children) {
    const p = row.dataset.path;
    if (state.eol.has(p)) continue;           // known or already loading (null)
    const f = state.files.find(x => x.path === p);
    if (!f || f.isDir || f.status === 'deleted' || f.status === 'missing') continue;
    need.push(p);
  }
  if (!need.length) return;
  need.forEach(p => state.eol.set(p, null));  // mark loading to avoid duplicate fetches
  try {
    const data = await api('eol_info', { id: state.project.id, paths: need });
    for (const p of need) state.eol.set(p, data.eol[p] || 'none');
  } catch {
    need.forEach(p => state.eol.delete(p));   // let a later pass retry
    return;
  }
  paintEolBadges();
}

// ----------------------------------------------------------- review actions

async function setReview(f, verdict, notes = '') {
  try {
    await api('review', {
      id: state.project.id, path: f.path, verdict,
      notes, svnStatus: f.status,
    });
    f.review = verdict === 'clear' ? null : verdict;
    f.notes = verdict === 'rejected' ? notes : null;
    renderVisibleRows(true);
    renderCommitBar();
    if (state.selPath === f.path) renderPanelHead();
  } catch (err) { toast(err.message, 'err'); }
}

function openRejectModal(f) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Reject change</h3>
      <div class="mpath">${esc(f.path)}</div>
      <div class="section-label">Notes (optional)</div>
      <textarea id="rej-notes" placeholder="What needs to change before this can be approved?">${esc(f.notes || '')}</textarea>
      <div class="macts">
        <button class="btn" id="rej-cancel">Cancel</button>
        <button class="btn danger" id="rej-save">Reject</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = $('#rej-notes', overlay);
  ta.focus();
  const close = () => overlay.remove();
  $('#rej-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  $('#rej-save', overlay).onclick = async () => {
    const notes = ta.value.trim();
    await setReview(f, 'rejected', notes);
    close();
  };
  ta.onkeydown = e => { if (e.key === 'Escape') close(); };
}

// ------------------------------------------------------------- review panel

async function selectFile(path) {
  // Selecting one file collapses any multi-selection down to it.
  state.selPaths = new Set([path]);
  state.selAnchor = path;
  if (state.selPath === path) { syncRowClasses($('#vrows')); return; } // already open — don't reload / flash the panel
  state.selPath = path;
  // Only toggle the selection class — don't rebuild #vrows. Replacing the row
  // nodes here would destroy the element mid-gesture and suppress the dblclick.
  const wrap = $('#vrows');
  if (wrap) syncRowClasses(wrap);
  await loadDiff(path);
}

// (Re)fetch the diff for the open file and render the panel. Used both when a
// file is first selected and when Refresh re-pulls the diff for the open file.
async function loadDiff(path) {
  const f = state.files.find(x => x.path === path);
  if (!f) return;
  state.diff = null;
  renderPanel();             // show the "Loading diff…" state
  setPathBusy(path, true);   // row spinner while the diff loads (reading)
  try {
    const data = await api('diff', { id: state.project.id, path: f.path, status: f.status });
    if (state.selPath !== path) return; // user moved on
    state.diff = data;
  } catch (err) {
    if (state.selPath !== path) return;
    state.diff = { error: err.message };
  } finally {
    setPathBusy(path, false);
  }
  renderPanel();
}

// ------------------------------------------------- review panel resize
const PANEL_H_KEY = 'svnreview.panelHeight';

function clampPanelHeight(h) {
  return Math.max(100, Math.min(window.innerHeight - 100, h));
}

// Apply the persisted panel height (px) as an inline override of the CSS default.
function applyPanelHeight() {
  const panel = $('#review-panel');
  if (!panel) return;
  const saved = parseInt(localStorage.getItem(PANEL_H_KEY) || '', 10);
  if (saved > 0) panel.style.height = clampPanelHeight(saved) + 'px';
}

function initPanelResize() {
  const handle = $('#panel-resize');
  const panel = $('#review-panel');
  if (!handle || !panel) return;
  handle.onmousedown = e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
    const onMove = ev => {
      // panel is anchored at the bottom — dragging up (smaller clientY) grows it
      panel.style.height = clampPanelHeight(startH + (startY - ev.clientY)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      localStorage.setItem(PANEL_H_KEY, String(Math.round(panel.getBoundingClientRect().height)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

function closePanel() {
  // Hide the diff panel but leave the row selected/highlighted. selPaths still
  // holds it, so the highlight stays; clearing selPath lets a later click on the
  // same row re-open the panel.
  state.selPath = null;
  state.diff = null;
  renderPanel();
  syncRowClasses($('#vrows'));
}

function renderPanel() {
  const panel = $('#review-panel');
  if (!panel) return;
  if (!state.selPath) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  const f = state.files.find(x => x.path === state.selPath);
  if (!f) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';

  panel.innerHTML = `
    <div class="panel-resize" id="panel-resize" title="Drag to resize"></div>
    <div class="review-head" id="review-head"></div>
    <div id="rej-bar"></div>
    <div class="diff-wrap" id="diff-wrap"></div>`;
  applyPanelHeight();
  initPanelResize();
  renderPanelHead();

  const wrap = $('#diff-wrap', panel);
  const d = state.diff;
  if (!d) { wrap.innerHTML = `<div class="diff-msg">Loading diff…</div>`; return; }
  if (d.error) { wrap.innerHTML = `<div class="diff-msg">⚠ ${esc(d.error)}</div>`; return; }
  if (d.binary) { wrap.innerHTML = `<div class="diff-msg">Binary file — no text diff available.</div>`; return; }
  if (d.note) { wrap.innerHTML = `<div class="diff-msg">${esc(d.note)}</div>`; return; }
  const props = d.props || [];
  let html = '';
  if (d.hunks.length) html += renderSideBySide(d);
  if (props.length) html += renderPropChanges(props);
  if (!html) html = `<div class="diff-msg">No textual changes (empty file or non-content change).</div>`;
  wrap.innerHTML = html;
}

// Render the svn-property changes block (e.g. svn:ignore edits) beneath the diff.
function renderPropChanges(props) {
  const blocks = props.map(p => {
    const lines = p.lines.map(l => {
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
      const sign = l.t === '+' ? '+' : l.t === '-' ? '−' : ' ';
      return `<div class="prop-line ${cls}"><span class="prop-sign">${sign}</span><span class="prop-val">${esc(l.s)}</span></div>`;
    }).join('');
    return `<div class="prop-change">
      <div class="prop-head"><span class="prop-action ${esc(p.action.toLowerCase())}">${esc(p.action)}</span><code>${esc(p.name)}</code></div>
      <div class="prop-body">${lines}</div>
    </div>`;
  }).join('');
  return `<div class="prop-section"><div class="prop-title">Property changes</div>${blocks}</div>`;
}

function renderPanelHead() {
  const head = $('#review-head');
  if (!head || !state.selPath) return;
  const f = state.files.find(x => x.path === state.selPath);
  if (!f) return;
  const idx = state.visible.findIndex(x => x.path === f.path);
  head.innerHTML = `
    <span class="stbadge ${f.status}">${f.status}</span>
    <span class="fname">${esc(f.path)}</span>
    ${f.review ? `<span class="badge ${f.review}">${f.review}</span>` : ''}
    <div class="spacer" style="flex:1"></div>
    <button class="btn sm" id="pv-prev" ${idx <= 0 ? 'disabled' : ''}>↑ Prev</button>
    <button class="btn sm" id="pv-next" ${idx >= state.visible.length - 1 ? 'disabled' : ''}>↓ Next</button>
    <button class="btn sm ok" id="pv-approve">✓ Approve</button>
    <button class="btn sm danger" id="pv-reject">✕ Reject</button>
    <button class="btn sm ghost" id="pv-clear" ${f.review ? '' : 'disabled'}>↺ Clear</button>
    <button class="btn sm ghost" id="pv-close">Close</button>`;
  $('#pv-prev').onclick = () => stepFile(-1);
  $('#pv-next').onclick = () => stepFile(1);
  $('#pv-approve').onclick = () => setReview(f, 'approved');
  $('#pv-reject').onclick = () => openRejectModal(f);
  const clr = $('#pv-clear'); if (clr && f.review) clr.onclick = () => setReview(f, 'clear');
  $('#pv-close').onclick = closePanel;

  const rejBar = $('#rej-bar');
  if (rejBar) rejBar.innerHTML = f.review === 'rejected' && f.notes
    ? `<div class="reject-notes-bar"><b>Rejected:</b> ${esc(f.notes)}</div>` : '';
}

function stepFile(dir) {
  if (!state.visible.length) return;
  let idx = state.visible.findIndex(x => x.path === state.selPath);
  idx = idx < 0 ? 0 : Math.min(state.visible.length - 1, Math.max(0, idx + dir));
  selectFile(state.visible[idx].path);
  const fl = $('#file-list');
  if (fl) {
    const top = idx * ROW_H;
    if (top < fl.scrollTop) fl.scrollTop = top;
    else if (top + ROW_H > fl.scrollTop + fl.clientHeight) fl.scrollTop = top + ROW_H - fl.clientHeight;
  }
}

// ------------------------------------------------- intra-line (word) diff

// Tokens concatenate back to the exact original string.
function diffTokens(s) {
  return s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) || [];
}

function lcsOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: '=', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });
  return ops;
}

// Word-level diff of a paired old/new line. Returns char ranges to mark:
// { del: [[start,end],...]  on the old line,
//   add: [[start,end],...]  on the new line,
//   gaps: [offset,...]      new-line offsets where text was removed outright }
// or null when marking would be useless (identical lines, or nothing in common).
function intraDiff(oldS, newS) {
  const a = diffTokens(oldS), b = diffTokens(newS);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s);
  if (!am.length && !bm.length) return null;
  const ops = am.length * bm.length <= 20000   // cap LCS cost on huge (minified) lines
    ? lcsOps(am, bm)
    : [...am.map(t => ({ t: '-', s: t })), ...bm.map(t => ({ t: '+', s: t }))];

  let oldPos = 0;
  for (let i = 0; i < p; i++) oldPos += a[i].length;
  let newPos = oldPos;                          // common prefix, same length on both sides
  const del = [], add = [], gaps = [];
  for (let k = 0; k < ops.length;) {
    const t = ops[k].t, k0 = k;
    let len = 0;
    while (k < ops.length && ops[k].t === t) { len += ops[k].s.length; k++; }
    if (t === '=') { oldPos += len; newPos += len; }
    else if (t === '-') {
      del.push([oldPos, oldPos + len]); oldPos += len;
      const nearAdd = (k0 > 0 && ops[k0 - 1].t === '+') || (k < ops.length && ops[k].t === '+');
      if (!nearAdd) gaps.push(newPos);
    } else { add.push([newPos, newPos + len]); newPos += len; }
  }
  // If both lines changed almost entirely there is no useful anchor — skip.
  const sum = r => r.reduce((t, x) => t + x[1] - x[0], 0);
  if (oldS.length && newS.length && sum(del) > 0.85 * oldS.length && sum(add) > 0.85 * newS.length) return null;
  return { del, add, gaps };
}

// Wrap plain-text char ranges of highlight.js output in <span class="cls">,
// and drop zero-width gap markers at the given plain-text offsets. Walks the
// HTML so tags pass through untouched and entities count as one character;
// mark spans only ever wrap bare text, so hljs's own nesting stays valid.
function markRanges(html, ranges, cls, gaps = []) {
  if (!ranges.length && !gaps.length) return html;
  const GAP = '<span class="iw-gap"></span>';
  let out = '', plain = 0, i = 0, ri = 0, gi = 0, open = false;
  const close = () => { if (open) { out += '</span>'; open = false; } };
  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      close();
      const j = html.indexOf('>', i);
      out += html.slice(i, j + 1); i = j + 1;
      continue;
    }
    while (gi < gaps.length && gaps[gi] <= plain) { close(); out += GAP; gi++; }
    let chunk;
    if (c === '&') {
      const j = html.indexOf(';', i);
      if (j > i && j - i <= 12) { chunk = html.slice(i, j + 1); i = j + 1; }
      else { chunk = c; i++; }
    } else { chunk = c; i++; }
    while (ri < ranges.length && plain >= ranges[ri][1]) ri++;
    const inRange = ri < ranges.length && plain >= ranges[ri][0];
    if (inRange && !open) { out += `<span class="${cls}">`; open = true; }
    if (!inRange) close();
    out += chunk;
    plain++;
  }
  close();
  while (gi < gaps.length) { out += GAP; gi++; }
  return out;
}

// Side-by-side renderer: pairs deletion runs with addition runs inside hunks.
function renderSideBySide(d) {
  const lang = d.lang || 'plaintext';
  const rows = [];
  const emit = (oldLn, oldHtml, oldCls, newLn, newHtml, newCls) => {
    rows.push(`<tr>
      <td class="ln ${oldCls === 'del' ? 'del-ln' : ''}">${oldLn ?? ''}</td>
      <td class="side ${oldCls || 'empty'}">${oldHtml ?? ''}</td>
      <td class="ln ${newCls === 'add' ? 'add-ln' : ''}">${newLn ?? ''}</td>
      <td class="side ${newCls || 'empty'}">${newHtml ?? ''}</td>
    </tr>`);
  };

  for (const hunk of d.hunks) {
    rows.push(`<tr class="hunk-sep"><td colspan="4">@@ -${hunk.oldStart} +${hunk.newStart} @@</td></tr>`);
    let oldLn = hunk.oldStart, newLn = hunk.newStart;
    let dels = [], adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const del = dels[i], add = adds[i];
        let oldHtml = del !== undefined ? hl(del, lang) : null;
        let newHtml = add !== undefined ? hl(add, lang) : null;
        if (del !== undefined && add !== undefined) {
          const m = intraDiff(del, add);
          if (m) {
            oldHtml = markRanges(oldHtml, m.del, 'iw-del');
            newHtml = markRanges(newHtml, m.add, 'iw-add', m.gaps);
          }
        }
        emit(
          del !== undefined ? oldLn++ : null, oldHtml, del !== undefined ? 'del' : null,
          add !== undefined ? newLn++ : null, newHtml, add !== undefined ? 'add' : null,
        );
      }
      dels = []; adds = [];
    };
    for (const line of hunk.lines) {
      if (line.t === '-') { dels.push(line.s); continue; }
      if (line.t === '+') { adds.push(line.s); continue; }
      flush();
      const html = hl(line.s, lang);
      emit(oldLn++, html, 'ctx', newLn++, html, 'ctx');
    }
    flush();
  }
  return `<table class="diff-table">${rows.join('')}</table>`;
}

// --------------------------------------------------------------- commit bar

// Per-project commit-message draft, persisted in localStorage so it survives
// closing the window or switching projects (cleared on a successful commit).
function commitMsgKey(id) { return 'svnreview:commitMsg:' + id; }
function loadCommitDraft(id) { try { return localStorage.getItem(commitMsgKey(id)) || ''; } catch { return ''; } }
function saveCommitDraft(id, msg) {
  try { msg ? localStorage.setItem(commitMsgKey(id), msg) : localStorage.removeItem(commitMsgKey(id)); }
  catch {}
}

function renderCommitBar() {
  const el = $('#commit-bar');
  if (!el) return;
  const approved = state.files.filter(f => f.review === 'approved');
  const rejected = state.files.filter(f => f.review === 'rejected');
  const total = state.files.length;
  const pct = total ? Math.round(approved.length / total * 100) : 0;
  const busy = commitBarBusy();
  el.innerHTML = `
    <div class="commit-progress">
      <div class="cp-top"><span>${approved.length} of ${total} approved</span><span class="cp-pct">${pct}%</span></div>
      <div class="cp-track"><div class="cp-fill" style="width:${pct}%"></div></div>
    </div>
    ${rejected.length ? `<span class="rejected-count">✕ ${rejected.length} rejected</span>` : ''}
    <button class="btn sm msg-hist-btn" id="btn-msg-history" ${busy ? 'disabled' : ''}
      title="Reuse a commit message from history…">${icon('history')}</button>
    <textarea id="commit-msg" rows="1" placeholder="Commit message for approved files…" ${busy ? 'readonly' : ''}></textarea>
    <span class="split-btn">
      <button class="btn primary" id="btn-commit" ${(busy || !approved.length) ? 'disabled' : ''}>${
        state.committing ? '<span class="spinner"></span> Committing…' : `Commit ${approved.length || ''}`}</button>
      <button class="btn primary split-more" id="btn-commit-more" ${busy ? 'disabled' : ''} title="Choose specific files to commit…">⋯</button>
    </span>`;

  const msgEl = $('#commit-msg', el);
  // Auto-grow: start at one line (30px) and expand up to ~6 lines (110px), then scroll.
  const growMsg = () => { msgEl.style.height = 'auto'; msgEl.style.height = Math.min(msgEl.scrollHeight + 2, 110) + 'px'; };
  msgEl.value = loadCommitDraft(state.project.id);
  growMsg();
  msgEl.oninput = () => { saveCommitDraft(state.project.id, msgEl.value); growMsg(); };
  // Enter inserts a newline (textarea default); commit via the Commit button.
  $('#btn-msg-history', el).onclick = () => {
    if (commitBarBusy()) return;
    openMessagePicker(msg => {
      msgEl.value = msg;
      saveCommitDraft(state.project.id, msg);
      msgEl.focus();
    });
  };
  $('#btn-commit', el).onclick = async () => {
    if (commitBarBusy()) return;
    const message = msgEl.value.trim();
    if (!message) return toast('Commit message is required', 'err');
    if (!confirm(`Commit ${approved.length} approved file(s)?\n\n“${message}”`)) return;
    state.committing = true;
    lockUI();   // re-renders: readonly message, spinner on Commit, ⋯ disabled
    try {
      await doCommit({ message });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      state.committing = false;
      unlockUI();
    }
  };
  $('#btn-commit-more', el).onclick = () => { if (!commitBarBusy()) openCommitDialog(); };
}

// Run a commit (approved set by default, or an explicit `paths` selection) and
// refresh. Throws on failure so callers can restore their own UI.
async function doCommit({ message, paths = null }) {
  const params = { id: state.project.id, message };
  if (paths) params.paths = paths;
  const data = await api('commit', params);
  let msg = data.output || `Committed ${data.committed.length} file(s).`;
  if (data.skipped.length) msg += `\n⚠ Skipped (no longer pending / changed): ${data.skipped.join(', ')}`;
  toast(msg, 'ok');
  saveCommitDraft(state.project.id, '');   // committed — discard the saved draft
  state.selPath = null; state.diff = null;
  // Auto-run `svn update` after every commit so the working copy lands at HEAD —
  // it picks up the revision just created plus any other server-side changes.
  try {
    const upd = await api('update', { id: state.project.id, path: '' });
    toast(upd.output || 'Updated to HEAD.', 'ok');
  } catch (err) {
    toast('Commit succeeded, but the post-commit update failed: ' + err.message, 'err');
  }
  await refreshStatus();
}

// Pick a past commit message to (re)use. Fetches recent working-copy history,
// de-duplicates by message text (newest kept), and lets the user filter and click
// one. Calls onPick(message) with the chosen text — it never commits; the caller
// just drops the text into a message box so it can still be edited.
function openMessagePicker(onPick) {
  let entries = [];          // de-duped [{rev, author, date, msg}], newest first
  let search = '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal msg-pick-dlg">
      <h3>Reuse a commit message</h3>
      <div class="mpath">Pick a message from history to fill the commit box — you can still edit it before committing.</div>
      <input type="text" id="mp-search" placeholder="Filter messages…" autocomplete="off">
      <div class="mp-list" id="mp-list"><div class="mp-empty">Loading history…</div></div>
      <div class="macts"><button class="btn" id="mp-cancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#mp-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  const listEl = $('#mp-list', overlay);
  const fmtDate = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const render = () => {
    const q = search.toLowerCase();
    const rows = q ? entries.filter(e => e.msg.toLowerCase().includes(q)) : entries;
    if (!rows.length) {
      listEl.innerHTML = `<div class="mp-empty">${entries.length ? 'No messages match.' : 'No commit messages found.'}</div>`;
      return;
    }
    listEl.innerHTML = rows.map(e => `
      <div class="mp-row" data-rev="${e.rev}">
        <div class="mp-msg">${esc(e.msg)}</div>
        <div class="mp-meta">r${e.rev} · ${esc(e.author || '—')}${e.date ? ' · ' + esc(fmtDate(e.date)) : ''}</div>
      </div>`).join('');
    listEl.querySelectorAll('.mp-row').forEach(row => {
      row.onclick = () => {
        const e = rows.find(x => String(x.rev) === row.dataset.rev);
        if (e) { onPick(e.msg); close(); }
      };
    });
  };

  $('#mp-search', overlay).oninput = e => { search = e.target.value; render(); };

  api('log', { id: state.project.id, limit: 100 }).then(data => {
    const seen = new Set();
    for (const e of (data.entries || [])) {
      const msg = (e.msg || '').trim();
      if (msg === '' || seen.has(msg)) continue;   // skip empty + duplicate messages
      seen.add(msg);
      entries.push({ rev: e.rev, author: e.author, date: e.date, msg });
    }
    render();
    $('#mp-search', overlay).focus();
  }).catch(err => {
    listEl.innerHTML = `<div class="mp-empty">Couldn't load history: ${esc(err.message)}</div>`;
  });
}

// "Choose files to commit" picker: All/None/Approved presets + search, a paged
// checklist (with the row context menu, minus destructive actions), and the
// commit message. Commits exactly the checked files.
function openCommitDialog() {
  const PAGE = 150;
  // committable pending items (ignored / unchanged files aren't committable)
  const candidates = state.files.filter(f => f.status !== 'ignored' && f.status !== 'unmodified');
  if (!candidates.length) return toast('Nothing pending to commit.', 'ok');

  const selected = new Set(state.files.filter(f => f.review === 'approved').map(f => f.path));
  let search = '';
  let page = 0;
  // local copies of the main list's filters (snapshot — editing them here doesn't
  // touch the main view)
  const dlgStatus = new Set(state.statusFilter);
  let dlgReview = state.reviewFilter;
  let dlgKind = state.kindFilter;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal commit-dlg">
      <h3>Commit files</h3>
      <div class="ci-toolbar">
        <input type="text" id="ci-search" placeholder="Filter paths… (* wildcard)" title="Substring match, or use * / ? wildcards (e.g. *Controller.php, src/*, ??.js)">
        <span class="ci-presets">
          <button class="btn sm" data-sel="all">All</button>
          <button class="btn sm" data-sel="none">None</button>
          <button class="btn sm" data-sel="approved">Approved</button>
        </span>
        <span class="ci-count" id="ci-count"></span>
      </div>
      <div class="ci-filters" id="ci-filters"></div>
      <div class="ci-list" id="ci-list"></div>
      <div class="ci-pager" id="ci-pager"></div>
      <div class="ci-msg-head">
        <span>Commit message</span>
        <button class="btn sm" id="ci-msg-history" title="Reuse a commit message from history…">${icon('history')} History</button>
      </div>
      <textarea id="ci-msg" class="ci-msg" placeholder="Commit message…">${esc(loadCommitDraft(state.project.id))}</textarea>
      <div class="macts">
        <button class="btn" id="ci-cancel">Cancel</button>
        <button class="btn primary" id="ci-commit">Commit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); closeCtxMenu(); };
  function onEsc(e) { if (e.key === 'Escape') close(); }
  $('#ci-cancel', overlay).onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onEsc);

  const msgEl = $('#ci-msg', overlay);
  msgEl.oninput = () => saveCommitDraft(state.project.id, msgEl.value);
  $('#ci-msg-history', overlay).onclick = () => openMessagePicker(msg => {
    msgEl.value = msg;
    saveCommitDraft(state.project.id, msg);
    msgEl.focus();
  });

  const filtered = () => {
    const match = compileSearch(search);   // same substring/wildcard matcher as the main list
    return candidates.filter(f => {
      if (dlgStatus.size && !dlgStatus.has(f.status)) return false;
      if (dlgReview === 'approved' && f.review !== 'approved') return false;
      if (dlgReview === 'unapproved' && f.review === 'approved') return false;
      if (dlgKind === 'files' && f.isDir) return false;
      if (dlgKind === 'folders' && !f.isDir) return false;
      if (match && !match(f.path)) return false;
      return true;
    });
  };

  // The same filter pills the main file list has (status chips + approved/unapproved
  // + files/folders), scoped to this dialog. The fetch toggles (ignored/unmodified)
  // are omitted — they don't apply to a commit selection.
  const renderCiFilters = () => {
    const present = [...new Set(candidates.map(f => f.status))]
      .sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
    const chip = (on, attr, val, color, label) =>
      `<span class="chip ${on ? 'on' : ''}" data-cfilt="${attr}" data-val="${val}">`
      + `<span class="dot" style="background:${color}"></span>${label}</span>`;
    $('#ci-filters', overlay).innerHTML =
      present.map(s => chip(dlgStatus.has(s), 'status', s, STATUS_COLORS[s] || 'var(--muted)', s)).join('')
      + chip(dlgReview === 'approved', 'review', 'approved', 'var(--green)', 'approved')
      + chip(dlgReview === 'unapproved', 'review', 'unapproved', 'var(--muted)', 'unapproved')
      + chip(dlgKind === 'files', 'kind', 'files', 'var(--blue)', 'files')
      + chip(dlgKind === 'folders', 'kind', 'folders', 'var(--gold)', 'folders');
  };

  const renderList = () => {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.min(page, pages - 1);
    const rows = list.slice(page * PAGE, page * PAGE + PAGE).map(f => `
      <label class="ci-row" data-path="${esc(f.path)}">
        <input type="checkbox" ${selected.has(f.path) ? 'checked' : ''}>
        <span class="st st-${f.status}">${STATUS_CHAR[f.status] || '?'}</span>
        <span class="ci-path">${esc(f.path)}${f.isDir ? '<span class="dim">/</span>' : ''}</span>
        ${f.review ? `<span class="badge ${f.review}">${f.review}</span>` : ''}
      </label>`).join('');
    $('#ci-list', overlay).innerHTML = rows || `<div class="diff-msg">No files match “${esc(search)}”.</div>`;
    $('#ci-count', overlay).textContent = `${selected.size} selected / ${candidates.length} pending`;
    $('#ci-pager', overlay).innerHTML = pages > 1
      ? `<button class="btn sm ghost" id="ci-prev" ${page === 0 ? 'disabled' : ''}>← Prev</button>
         <span class="ci-pageinfo">Page ${page + 1} of ${pages}</span>
         <button class="btn sm ghost" id="ci-next" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button>` : '';
    const prev = $('#ci-prev', overlay), next = $('#ci-next', overlay);
    if (prev) prev.onclick = () => { page--; renderList(); };
    if (next) next.onclick = () => { page++; renderList(); };
  };
  renderCiFilters();
  renderList();

  $('#ci-filters', overlay).onclick = e => {
    const chip = e.target.closest('[data-cfilt]'); if (!chip) return;
    const { cfilt, val } = chip.dataset;
    if (cfilt === 'status') dlgStatus.has(val) ? dlgStatus.delete(val) : dlgStatus.add(val);
    else if (cfilt === 'review') dlgReview = dlgReview === val ? '' : val;
    else if (cfilt === 'kind') dlgKind = dlgKind === val ? '' : val;
    page = 0;
    renderCiFilters();
    renderList();
  };

  let searchTimer = null;
  $('#ci-search', overlay).oninput = e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = e.target.value; page = 0; renderList(); }, 120);
  };

  $('.ci-presets', overlay).onclick = e => {
    const sel = e.target.closest('[data-sel]'); if (!sel) return;
    const scope = filtered();   // presets act on the current filter
    if (sel.dataset.sel === 'none') scope.forEach(f => selected.delete(f.path));
    else if (sel.dataset.sel === 'all') scope.forEach(f => selected.add(f.path));
    else scope.forEach(f => f.review === 'approved' ? selected.add(f.path) : selected.delete(f.path));
    renderList();
  };

  const listEl = $('#ci-list', overlay);
  listEl.onchange = e => {
    const row = e.target.closest('.ci-row'); if (!row) return;
    e.target.checked ? selected.add(row.dataset.path) : selected.delete(row.dataset.path);
    $('#ci-count', overlay).textContent = `${selected.size} selected / ${candidates.length} pending`;
  };
  listEl.oncontextmenu = e => {
    const row = e.target.closest('.ci-row'); if (!row) return;
    const f = state.files.find(x => x.path === row.dataset.path); if (!f) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, menuFor(f.path, f.path, f.isDir, f.status, { noDestructive: true }));
  };

  $('#ci-commit', overlay).onclick = async () => {
    const message = msgEl.value.trim();
    if (!message) return toast('Commit message is required', 'err');
    const paths = [...selected];
    if (!paths.length) return toast('Select at least one file', 'err');
    if (!confirm(`Commit ${paths.length} selected file(s)?\n\n“${message}”`)) return;
    const btn = $('#ci-commit', overlay);
    overlay.querySelectorAll('button, input, textarea').forEach(b => b.disabled = true);
    btn.innerHTML = '<span class="spinner"></span> Committing…';
    try {
      await doCommit({ message, paths });
      close();
    } catch (err) {
      overlay.querySelectorAll('button, input, textarea').forEach(b => b.disabled = false);
      btn.textContent = 'Commit';
      toast(err.message, 'err');
    }
  };
}

// -------------------------------------------------------------------- merge

const ACCEPT_OPTS = [
  ['postpone',        'postpone — leave conflicts in the files to resolve later'],
  ['mine-conflict',   'mine-conflict — keep my side for conflicting hunks'],
  ['theirs-conflict', 'theirs-conflict — take the incoming side for conflicting hunks'],
  ['mine-full',       'mine-full — keep my whole file on any conflict'],
  ['theirs-full',     'theirs-full — take the incoming whole file on any conflict'],
  ['merge',           'merge — run the interactive/auto merge resolver'],
  ['base',            'base — use the common ancestor for conflicts'],
];
const DEPTH_OPTS = [
  ['', '(working copy default)'], ['infinity', 'infinity (fully recursive)'],
  ['immediates', 'immediates'], ['files', 'files'], ['empty', 'empty'],
];
const MERGE_CODE_CLASS = { U: 'modified', G: 'modified', A: 'added', D: 'deleted',
                           R: 'deleted', C: 'conflicted', E: 'unversioned' };

function fmtSvnDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? s.slice(0, 19).replace('T', ' ') : d.toLocaleString();
}

// Merge wizard: pick a source branch (browse the repo or type a URL), choose what
// to merge (cherry-pick revisions / sync all eligible / reintegrate), pick an
// accept strategy, preview a dry-run, then apply. The merge lands as pending
// working-copy changes that flow into the normal review → commit pipeline.
function openMergeModal(targetRel = '', targetLabel = null) {
  const id = state.project.id;
  const m = {
    mode: 'cherrypick',
    sourceMode: 'browse',
    source: '',                 // chosen source URL
    browseUrl: '',              // where the browser currently is
    rootUrl: '',                // repo root
    revs: new Set(),            // selected revisions (cherry-pick)
    logEntries: [], logBefore: null, logDone: false,
    eligible: null,             // null = not loaded yet (sync)
    target: targetRel,
    accept: 'postpone', depth: '', recordOnly: false,
    busy: false,
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal merge-dlg">
      <h3>${icon('merge')} Merge from another branch</h3>
      <div class="mpath">into ${esc(targetLabel || (targetRel || state.project.name))}</div>
      <div class="merge-body" id="mg-body"></div>
      <div class="macts">
        <button class="btn" id="mg-cancel">Cancel</button>
        <button class="btn" id="mg-preview">Preview (dry-run)</button>
        <button class="btn danger" id="mg-apply">Merge</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
  function onEsc(e) { if (e.key === 'Escape' && !m.busy) close(); }
  $('#mg-cancel', overlay).onclick = () => { if (!m.busy) close(); };
  overlay.onclick = e => { if (e.target === overlay && !m.busy) close(); };
  document.addEventListener('keydown', onEsc);

  const body = $('#mg-body', overlay);

  // ----- source browser -------------------------------------------------
  async function browseTo(url) {
    // #mg-browse-list only exists after the first renderBrowse(); fall back to the
    // container for the initial load so the spinner has somewhere to live.
    const loadingInto = body.querySelector('#mg-browse-list') || body.querySelector('#mg-browse');
    loadingInto.innerHTML = '<div class="diff-msg">Loading…</div>';
    try {
      const data = await api('merge_list', { id, url: url || '' });
      m.browseUrl = data.url;
      if (!m.rootUrl) m.rootUrl = data.url;     // first call (no url) returns the repo root
      renderBrowse(data.entries);
    } catch (err) {
      (body.querySelector('#mg-browse-list') || body.querySelector('#mg-browse')).innerHTML =
        `<div class="diff-msg err">${esc(err.message)}</div>`;
    }
  }
  function renderBrowse(entries) {
    const atRoot = m.browseUrl === m.rootUrl;
    const rows = entries.map(e => e.kind === 'dir'
      ? `<div class="mg-brow dir" data-name="${esc(e.name)}">${icon('folder')}<span>${esc(e.name)}</span>
           <span class="mg-rev">r${e.rev ?? ''}</span></div>`
      : `<div class="mg-brow file">${icon('open')}<span class="dim">${esc(e.name)}</span></div>`).join('');
    body.querySelector('#mg-browse').innerHTML = `
      <div class="mg-crumb">${esc(m.browseUrl)}</div>
      <div class="mg-brow-tools">
        <button class="btn sm ghost" id="mg-up" ${atRoot ? 'disabled' : ''}>${icon('up')} Up</button>
        <button class="btn sm primary" id="mg-use">Use this folder as source</button>
      </div>
      <div class="mg-brow-list" id="mg-browse-list">${rows || '<div class="diff-msg">Empty.</div>'}</div>`;
    body.querySelector('#mg-up').onclick = () => {
      const u = m.browseUrl.replace(/\/[^/]+$/, '');
      browseTo(u.length >= m.rootUrl.length ? u : m.rootUrl);
    };
    body.querySelector('#mg-use').onclick = () => setSource(m.browseUrl);
    body.querySelectorAll('.mg-brow.dir').forEach(el =>
      el.onclick = () => browseTo(m.browseUrl + '/' + el.dataset.name));
  }

  function setSource(url) {
    m.source = url;
    m.revs.clear(); m.logEntries = []; m.logBefore = null; m.logDone = false; m.eligible = null;
    const ch = body.querySelector('#mg-chosen');
    if (ch) ch.innerHTML = `Source: <code>${esc(url)}</code>`;
    renderMode();
    syncActions();
  }

  // ----- mode panels ----------------------------------------------------
  async function loadMoreRevs() {
    const data = await api('merge_log', { id, url: m.source, limit: 100, before: m.logBefore ?? undefined });
    if (!data.entries.length) { m.logDone = true; }
    else {
      m.logEntries.push(...data.entries);
      m.logBefore = data.entries[data.entries.length - 1].rev;
      if (data.entries.length < data.limit) m.logDone = true;
    }
    renderMode();
  }
  async function loadEligible() {
    body.querySelector('#mg-modebody').innerHTML = '<div class="diff-msg">Checking eligible revisions…</div>';
    try {
      const data = await api('merge_eligible', { id, source: m.source, target: m.target });
      m.eligible = data.entries;
    } catch (err) { m.eligible = { error: err.message }; }
    renderMode();
  }
  function revRow(e, checkbox) {
    const checked = m.revs.has(e.rev) ? 'checked' : '';
    const box = checkbox ? `<input type="checkbox" data-rev="${e.rev}" ${checked}>` : '';
    return `<label class="mg-rev-row">${box}
      <span class="mg-rn">r${e.rev}</span>
      <span class="mg-auth">${esc(e.author)}</span>
      <span class="mg-date">${esc(fmtSvnDate(e.date))}</span>
      <span class="mg-msg">${esc((e.msg || '').split('\n')[0])}</span></label>`;
  }
  function renderMode() {
    body.querySelector('#mg-mode-tabs').querySelectorAll('[data-mode]').forEach(t =>
      t.classList.toggle('on', t.dataset.mode === m.mode));
    const mb = body.querySelector('#mg-modebody');
    if (!m.source) { mb.innerHTML = '<div class="diff-msg">Choose a source branch above first.</div>'; return; }

    if (m.mode === 'cherrypick') {
      const rows = m.logEntries.map(e => revRow(e, true)).join('');
      mb.innerHTML = `
        <div class="mg-hint">Pick the revision(s) to merge from <code>${esc(m.source)}</code>.
          <span id="mg-rev-count">${m.revs.size} selected</span></div>
        <div class="mg-rev-list">${rows || '<div class="diff-msg">Click “Load revisions”.</div>'}</div>
        <button class="btn sm ghost" id="mg-loadmore" ${m.logDone ? 'disabled' : ''}>
          ${m.logEntries.length ? (m.logDone ? 'No more' : 'Load more') : 'Load revisions'}</button>`;
      mb.querySelector('#mg-loadmore').onclick = async (ev) => {
        ev.target.disabled = true; await loadMoreRevs();
      };
      mb.querySelector('.mg-rev-list').onchange = e => {
        const cb = e.target.closest('[data-rev]'); if (!cb) return;
        const r = Number(cb.dataset.rev);
        cb.checked ? m.revs.add(r) : m.revs.delete(r);
        body.querySelector('#mg-rev-count').textContent = `${m.revs.size} selected`;
        syncActions();
      };
    } else if (m.mode === 'sync') {
      if (m.eligible === null) {
        mb.innerHTML = `<div class="mg-hint">Merge every revision on <code>${esc(m.source)}</code>
          not yet merged into the target.</div>
          <button class="btn sm ghost" id="mg-elig">Check eligible revisions</button>`;
        mb.querySelector('#mg-elig').onclick = loadEligible;
      } else if (m.eligible.error) {
        mb.innerHTML = `<div class="diff-msg err">${esc(m.eligible.error)}</div>`;
      } else if (!m.eligible.length) {
        mb.innerHTML = '<div class="diff-msg ok">Nothing to merge — already up to date with this source.</div>';
      } else {
        mb.innerHTML = `<div class="mg-hint">${m.eligible.length} eligible revision(s) will be merged:</div>
          <div class="mg-rev-list">${m.eligible.map(e => revRow(e, false)).join('')}</div>`;
      }
    } else { // reintegrate
      mb.innerHTML = `<div class="mg-hint">Reintegrate the whole branch
        <code>${esc(m.source)}</code> into the target (an automatic merge). Use this when a
        feature branch is finished and fully synced with its parent.</div>`;
    }
    syncActions();
  }

  // ----- options + preview/results -------------------------------------
  function renderResult(res) {
    const rp = body.querySelector('#mg-result');
    const c = res.conflicts || {};
    const hasC = (c.text || 0) + (c.tree || 0) + (c.prop || 0) > 0;
    const acts = (res.actions || []).map(a =>
      `<div class="mg-act"><span class="st st-${MERGE_CODE_CLASS[a.code] || 'unversioned'}">${esc(a.code)}</span>
        ${a.tree ? '<span class="badge rejected">tree</span>' : ''}
        <span class="mg-act-path">${esc(a.path)}</span></div>`).join('');
    rp.innerHTML = `
      <div class="mg-res-head">${res.actions.length} change(s)
        ${hasC ? `<span class="mg-conf">⚠ conflicts — text ${c.text||0}, tree ${c.tree||0}, prop ${c.prop||0}</span>`
               : '<span class="mg-ok">no conflicts</span>'}</div>
      <div class="mg-act-list">${acts || '<div class="diff-msg">No changes (nothing to merge).</div>'}</div>`;
    rp.classList.remove('hidden');
  }

  function syncActions() {
    const ready = !!m.source && (m.mode !== 'cherrypick' || m.revs.size > 0) && !m.busy;
    $('#mg-preview', overlay).disabled = !ready;
    $('#mg-apply', overlay).disabled = !ready;
  }

  function params() {
    return {
      id, mode: m.mode, source: m.source, target: m.target,
      accept: $('#mg-accept', overlay).value,
      depth: $('#mg-depth', overlay).value,
      recordOnly: $('#mg-record', overlay).checked ? 1 : 0,
      revs: m.mode === 'cherrypick' ? [...m.revs] : undefined,
    };
  }
  function setBusy(b, btn, label) {
    m.busy = b;
    overlay.querySelectorAll('button, input, select').forEach(x => x.disabled = b);
    if (b && btn) btn.innerHTML = `<span class="spinner"></span> ${label}`;
    if (!b) syncActions();
  }

  $('#mg-preview', overlay).onclick = async () => {
    const btn = $('#mg-preview', overlay);
    setBusy(true, btn, 'Previewing…');
    try {
      const res = await api('merge_preview', params());
      renderResult(res);
    } catch (err) { toast(err.message, 'err'); }
    finally { setBusy(false); btn.textContent = 'Preview (dry-run)'; }
  };

  $('#mg-apply', overlay).onclick = async () => {
    const p = params();
    const what = m.mode === 'cherrypick' ? `${m.revs.size} revision(s)`
      : m.mode === 'sync' ? 'all eligible revisions' : 'the whole branch';
    if (!confirm(`Merge ${what} from\n${m.source}\ninto ${m.target || state.project.name}?\n\n`
      + `Accept strategy: ${p.accept}. This modifies your working copy (review & commit after).`)) return;
    const btn = $('#mg-apply', overlay);
    setBusy(true, btn, 'Merging…');
    try {
      const res = await api('merge_apply', p);
      const c = res.conflicts || {};
      const conf = (c.text || 0) + (c.tree || 0) + (c.prop || 0);
      toast(`Merged ${res.actions.length} change(s)`
        + (conf ? ` — ${conf} conflict(s) to resolve in the list` : '') + '.', conf ? 'err' : 'ok');
      close();
      await refreshStatus();
    } catch (err) {
      setBusy(false); btn.textContent = 'Merge';
      toast(err.message, 'err');
    }
  };

  // ----- assemble the static shell, then wire dynamic bits --------------
  body.innerHTML = `
    <section class="mg-sec">
      <div class="mg-sec-h">1 · Source branch</div>
      <div class="mg-srctabs">
        <span class="mg-tab on" data-src="browse">Browse repository</span>
        <span class="mg-tab" data-src="url">Enter URL</span>
      </div>
      <div id="mg-browse" class="${m.sourceMode === 'browse' ? '' : 'hidden'}"></div>
      <div id="mg-urlbox" class="${m.sourceMode === 'url' ? '' : 'hidden'}">
        <input type="text" id="mg-url" class="prop-in" spellcheck="false"
          placeholder="https://svn…/branches/feature">
        <button class="btn sm primary" id="mg-url-set">Use this URL</button>
      </div>
      <div class="mg-chosen" id="mg-chosen">No source selected.</div>
    </section>
    <section class="mg-sec">
      <div class="mg-sec-h">2 · What to merge</div>
      <div class="mg-mode-tabs" id="mg-mode-tabs">
        <span class="mg-tab on" data-mode="cherrypick">Cherry-pick revisions</span>
        <span class="mg-tab" data-mode="sync">Sync (all eligible)</span>
        <span class="mg-tab" data-mode="reintegrate">Reintegrate</span>
      </div>
      <div id="mg-modebody" class="mg-modebody"></div>
    </section>
    <section class="mg-sec">
      <div class="mg-sec-h">3 · Options</div>
      <div class="mg-opts">
        <label for="mg-accept">On conflict</label>
        <select id="mg-accept" class="prop-in">${ACCEPT_OPTS.map(([v,t]) =>
          `<option value="${v}"${v===m.accept?' selected':''}>${esc(t)}</option>`).join('')}</select>
        <label for="mg-depth">Depth</label>
        <select id="mg-depth" class="prop-in">${DEPTH_OPTS.map(([v,t]) =>
          `<option value="${v}">${esc(t)}</option>`).join('')}</select>
        <span class="prop-lab">flags</span>
        <label class="chk"><input type="checkbox" id="mg-record">
          <span>record-only (mark merged without changing files)</span></label>
      </div>
    </section>
    <div class="mg-result hidden" id="mg-result"></div>`;

  // source tab toggle
  body.querySelector('.mg-srctabs').onclick = e => {
    const t = e.target.closest('[data-src]'); if (!t) return;
    m.sourceMode = t.dataset.src;
    body.querySelectorAll('.mg-srctabs .mg-tab').forEach(x => x.classList.toggle('on', x === t));
    body.querySelector('#mg-browse').classList.toggle('hidden', m.sourceMode !== 'browse');
    body.querySelector('#mg-urlbox').classList.toggle('hidden', m.sourceMode !== 'url');
  };
  body.querySelector('#mg-url-set').onclick = () => {
    const u = body.querySelector('#mg-url').value.trim();
    if (u) setSource(u);
  };
  // mode tabs
  body.querySelector('#mg-mode-tabs').onclick = e => {
    const t = e.target.closest('[data-mode]'); if (!t) return;
    m.mode = t.dataset.mode; renderMode();
  };

  browseTo('');     // load repo root into the browser
  renderMode();
  syncActions();
}

// ----------------------------------------------------------------- keyboard

// True when the file list owns keyboard focus (it has tabindex=0; clicking a row
// focuses it). Gates Ctrl+A so it doesn't hijack select-all in the diff panel.
function fileListFocused() {
  const fl = $('#file-list');
  return !!fl && (document.activeElement === fl || fl.contains(document.activeElement));
}

function selectAllFiles() {
  if (!state.visible.length) return;
  state.selPaths = new Set(state.visible.map(f => f.path));
  state.selAnchor = state.visible[0].path;
  applySelection();   // 2+ selected → review panel stays hidden, all rows highlight
}

function onKeydown(e) {
  if (e.target.matches('input, textarea')) return;
  if (document.querySelector('.modal-overlay')) return;  // a dialog owns the keyboard
  if (state.view !== 'project') return;

  // Ctrl/Cmd+A — select every file currently shown, but only when the file list
  // is focused (otherwise let the browser select-all normally).
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    if (fileListFocused()) { e.preventDefault(); selectAllFiles(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;  // leave other modified keys to the browser

  const f = state.selPath ? state.files.find(x => x.path === state.selPath) : null;
  switch (e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); stepFile(1); break;
    case 'k': case 'ArrowUp': e.preventDefault(); stepFile(-1); break;
    case 'a': if (f) { setReview(f, 'approved').then(() => stepFile(1)); } break;
    case 'r': if (f) openRejectModal(f); break;
    case 'Escape': closePanel(); break;
  }
}

// ------------------------------------------------------------------- render

function render() {
  const app = $('#app');
  if (state.view === 'project' && state.project) renderProject(app);
  else renderDashboard(app);
}

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/p=([a-f0-9]+)/);
  if (!m && state.view === 'project') { state.project = null; state.view = 'dashboard'; render(); }
});

boot().catch(err => toast(err.message, 'err'));
