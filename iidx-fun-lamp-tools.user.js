// ==UserScript==
// @name         iidx.fun lamp tools
// @namespace    iidx-fun-scripts
// @version      0.2.0
// @description  Compact views (squares / single-line), a lamp diff against an e-amusement CSV or Asphyxia JSON export, and lamp snapshots to track progress on iidx.fun clear tables.
// @match        https://www.iidx.fun/clear/*
// @match        https://iidx.fun/clear/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

/*
 * Data sources (all parsed locally, stored in userscript storage, never uploaded):
 *  - music_data.bin (IIDX data versions 33/34 tested). Several files can be loaded; they are merged
 *    (newer data version wins). Needed to resolve Asphyxia song IDs to titles.
 *  - e-amusement score CSV (…-iidx-sp.csv) or Asphyxia JSON export. One "source" at a time.
 *  - Snapshots: the site's own lamps on a page, saved at a point in time and compared later to show
 *    progress. Keyed by the site title, so a snapshot also works on other pages listing the same charts.
 *    Exported snapshot files (format "ifx-snapshot") load back through the same file button.
 *
 * Site title conventions: "Title" = ANOTHER, "Title[H]" = HYPER, "Title[A]" = ANOTHER, "Title†" = LEGGENDARIA.
 * Lamp values on the site's <select> (0..7) are the same as Asphyxia cArray values.
 */
(function () {
  'use strict';

  const blocks = document.getElementById('blocks');
  if (!blocks) return;

  const LAMPS = ['NO', 'F', 'AC', 'EC', 'NC', 'HC', 'EXHC', 'FC'];
  const CARD_CLASS = ['text-bg-light', 'text-bg-secondary', 'text-bg-primary', 'text-bg-success',
    'text-bg-info', 'text-bg-danger', 'text-bg-warning', 'text-bg-dark'];
  const CHART_NAMES = ['BEGINNER', 'NORMAL', 'HYPER', 'ANOTHER', 'LEGGENDARIA'];
  const CSV_CLEAR = {
    NOPLAY: 0, FAILED: 1, ASSISTCLEAR: 2, EASYCLEAR: 3, CLEAR: 4,
    HARDCLEAR: 5, EXHARDCLEAR: 6, FULLCOMBO: 7, FULLCOMBOCLEAR: 7,
  };
  const KEY = { settings: 'ifx.settings', music: 'ifx.music', source: 'ifx.source', snaps: 'ifx.snapshots' };

  // ---------- storage (GM_* in a userscript manager, localStorage fallback) ----------
  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem(k, JSON.stringify(v));
    },
    del(k) {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
      else localStorage.removeItem(k);
    },
  };

  const settings = Object.assign({ view: 'default', diffOn: true, mode: 'higher', snapId: null }, store.get(KEY.settings, {}));
  const saveSettings = () => store.set(KEY.settings, settings);

  // ---------- title normalisation / matching ----------
  const decoder = document.createElement('textarea');
  function decodeEntities(s) {
    if (!s.includes('&')) return s;
    decoder.innerHTML = s; // RCDATA: entities decoded, no markup executed
    return decoder.value;
  }
  function norm(s) {
    return decodeEntities(s).normalize('NFKC').toLowerCase()
      .replace(/[〜～~]/g, '~')
      .replace(/[‘’´`]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\bft\./g, 'feat.')
      .replace(/\s+/g, '');
  }
  // Fallback keys for the site's hand-typed titles: accents dropped, look-alike letters folded,
  // punctuation (incl. ・ vs ·) removed. "ÆTHER" is typed "ATHER" but "Iræ" is typed "Irae", so æ yields both.
  function looseKeys(s) {
    const t = decodeEntities(s).normalize('NFKC').normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // Latin combining accents only (keeps Japanese dakuten)
      .normalize('NFC').toLowerCase()
      .replace(/\bft\./g, 'feat.')
      .replace(/[ø∅0]/g, 'o')
      .replace(/[ʞꞰĸ]/g, 'k')
      .replace(/[^\p{L}\p{N}]/gu, '');
    return t.includes('æ') ? [t.replace(/æ/g, 'ae'), t.replace(/æ/g, 'a')] : [t];
  }
  const AMBIGUOUS = Symbol('ambiguous');
  // Ordered candidates of {title, chart} for a site title; chart is 0..4 (B,N,H,A,L).
  function candidates(raw) {
    const t = raw.trim();
    let m = t.match(/^(.+?)\[([BNHAL])\]$/);
    if (m) return [{ title: m[1], chart: 'BNHAL'.indexOf(m[2]) }];
    m = t.match(/^(.+)†$/);
    if (m) return [{ title: m[1], chart: 4 }, { title: t, chart: 3 }];
    return [{ title: t, chart: 3 }];
  }

  // ---------- parsers ----------
  function parseMusicData(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'IIDX') throw new Error('not a music_data.bin');
    const ver = dv.getUint32(4, true);
    const cnt = dv.getUint16(8, true);
    const ic = dv.getUint32(12, true);
    let idxSize = 0, base = 0, size = 0;
    for (const s of [4, 2]) {
      const rest = buf.byteLength - 16 - ic * s;
      if (rest > 0 && rest % cnt === 0 && rest / cnt >= 0x200) { idxSize = s; base = 16 + ic * s; size = rest / cnt; break; }
    }
    if (!idxSize) throw new Error(`unsupported music_data layout (version ${ver})`);
    const idx = (id) => (idxSize === 4 ? dv.getInt32(16 + id * 4, true) : dv.getInt16(16 + id * 2, true));
    // Locate the song-id field: the offset where index[id] points back at the entry itself.
    const probe = Math.min(cnt, 64);
    const offsets = [0x67C];
    for (let k = 0; k + 4 <= size; k += 4) if (k !== 0x67C) offsets.push(k);
    const idOff = offsets.find((k) => {
      for (let i = 0; i < probe; i++) {
        const id = dv.getUint32(base + i * size + k, true);
        if (id >= ic || idx(id) !== i) return false;
      }
      return true;
    });
    if (idOff === undefined) throw new Error(`could not locate song ids (version ${ver})`);
    const td = new TextDecoder('utf-16le');
    const songs = [];
    for (let i = 0; i < cnt; i++) {
      const o = base + i * size;
      const title = td.decode(new Uint8Array(buf, o, 0x100)).split('\0')[0];
      songs.push([dv.getUint32(o + idOff, true), title]);
    }
    return { ver, songs };
  }

  function csvRows(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function parseCsv(text) {
    const rows = csvRows(text);
    const head = rows[0] || [];
    const ti = head.indexOf('タイトル');
    const ci = CHART_NAMES.map((n) => head.indexOf(`${n} クリアタイプ`));
    if (ti < 0 || ci.every((i) => i < 0)) throw new Error('unrecognised CSV header');
    return rows.slice(1).filter((r) => r.length > ti && r[ti]).map((r) => [
      r[ti],
      ci.map((i) => (i < 0 ? 0 : CSV_CLEAR[(r[i] || '').replace(/\s+/g, '').toUpperCase()] || 0)),
    ]);
  }

  function parseAsphyxia(o) {
    if (!o || !Array.isArray(o.data)) throw new Error('unrecognised JSON (expected Asphyxia export)');
    return o.data.filter((e) => Array.isArray(e.cArray)).map((e) => [
      e.mid, e.cArray.slice(0, 5).map((v) => Math.max(0, Math.min(7, v | 0))),
    ]);
  }

  // ---------- index ----------
  let index = null;
  function buildIndex() {
    const music = store.get(KEY.music, null);
    const src = store.get(KEY.source, null);
    const known = new Set();
    const midTitle = new Map();
    const addKnown = (t) => known.add(norm(t));
    if (music) {
      for (const [mid, [t]] of Object.entries(music.songs)) { midTitle.set(+mid, t); addKnown(t); }
    }
    const lamps = new Map(); // strict title -> [B,N,H,A,L]
    let unresolved = 0;
    if (src) {
      for (const [key, arr] of src.entries) {
        const t = src.kind === 'json' ? midTitle.get(key) : key;
        if (t == null) { unresolved++; continue; }
        addKnown(t);
        const n = norm(t);
        const prev = lamps.get(n);
        lamps.set(n, prev ? prev.map((v, i) => Math.max(v, arr[i])) : arr.slice());
      }
    }
    // loose key -> strict key, or AMBIGUOUS when two different titles fold together
    const looseToStrict = new Map();
    const addLoose = (t) => {
      const n = norm(t);
      for (const k of looseKeys(t)) {
        const cur = looseToStrict.get(k);
        if (cur === undefined) looseToStrict.set(k, n);
        else if (cur !== n) looseToStrict.set(k, AMBIGUOUS);
      }
    };
    midTitle.forEach(addLoose);
    if (src && src.kind === 'csv') src.entries.forEach(([t]) => addLoose(t));
    index = { music, src, known, lamps, looseToStrict, unresolved };
  }

  // Resolve a site title to the strict key used by the index (exact first, then loose).
  function resolveTitle(title) {
    const n = norm(title);
    if (index.lamps.has(n) || index.known.has(n)) return n;
    for (const k of looseKeys(title)) {
      const s = index.looseToStrict.get(k);
      if (s !== undefined && s !== AMBIGUOUS) return s;
    }
    return null;
  }

  function siteLamp(col) {
    const a = col.querySelector('a[id^="title"]');
    const sel = col.querySelector('select[id^="selectLamp"]');
    const title = a ? a.textContent.trim() : '';
    let site = LAMPS.indexOf(col.getAttribute('name'));
    if (site < 0 && sel) site = +sel.value;
    return { title, sel, site };
  }

  function evalCol(col) {
    const { title, sel, site } = siteLamp(col);
    const res = { col, sel, title, site, state: 'none', src: null };
    if (!index.src) return res;
    const cands = candidates(title).map((c) => ({ ...c, key: resolveTitle(c.title) }));
    let srcLamp = null;
    for (const c of cands) {
      const l = c.key && index.lamps.get(c.key);
      if (l) { srcLamp = l[c.chart]; break; }
    }
    if (srcLamp === null) {
      if (col.querySelector('span[name=inf_sign]')) { res.state = 'inf'; return res; }
      if (cands.some((c) => c.key)) srcLamp = 0; // known song, never played
      else { res.state = 'unmatched'; return res; }
    }
    res.src = srcLamp;
    // NO PLAY in the source means "not played there", never a lower lamp.
    res.state = srcLamp > site ? 'higher' : srcLamp === site ? 'same' : srcLamp === 0 ? 'unplayed' : 'lower';
    return res;
  }

  // ---------- snapshots ----------
  // { id, name, createdAt, path, lamps: { siteTitle: 0..7 } }, newest first
  let snaps = store.get(KEY.snaps, []);
  const saveSnaps = () => store.set(KEY.snaps, snaps);
  const activeSnap = () => snaps.find((s) => s.id === settings.snapId) || null;

  function addSnapshot(s) {
    snaps = snaps.filter((x) => x.id !== s.id);
    snaps.push(s);
    snaps.sort((a, b) => b.createdAt - a.createdAt);
    saveSnaps();
    settings.snapId = s.id;
    saveSettings();
  }

  function takeSnapshot() {
    const lamps = new Map();
    for (const col of blocks.querySelectorAll('[name=songs] > .col')) {
      const { title, site } = siteLamp(col);
      if (title && site >= 0) lamps.set(title, Math.max(site, lamps.get(title) ?? 0));
    }
    if (!lamps.size) { lastMessages = ['No charts found on this page to snapshot']; render(); return; }
    const now = Date.now();
    const name = prompt(`Name for this snapshot (${lamps.size} charts):`, fmtDate(now));
    if (name === null) return;
    const s = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || fmtDate(now), createdAt: now, path: location.pathname,
      lamps: Object.fromEntries(lamps),
    };
    addSnapshot(s);
    lastMessages = [`Snapshot "${s.name}" saved (${lamps.size} charts)`];
    renderSnapSelect();
    render();
  }

  function parseSnapshot(o) {
    const s = o.snapshot;
    if (!s || !s.lamps || typeof s.lamps !== 'object') throw new Error('invalid snapshot file');
    const lamps = {};
    for (const [t, v] of Object.entries(s.lamps)) lamps[t] = Math.max(0, Math.min(7, v | 0));
    const createdAt = +s.createdAt || Date.now();
    return {
      id: String(s.id || createdAt.toString(36)), name: String(s.name || fmtDate(createdAt)),
      createdAt, path: String(s.path || ''), lamps,
    };
  }

  function exportSnapshot(s) {
    const json = JSON.stringify({ format: 'ifx-snapshot', version: 1, snapshot: s });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `iidx-fun-snapshot-${s.name.replace(/[^\w.-]+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- colours ----------
  const LAMP_COLOR = CARD_CLASS.map((c) => {
    const x = document.createElement('div');
    x.className = c;
    x.style.display = 'none';
    document.body.appendChild(x);
    const bg = getComputedStyle(x).backgroundColor;
    x.remove();
    const m = bg.match(/[\d.]+/g) || [255, 255, 255, 1];
    const a = m[3] === undefined ? 1 : +m[3];
    const mix = (v) => Math.round(+v * a + 255 * (1 - a));
    return `rgb(${mix(m[0])}, ${mix(m[1])}, ${mix(m[2])})`;
  });

  // ---------- styles ----------
  const css = `
#ifx-bar .btn-group .btn{min-width:4.5rem}
#ifx-summary b{color:#d4006a}
#ifx-summary a{cursor:pointer}
#ifx-unmatched{max-height:12rem;overflow:auto}
#ifx-snap-summary b{color:#198754}
#ifx-snap-summary a{cursor:pointer}
#ifx-snap-details{max-height:16rem;overflow:auto}
/* snapshot diamond: always drawn inside its own cell (never past the edge, where the next tier's
   label bar would cover it). Cards view: bottom-left corner, sized for visibility. */
.ifx-snap{position:absolute;bottom:7px;left:7px;width:10px;height:10px;transform:rotate(45deg);z-index:5;cursor:help;
  box-shadow:0 0 0 1px rgba(0,0,0,.6);box-sizing:border-box}
.ifx-snap.ifx-ring{background:#fff!important;border:3px solid var(--ifx-c)}
.ifx-dot{position:absolute;top:-5px;right:-5px;width:12px;height:12px;border-radius:50%;z-index:5;cursor:pointer;
  box-shadow:0 0 0 1px rgba(0,0,0,.6);box-sizing:border-box}
.ifx-dot.ifx-ring{background:#fff!important;border:3px solid var(--ifx-c);cursor:help}
.card.ifx-hi{outline:2px solid #d4006a;outline-offset:1px}
.card.ifx-lo{outline:2px dashed #6c757d;outline-offset:1px}
.ifx-pop{position:absolute;z-index:2000;min-width:12rem;max-width:18rem}
.ifx-pop .ifx-chip{display:inline-block;padding:0 .4em;border-radius:.25rem;color:#000;box-shadow:0 0 0 1px rgba(0,0,0,.25)}

/* shared compact behaviour: dropdown hidden until the cell is clicked */
body.ifx-compact #blocks [name=songs] select[id^=selectLamp]{display:none}
body.ifx-compact #blocks [name=songs] .card{cursor:pointer}
body.ifx-compact #blocks .card.ifx-open{z-index:1030}
body.ifx-compact #blocks .card.ifx-open select[id^=selectLamp]{display:block!important;position:absolute;
  top:calc(100% + 2px);left:0;z-index:1031;width:auto;min-width:5.5rem;box-shadow:0 2px 8px rgba(0,0,0,.3)}

/* squares */
body.ifx-v-squares #blocks>.row{margin-left:0;margin-right:0}
body.ifx-v-squares #blocks>.row>.col-md-12{display:flex;align-items:flex-start;gap:8px;padding:5px 0;
  border-bottom:1px solid var(--bs-border-color)}
body.ifx-v-squares #blocks [id^=bar_]{position:static!important;flex:0 0 5.5em;margin:0!important;padding:0 4px!important;
  text-align:left!important;font-size:12px;line-height:16px;background:none!important}
body.ifx-v-squares #blocks [name=songs]{flex:1;display:flex;flex-wrap:wrap;gap:3px;margin:0!important}
body.ifx-v-squares #blocks [name=songs]>.col{flex:0 0 auto!important;width:16px!important;padding:0!important;margin:0!important}
body.ifx-v-squares #blocks [name=songs]>.col>.card{width:16px;height:16px!important;border-radius:2px}
body.ifx-v-squares #blocks [name=songs] .card-body{display:none;padding:0!important}
body.ifx-v-squares #blocks .card.ifx-open>.card-body{display:block}
body.ifx-v-squares #blocks .card.ifx-open .card-title{display:none}
body.ifx-v-squares .ifx-dot{top:-4px;right:-4px;width:8px;height:8px}
body.ifx-v-squares .ifx-dot.ifx-ring{border-width:2px}
body.ifx-v-squares .ifx-snap{bottom:2px;left:2px;width:5px;height:5px}
body.ifx-v-squares .ifx-snap.ifx-ring{border-width:1.5px}
body.ifx-v-squares .card.ifx-hi,body.ifx-v-squares .card.ifx-lo{outline-offset:0}

/* single lines */
body.ifx-v-lines #blocks [name=songs] .card-body{padding:1px 6px!important;display:flex;align-items:center;min-width:0}
body.ifx-v-lines #blocks [name=songs] .card-title{margin:0;font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;flex:1;min-width:0}
/* lines: the diamond sits vertically centred at the left; while comparing, every line reserves that
   space so titles stay aligned and are never covered */
body.ifx-v-lines .ifx-snap{bottom:auto;top:50%;left:5px;width:6px;height:6px;margin-top:-3px}
body.ifx-v-lines .ifx-snap.ifx-ring{border-width:1.5px}
body.ifx-v-lines.ifx-snap-on #blocks [name=songs] .card-body{padding-left:16px!important}
`;
  // Squares are ordered by (current lamp, proposed lamp), both best first. The key lives in a data
  // attribute because the site's filters overwrite the cells' style attribute.
  let orderCss = '';
  for (let k = 0; k < 64; k++) orderCss += `body.ifx-v-squares #blocks [name=songs]>.col[data-ifx-o="${k}"]{order:${k}}
`;
  const style = document.createElement('style');
  style.textContent = css + orderCss;
  document.head.appendChild(style);

  // ---------- toolbar ----------
  const bar = document.createElement('div');
  bar.id = 'ifx-bar';
  bar.className = 'card my-2';
  bar.innerHTML = `
<div class="card-body p-2 small">
  <div class="d-flex flex-wrap align-items-center gap-2">
    <div class="btn-group btn-group-sm" role="group" aria-label="View">
      <input type="radio" class="btn-check" name="ifx-view" id="ifx-view-default" value="default">
      <label class="btn btn-outline-secondary" for="ifx-view-default">Cards</label>
      <input type="radio" class="btn-check" name="ifx-view" id="ifx-view-squares" value="squares">
      <label class="btn btn-outline-secondary" for="ifx-view-squares">Squares</label>
      <input type="radio" class="btn-check" name="ifx-view" id="ifx-view-lines" value="lines">
      <label class="btn btn-outline-secondary" for="ifx-view-lines">Lines</label>
    </div>
    <div class="vr"></div>
    <div class="form-check form-switch m-0">
      <input class="form-check-input" type="checkbox" id="ifx-diff-on">
      <label class="form-check-label" for="ifx-diff-on">Show diff</label>
    </div>
    <select id="ifx-mode" class="form-select form-select-sm w-auto">
      <option value="higher">Higher only</option>
      <option value="all">All differences</option>
    </select>
    <span id="ifx-summary"></span>
    <div class="ms-auto d-flex flex-wrap gap-1">
      <button type="button" id="ifx-load" class="btn btn-sm btn-outline-primary"
        title="e-amusement CSV, Asphyxia JSON, music_data.bin or exported snapshot (several at once is fine)">Load file…</button>
      <button type="button" id="ifx-clear-src" class="btn btn-sm btn-outline-secondary">Clear source</button>
      <button type="button" id="ifx-clear-music" class="btn btn-sm btn-outline-secondary">Clear music data</button>
      <input type="file" id="ifx-file" multiple accept=".csv,.json,.bin" hidden>
    </div>
  </div>
  <div class="d-flex flex-wrap align-items-center gap-2 mt-1">
    <select id="ifx-snap" class="form-select form-select-sm w-auto" title="Snapshot to compare the current lamps against"></select>
    <button type="button" id="ifx-snap-take" class="btn btn-sm btn-outline-success"
      title="Save the current lamps on this page so you can track progress later">Take snapshot</button>
    <button type="button" id="ifx-snap-export" class="btn btn-sm btn-outline-secondary" title="Download the selected snapshot">Export</button>
    <button type="button" id="ifx-snap-del" class="btn btn-sm btn-outline-secondary">Delete</button>
    <span id="ifx-snap-summary"></span>
  </div>
  <div id="ifx-snap-details" class="mt-1" hidden></div>
  <div id="ifx-status" class="text-secondary mt-1"></div>
  <div id="ifx-unmatched" class="mt-1 text-secondary" hidden></div>
</div>`;
  blocks.parentElement.insertBefore(bar, blocks);
  const $ = (id) => document.getElementById(id);

  $('ifx-view-' + settings.view).checked = true;
  $('ifx-diff-on').checked = settings.diffOn;
  $('ifx-mode').value = settings.mode;
  bar.querySelectorAll('input[name=ifx-view]').forEach((r) => r.addEventListener('change', () => {
    settings.view = r.value; saveSettings(); render();
  }));
  $('ifx-diff-on').addEventListener('change', (e) => { settings.diffOn = e.target.checked; saveSettings(); render(); });
  $('ifx-mode').addEventListener('change', (e) => { settings.mode = e.target.value; saveSettings(); render(); });
  $('ifx-load').addEventListener('click', () => $('ifx-file').click());
  $('ifx-file').addEventListener('change', (e) => { onFiles([...e.target.files]); e.target.value = ''; });
  $('ifx-clear-src').addEventListener('click', () => {
    if (!confirm('Forget the loaded CSV/JSON source?')) return;
    store.del(KEY.source); buildIndex(); render();
  });
  $('ifx-clear-music').addEventListener('click', () => {
    if (!confirm('Forget all loaded music_data.bin files?')) return;
    store.del(KEY.music); buildIndex(); render();
  });
  $('ifx-snap').addEventListener('change', (e) => {
    settings.snapId = e.target.value || null; saveSettings(); renderSnapSelect(); render();
  });
  $('ifx-snap-take').addEventListener('click', takeSnapshot);
  $('ifx-snap-export').addEventListener('click', () => { const s = activeSnap(); if (s) exportSnapshot(s); });
  $('ifx-snap-del').addEventListener('click', () => {
    const s = activeSnap();
    if (!s || !confirm(`Delete snapshot "${s.name}"?`)) return;
    snaps = snaps.filter((x) => x !== s);
    saveSnaps();
    settings.snapId = null; saveSettings();
    renderSnapSelect(); render();
  });

  function renderSnapSelect() {
    if (!activeSnap()) settings.snapId = null;
    const sel = $('ifx-snap');
    sel.innerHTML = `<option value="">${snaps.length ? 'Compare with snapshot…' : 'No snapshots'}</option>`
      + snaps.map((s) => {
        const extra = s.path && s.path !== location.pathname ? `, ${s.path}` : '';
        return `<option value="${esc(s.id)}">${esc(s.name)} (${Object.keys(s.lamps).length} charts${esc(extra)})</option>`;
      }).join('');
    sel.value = settings.snapId || '';
    $('ifx-snap-export').disabled = $('ifx-snap-del').disabled = !settings.snapId;
  }

  let lastMessages = [];
  async function onFiles(files) {
    lastMessages = [];
    // music_data first so a JSON loaded in the same batch resolves immediately
    const loaded = await Promise.all(files.map(async (f) => ({ f, buf: await f.arrayBuffer() })));
    const isBin = (b) => b.byteLength >= 4 && new TextDecoder('ascii').decode(new Uint8Array(b, 0, 4)) === 'IIDX';
    loaded.sort((a, b) => isBin(b.buf) - isBin(a.buf));
    for (const { f, buf } of loaded) {
      try {
        if (isBin(buf)) {
          const md = parseMusicData(buf);
          const music = store.get(KEY.music, null) || { files: [], songs: {} };
          for (const [mid, title] of md.songs) {
            const cur = music.songs[mid];
            if (!cur || cur[1] <= md.ver) music.songs[mid] = [title, md.ver];
          }
          music.files = music.files.filter((x) => !(x.ver === md.ver && x.count === md.songs.length));
          music.files.push({ name: f.name, ver: md.ver, count: md.songs.length });
          store.set(KEY.music, music);
          lastMessages.push(`${f.name}: music_data v${md.ver}, ${md.songs.length} songs merged`);
          continue;
        }
        let text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
        let kind, entries;
        if (text.trimStart().startsWith('{')) {
          const o = JSON.parse(text);
          if (o && o.format === 'ifx-snapshot') {
            const s = parseSnapshot(o);
            addSnapshot(s);
            lastMessages.push(`${f.name}: snapshot "${s.name}" loaded (${Object.keys(s.lamps).length} charts)`);
            continue;
          }
          kind = 'json'; entries = parseAsphyxia(o);
        } else {
          if (!text.includes('タイトル')) text = new TextDecoder('shift_jis').decode(buf);
          kind = 'csv'; entries = parseCsv(text);
        }
        store.set(KEY.source, { name: f.name, kind, loadedAt: Date.now(), entries });
        lastMessages.push(`${f.name}: ${entries.length} songs loaded as source`);
      } catch (err) {
        lastMessages.push(`${f.name}: ${err.message}`);
      }
    }
    buildIndex();
    renderSnapSelect();
    render();
  }

  // ---------- popups ----------
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  const chip = (l) => `<span class="ifx-chip" style="background:${LAMP_COLOR[l]}">${LAMPS[l]}</span>`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function openPop(dot, r) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'ifx-pop card shadow p-2 small';
    const higher = r.state === 'higher';
    pop.innerHTML = `
<div class="fw-bold text-truncate mb-1" title="${esc(r.title)}">${esc(r.title)}</div>
<div class="mb-2">Site ${chip(r.site)} → source ${chip(r.src)}</div>
${higher
    ? `<div class="d-flex gap-1 justify-content-end">
         <button type="button" class="btn btn-sm btn-secondary" data-act="cancel">Cancel</button>
         <button type="button" class="btn btn-sm btn-primary" data-act="apply">Replace</button>
       </div>`
    : `<div class="text-secondary mb-1">The source lamp is lower than the site's, so no quick replace.</div>
       <div class="d-flex justify-content-end"><button type="button" class="btn btn-sm btn-secondary" data-act="cancel">Close</button></div>`}
<div class="text-danger mt-1" data-msg hidden></div>`;
    document.body.appendChild(pop);
    const d = dot.getBoundingClientRect();
    const w = pop.offsetWidth;
    let left = d.right + 6;
    if (left + w > document.documentElement.clientWidth - 4) left = d.left - 6 - w;
    pop.style.left = `${Math.max(4, left) + scrollX}px`;
    pop.style.top = `${d.top + scrollY - 4}px`;
    pop.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closePop();
      if (act === 'apply') applyLamp(r, e.target);
    });
  }

  function applyLamp(r, btn) {
    const thisPop = pop;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    r.sel.value = String(r.src);
    // The site's delegated jQuery handler on document posts /selectlamp and updates the cell on success.
    r.sel.dispatchEvent(new Event('change', { bubbles: true }));
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (r.col.getAttribute('name') === LAMPS[r.src]) {
        clearInterval(timer);
        if (pop === thisPop) closePop();
      } else if (Date.now() - t0 > 8000) {
        clearInterval(timer);
        const msg = thisPop.querySelector('[data-msg]');
        msg.hidden = false;
        msg.textContent = 'Save not confirmed by the site. Check the cell or reload.';
        btn.textContent = 'Replace';
        btn.disabled = false;
      }
    }, 200);
  }

  // ---------- compact-view dropdown ----------
  let openCard = null;
  function closeOpen() { if (openCard) { openCard.classList.remove('ifx-open'); openCard = null; } }
  function openSelect(card) {
    if (openCard === card) { closeOpen(); return; }
    closeOpen();
    const sel = card.querySelector('select[id^="selectLamp"]');
    if (!sel) return;
    card.classList.add('ifx-open');
    openCard = card;
    const done = () => {
      sel.removeEventListener('change', done);
      sel.removeEventListener('blur', done);
      if (openCard === card) closeOpen();
    };
    sel.addEventListener('change', done);
    sel.addEventListener('blur', done);
    sel.focus();
    try { sel.showPicker(); } catch (e) { /* older browsers: the select is shown and focused */ }
  }

  window.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.ifx-pop')) return;
    const dot = t.closest('.ifx-dot');
    if (dot) {
      e.preventDefault(); e.stopPropagation();
      const r = results.get(dot.closest('.col'));
      if (r) openPop(dot, r);
      return;
    }
    closePop();
    if (settings.view === 'default') return;
    const card = t.closest('#blocks [name=songs] .card');
    if (!card) { closeOpen(); return; }
    if (t.closest('select')) return;
    if (e.altKey) return; // Alt+click keeps the site's chart-info dialog
    e.preventDefault(); e.stopPropagation();
    openSelect(card);
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeOpen(); } });

  // ---------- render ----------
  let results = new Map();
  function fmtDate(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function render() {
    closePop();
    const b = document.body.classList;
    b.toggle('ifx-compact', settings.view !== 'default');
    b.toggle('ifx-v-squares', settings.view === 'squares');
    b.toggle('ifx-v-lines', settings.view === 'lines');
    b.toggle('ifx-snap-on', !!activeSnap());

    blocks.querySelectorAll('.ifx-dot, .ifx-snap').forEach((d) => d.remove());
    blocks.querySelectorAll('.ifx-hi, .ifx-lo').forEach((c) => c.classList.remove('ifx-hi', 'ifx-lo'));

    results = new Map();
    const count = { higher: 0, lower: 0, same: 0, unplayed: 0, unmatched: [], inf: 0 };
    const show = settings.diffOn && index.src;
    const snap = activeSnap();
    const cmp = snap && { up: [], down: [], same: 0, missing: 0, then: Array(8).fill(0), now: Array(8).fill(0) };
    for (const col of blocks.querySelectorAll('[name=songs] > .col')) {
      const card = col.querySelector('.card');
      if (!card) continue;
      const r = evalCol(col);
      results.set(col, r);
      if (r.state === 'unmatched') count.unmatched.push(r.title);
      else if (r.state in count) count[r.state]++;

      let tip = `${r.title} · ${LAMPS[r.site] || '?'}`;
      if (r.src !== null && r.state !== 'same') tip += ` (source: ${LAMPS[r.src]})`;

      if (cmp && r.title && r.site >= 0) {
        if (!Object.hasOwn(snap.lamps, r.title)) cmp.missing++;
        else {
          const old = snap.lamps[r.title];
          cmp.then[old]++;
          cmp.now[r.site]++;
          if (old === r.site) cmp.same++;
          else {
            const up = r.site > old;
            (up ? cmp.up : cmp.down).push({ title: r.title, from: old, to: r.site });
            tip += ` (snapshot: ${LAMPS[old]})`;
            const m = document.createElement('span');
            m.className = 'ifx-snap' + (up ? '' : ' ifx-ring');
            m.style.setProperty('--ifx-c', LAMP_COLOR[old]);
            m.style.background = LAMP_COLOR[old];
            m.title = `${up ? 'Improved' : 'Lower'} since snapshot: ${LAMPS[old]} → ${LAMPS[r.site]}`;
            card.appendChild(m);
          }
        }
      }
      if (settings.view !== 'default') card.title = tip; else card.removeAttribute('title');

      const mark = show && (r.state === 'higher' || (r.state === 'lower' && settings.mode === 'all'));
      const site = Math.max(0, r.site);
      const proposed = mark ? r.src : site;
      col.dataset.ifxO = String((7 - site) * 8 + (7 - proposed));
      if (!mark) continue;
      card.classList.add(r.state === 'higher' ? 'ifx-hi' : 'ifx-lo');
      const dot = document.createElement('span');
      dot.className = 'ifx-dot' + (r.state === 'lower' ? ' ifx-ring' : '');
      dot.style.setProperty('--ifx-c', LAMP_COLOR[r.src]);
      dot.style.background = LAMP_COLOR[r.src];
      dot.title = `${r.state === 'higher' ? 'Higher' : 'Lower'} in source: ${LAMPS[r.src]}`;
      card.appendChild(dot);
    }

    // status line
    const m = index.music;
    const parts = [];
    parts.push(m
      ? `music_data: ${m.files.map((f) => `v${f.ver} (${f.count})`).join(' + ')} → ${Object.keys(m.songs).length} songs`
      : 'music_data: none loaded');
    if (index.src) {
      parts.push(`source: ${index.src.name} (${index.src.kind.toUpperCase()}, ${index.src.entries.length} songs, loaded ${fmtDate(index.src.loadedAt)})`);
      if (index.unresolved) parts.push(`${index.unresolved} song IDs not in music_data — load a newer music_data.bin`);
    } else {
      parts.push('source: none — load an e-amusement CSV or Asphyxia JSON');
    }
    $('ifx-status').textContent = [...lastMessages, parts.join(' · ')].join(' | ');

    renderSnapSummary(snap, cmp);

    const sum = $('ifx-summary');
    const um = $('ifx-unmatched');
    if (!index.src) { sum.innerHTML = ''; um.hidden = true; return; }
    sum.innerHTML = `This page: <b>${count.higher}</b> higher · ${count.lower} lower · ${count.same} same`
      + (count.unmatched.length ? ` · <a class="link-secondary" id="ifx-um-toggle">${count.unmatched.length} unmatched</a>` : '')
      + (count.unplayed ? ` · ${count.unplayed} not played in source` : '')
      + (count.inf ? ` · ${count.inf} INF-only skipped` : '');
    um.textContent = `Unmatched titles: ${count.unmatched.join(' / ')}`;
    const tg = $('ifx-um-toggle');
    if (tg) tg.addEventListener('click', () => { um.hidden = !um.hidden; });
    else um.hidden = true;
  }

  function renderSnapSummary(snap, cmp) {
    const ss = $('ifx-snap-summary');
    const sd = $('ifx-snap-details');
    if (!cmp) { ss.innerHTML = ''; sd.innerHTML = ''; sd.hidden = true; return; }
    ss.innerHTML = `Since snapshot: <b>${cmp.up.length}</b> improved · ${cmp.down.length} lower · ${cmp.same} unchanged`
      + (cmp.missing ? ` · ${cmp.missing} not in snapshot` : '')
      + ` · <a class="link-secondary" id="ifx-snap-toggle">${sd.hidden ? 'details' : 'hide details'}</a>`;
    $('ifx-snap-toggle').addEventListener('click', (e) => {
      sd.hidden = !sd.hidden;
      e.target.textContent = sd.hidden ? 'details' : 'hide details';
    });
    const dist = [];
    for (let l = 7; l >= 0; l--) {
      if (!cmp.then[l] && !cmp.now[l]) continue;
      const d = cmp.now[l] - cmp.then[l];
      dist.push(`<span class="me-2 text-nowrap">${chip(l)} ${cmp.then[l]} → ${cmp.now[l]}${d ? ` (${d > 0 ? '+' : ''}${d})` : ''}</span>`);
    }
    const list = (arr) => arr.sort((a, b) => b.to - a.to || b.from - a.from || a.title.localeCompare(b.title))
      .map((x) => `<div>${chip(x.from)} → ${chip(x.to)} ${esc(x.title)}</div>`).join('');
    sd.innerHTML = `<div class="text-secondary mb-1">"${esc(snap.name)}" taken ${fmtDate(snap.createdAt)}`
      + (snap.path ? ` on ${esc(snap.path)}` : '') + '</div>'
      + `<div class="mb-1">Lamps on this page, snapshot → now: ${dist.join('') || 'no charts in common'}</div>`
      + (cmp.up.length ? `<div class="fw-bold">Improved</div>${list(cmp.up)}` : '<div class="text-secondary">No improvements yet.</div>')
      + (cmp.down.length ? `<div class="fw-bold mt-1">Lower than snapshot</div>${list(cmp.down)}` : '');
  }

  // Re-render when the site confirms a lamp change (it rewrites the column's name attribute).
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  }).observe(blocks, { subtree: true, attributes: true, attributeFilter: ['name'] });

  buildIndex();
  renderSnapSelect();
  render();
})();
