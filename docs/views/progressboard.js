'use strict';

// views/progressboard.js — 進捗タブ（便5・build 34・独立タブ・SPEC_V3 §5・PROGRESS_TAB_UI_DRAFT）。
// 進捗リスト（機能＞実装単位＞CASEグループの3層）＋作業順序リスト（=CASEグループ・チェックリスト）。
// 表示は全て program.loadProgressBoard() の機械導出（手書きしない）。読み取り専用（正本へ書かない）。

import { registerView } from '../registry.js';
import { h } from './shared.js';

const PB_STATE = {
  done:    { name: '実装済み',       cls: 'pb-green' },
  running: { name: '実装中',         cls: 'pb-blue' },
  stopped: { name: '停止',           cls: 'pb-red' },
  waiting: { name: '出発待ち',       cls: 'pb-yellow' },
  unappr:  { name: '未実装（未承認）', cls: 'pb-gray' },
  unknown: { name: '不明',           cls: 'pb-unknown' },
};
const PB_WORK_MARK = {
  done:    { glyph: '☑' }, running: { glyph: '▶' }, ready: { glyph: '☐' }, todo: { glyph: '☐' }, blocked: { glyph: '⏸' },
};

let currentCtx = null;
let root, noteEl, distEl, searchEl, listEl, workEl, popupBack, popupEl, miniEl;
let data = null;
let expanded = new Set();

function create(ctx) {
  currentCtx = ctx;
  root = h('div', 'pb-root');
  const toolbar = h('div', 'pb-toolbar');
  searchEl = h('input', 'field pb-search');
  searchEl.type = 'search'; searchEl.placeholder = '機能・実装単位ID・名称で検索';
  searchEl.oninput = () => { if (data) render(); };
  toolbar.appendChild(searchEl);
  distEl = h('div', 'pb-dist');
  toolbar.appendChild(distEl);
  root.appendChild(toolbar);
  noteEl = h('p', 'pb-note view-hint');
  root.appendChild(noteEl);

  const progTitle = h('h3', 'pb-col-title');
  progTitle.appendChild(h('span', null, '進捗リスト'));
  progTitle.appendChild(h('span', 'pb-col-sub', '状態の地図（機能＞実装単位＞CASEグループ）'));
  root.appendChild(progTitle);
  listEl = h('div', 'pb-list');
  listEl.textContent = '読み込み中…';
  root.appendChild(listEl);

  const workTitle = h('h3', 'pb-col-title');
  workTitle.appendChild(h('span', null, '作業順序リスト'));
  workTitle.appendChild(h('span', 'pb-col-sub', '運転計画（=CASEグループ・完了は保持）'));
  root.appendChild(workTitle);
  workEl = h('div', 'pb-worklist');
  root.appendChild(workEl);

  // ポップアップ（詳細7区画）＋ミニ
  popupBack = h('div', 'pb-popup-backdrop');
  popupBack.hidden = true;
  popupBack.onclick = (e) => { if (e.target === popupBack) popupBack.hidden = true; };
  popupEl = h('div', 'pb-popup');
  popupBack.appendChild(popupEl);
  root.appendChild(popupBack);
  miniEl = h('div', 'pb-mini');
  miniEl.hidden = true;
  root.appendChild(miniEl);
  document.addEventListener('click', (e) => {
    if (miniEl && !miniEl.hidden && !miniEl.contains(e.target) && !(e.target.classList && e.target.classList.contains('pb-state-chip'))) miniEl.hidden = true;
  });
  return root;
}

async function onShow(ctx) {
  currentCtx = ctx;
  if (!data) await load(ctx);
}

async function load(ctx) {
  listEl.textContent = '読み込み中…';
  try {
    data = await ctx.program.loadProgressBoard();
    expanded = new Set(data.features.map((f) => 'F:' + f.code));
    render();
  } catch (e) {
    listEl.textContent = '進捗の読み込みに失敗: ' + (e.message || e);
  }
}

function meta(k) { return PB_STATE[k] || PB_STATE.unknown; }

function render() {
  if (!data) return;
  noteEl.textContent = '機能' + data.counts.features + '・実装単位' + data.counts.units + '・CASEグループ' + data.counts.groups
    + '（源: registry' + (data.sources.registryOk ? '✓' : '×') + '・SC-F ' + data.sources.scenarios + '/' + data.sources.scenariosReferenced + '）'
    + (data.sources.testStatus ? '' : '・test_status不在=テスト色なし');
  distEl.innerHTML = '';
  for (const k of ['done', 'running', 'stopped', 'waiting', 'unappr', 'unknown']) {
    const n = data.dist[k] || 0; if (n === 0) continue;
    distEl.appendChild(h('span', 'pb-dist-chip ' + meta(k).cls, meta(k).name + ' ' + n));
  }
  renderList();
  renderWork();
}

function stateChip(colorKey, ctxObj) {
  const chip = h('span', 'pb-state-chip ' + meta(colorKey).cls, meta(colorKey).name);
  chip.onclick = (e) => { e.stopPropagation(); openMini(colorKey, ctxObj, chip); };
  return chip;
}
function bar(n, m) {
  const wrap = h('span', 'pb-metric');
  wrap.appendChild(h('span', 'pb-metric-label', '実 ' + n + '/' + m));
  const b = h('span', 'pb-bar');
  const fill = h('span', 'pb-bar-fill');
  fill.style.width = (m > 0 ? Math.round((n / m) * 100) : 0) + '%';
  b.appendChild(fill); wrap.appendChild(b);
  return wrap;
}
function complMark(c) {
  const span = h('span', 'pb-metric');
  if (c && c.approved) span.appendChild(h('span', 'pb-compl is-ok', '完◯'));
  else if (c && c.present) span.appendChild(h('span', 'pb-compl', '完—'));
  else span.appendChild(h('span', 'pb-compl is-none', '完—'));
  return span;
}
function linkIcons(featureCode, completion) {
  const wrap = h('span', 'pb-links');
  const isReal = featureCode && !String(featureCode).startsWith('__');
  const scen = h('span', 'pb-icon' + (isReal ? '' : ' is-dim'), '📋');
  if (isReal) scen.onclick = (e) => { e.stopPropagation(); jumpScenario(featureCode); };
  wrap.appendChild(scen);
  const compl = h('span', 'pb-icon' + (completion && completion.present ? '' : ' is-dim'), '🏁');
  if (completion && completion.present && completion.file) compl.onclick = (e) => { e.stopPropagation(); jumpCompletion(completion.file); };
  wrap.appendChild(compl);
  wrap.appendChild(h('span', 'pb-icon is-dim', '✅'));
  return wrap;
}
function classCls(c) {
  if (c === '正常系') return 'class-normal';
  if (c === '境界値') return 'class-boundary';
  if (c === '状態依存') return 'class-state';
  if (c === '優雅な失敗') return 'class-graceful';
  return 'class-other';
}
function ctxOf(u) { return { scenN: u.scenN, scenM: u.scenM, state: u.state, ready: u.ready, golden: u.golden, deps: u.deps, mini: u.mini }; }

function renderList() {
  listEl.innerHTML = '';
  const q = (searchEl.value || '').trim().toLowerCase();
  const match = (f) => !q || (f.code + ' ' + f.name).toLowerCase().includes(q) || f.units.some((u) => (u.id + ' ' + u.name).toLowerCase().includes(q));
  let shown = 0;
  for (const f of data.features) {
    if (!match(f)) continue;
    shown++;
    const fExp = expanded.has('F:' + f.code);
    const frow = h('div', 'pb-row pb-row-feature ' + meta(f.color).cls);
    frow.appendChild(h('span', 'pb-toggle', fExp ? '▼' : '▶'));
    frow.appendChild(h('span', 'pb-row-name', (f.synthetic ? '' : f.code + ' ') + f.name.replace(/^SC-F_[A-Z0-9_]+\s*/, '')));
    const fm = h('span', 'pb-row-metrics');
    fm.appendChild(h('span', 'pb-metric', '承 ' + f.scenN + '/' + f.scenM));
    fm.appendChild(complMark(f.completion));
    fm.appendChild(bar(f.implDone, f.implTotal));
    frow.appendChild(fm);
    frow.appendChild(linkIcons(f.code, f.completion));
    frow.onclick = () => { if (fExp) expanded.delete('F:' + f.code); else expanded.add('F:' + f.code); renderList(); };
    listEl.appendChild(frow);
    if (!fExp) continue;
    for (const u of f.units) {
      const uExp = expanded.has('U:' + f.code + ':' + u.id);
      const urow = h('div', 'pb-row pb-row-unit ' + meta(u.color).cls);
      const utog = h('span', 'pb-toggle', u.groups.length ? (uExp ? '▼' : '▶') : '·');
      urow.appendChild(utog);
      urow.appendChild(stateChip(u.color, ctxOf(u)));
      const uname = h('span', 'pb-row-name');
      uname.appendChild(h('span', 'pb-unit-id', u.id));
      uname.appendChild(h('span', 'pb-unit-kind', u.kind));
      uname.appendChild(document.createTextNode(' ' + u.name));
      if (u.ready) uname.appendChild(h('span', 'pb-ready-badge', '出発可'));
      urow.appendChild(uname);
      const um = h('span', 'pb-row-metrics');
      um.appendChild(h('span', 'pb-metric', '承 ' + u.scenN + '/' + u.scenM));
      um.appendChild(complMark(u.completion));
      um.appendChild(bar(u.implDone, u.implTotal));
      urow.appendChild(um);
      urow.appendChild(linkIcons(f.code, u.completion));
      urow.onclick = (e) => {
        if (e.target === utog && u.groups.length) { if (uExp) expanded.delete('U:' + f.code + ':' + u.id); else expanded.add('U:' + f.code + ':' + u.id); renderList(); }
        else openPopup(u, f);
      };
      listEl.appendChild(urow);
      if (!uExp) continue;
      for (const g of u.groups) {
        const grow = h('div', 'pb-row pb-row-group ' + meta(g.color).cls);
        grow.appendChild(h('span', 'pb-toggle', ''));
        const gname = h('span', 'pb-row-name');
        if (g.classification) gname.appendChild(h('span', 'chip chip-case-class ' + classCls(g.classification), g.classification));
        gname.appendChild(document.createTextNode(' ' + g.heading.replace(/（.*$/, '')));
        grow.appendChild(gname);
        const gm = h('span', 'pb-row-metrics');
        gm.appendChild(h('span', 'pb-metric', '承 ' + g.scenN + '/' + g.scenM));
        gm.appendChild(bar(g.implDone, g.implTotal));
        gm.appendChild(h('span', 'pb-state-text ' + meta(g.color).cls, meta(g.color).name));
        grow.appendChild(gm);
        const jump = h('span', 'pb-jump', '↔');
        jump.onclick = (e) => { e.stopPropagation(); highlightWork(g.id); };
        grow.appendChild(jump);
        listEl.appendChild(grow);
      }
    }
  }
  if (shown === 0) listEl.appendChild(h('p', 'view-hint', '該当なし。'));
}

function renderWork() {
  workEl.innerHTML = '';
  const q = (searchEl.value || '').trim().toLowerCase();
  for (const w of data.workItems) {
    if (q && !(w.unitId + ' ' + w.heading + ' ' + w.featureName).toLowerCase().includes(q)) continue;
    const mk = PB_WORK_MARK[w.marker] || PB_WORK_MARK.todo;
    const row = h('div', 'pb-work-row pb-work-' + w.marker + (w.marker === 'ready' ? ' is-ready' : '') + (w.marker === 'done' ? ' is-done' : ''));
    row.dataset.gid = cssId(w.groupId);
    row.appendChild(h('span', 'pb-work-order', '#' + w.order));
    row.appendChild(h('span', 'pb-work-mark', mk.glyph));
    const name = h('span', 'pb-work-name');
    name.appendChild(h('span', 'pb-work-unit', w.unitId));
    name.appendChild(document.createTextNode(' ' + w.heading.replace(/（.*$/, '')));
    row.appendChild(name);
    if (w.marker === 'blocked' && w.blockReason) row.appendChild(h('span', 'pb-block-chip', '⏸ ' + w.blockReason));
    if (w.marker === 'ready') row.appendChild(h('span', 'pb-ready-badge', '出発可'));
    const jump = h('span', 'pb-jump', '↔');
    jump.onclick = (e) => { e.stopPropagation(); highlightProgress(w.featureCode, w.unitId); };
    row.appendChild(jump);
    workEl.appendChild(row);
  }
}

function cssId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
function highlightWork(groupId) {
  const t = workEl.querySelector('[data-gid="' + cssId(groupId) + '"]');
  if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.add('pb-flash'); setTimeout(() => t.classList.remove('pb-flash'), 1200); }
}
function highlightProgress(featureCode, unitId) {
  expanded.add('F:' + featureCode);
  renderList();
  const rows = listEl.querySelectorAll('.pb-row-unit');
  for (const r of rows) { if (r.textContent.indexOf(unitId) >= 0) { r.scrollIntoView({ block: 'center', behavior: 'smooth' }); r.classList.add('pb-flash'); setTimeout(() => r.classList.remove('pb-flash'), 1200); break; } }
}

function openPopup(u, f) {
  popupEl.innerHTML = '';
  const head = h('div', 'pb-popup-head');
  head.appendChild(h('span', 'pb-popup-id', u.id));
  head.appendChild(h('span', 'pb-state-chip ' + meta(u.color).cls, meta(u.color).name));
  head.appendChild(h('span', 'pb-popup-kind', u.kind + '・' + (u.stage || '—')));
  const close = h('button', 'pb-popup-close', '×');
  close.onclick = () => { popupBack.hidden = true; };
  head.appendChild(close);
  popupEl.appendChild(head);
  popupEl.appendChild(h('div', 'pb-popup-name', u.name));
  const sec = (title, fn) => { const s = h('div', 'pb-sec'); s.appendChild(h('div', 'pb-sec-title', title)); const body = h('div', 'pb-sec-body'); fn(body); if (body.childNodes.length) { s.appendChild(body); popupEl.appendChild(s); } };

  sec('承認', (b) => {
    b.appendChild(h('div', 'pb-kv', 'シナリオ承認: ' + u.scenN + '/' + u.scenM));
    const c = u.completion;
    b.appendChild(h('div', 'pb-kv', '完成定義: ' + (c && c.approved ? '◯（承認済み）' : (c && c.present ? '—（あり・承認チェック未整備）' : '—（未作成）'))));
    if (f && !f.synthetic) { const link = h('button', 'pb-link-btn', '📋 シナリオを開く'); link.onclick = () => { popupBack.hidden = true; jumpScenario(f.code); }; b.appendChild(link); }
  });
  sec('実装', (b) => {
    b.appendChild(h('div', 'pb-kv', '実装被覆: ' + u.implDone + '/' + u.implTotal + '（実装単位状態=' + u.state + '）'));
    if (u.golden && u.golden !== 'なし') b.appendChild(h('div', 'pb-kv', 'GOLDEN: ' + String(u.golden).slice(0, 80)));
    if (u.evidence) b.appendChild(h('div', 'pb-kv pb-kv-dim', '根拠: ' + String(u.evidence).slice(0, 160)));
  });
  const unmet = (u.deps || []).filter((d) => d.state !== '完了');
  if (unmet.length) sec('待ち（入）', (b) => {
    for (const d of unmet) b.appendChild(h('div', 'pb-edge', '[依存] ' + d.id + (d.name ? '（' + String(d.name).slice(0, 20) + '）' : '') + ' → ' + (d.state || '—') + '解消待ち'));
    b.appendChild(h('div', 'pb-kv-dim', '※ [種類｜動態]チップは◆辺スキーマ確定後'));
  });
  if ((u.dependents || []).length) sec('解除（出）', (b) => {
    b.appendChild(h('div', 'pb-edge', u.dependents.slice(0, 6).join('・') + (u.dependents.length > 6 ? ' 他' + (u.dependents.length - 6) + '件' : '')));
  });
  sec('作業', (b) => {
    b.appendChild(h('div', 'pb-kv', '段階: ' + (u.stage || '—') + (u.ready ? '・出発可（依存充足=registry frontier）' : '')));
    if (u.notes) b.appendChild(h('div', 'pb-kv-dim', String(u.notes).slice(0, 160)));
  });
  if (u.groups.length) sec('CASEグループ', (b) => {
    for (const g of u.groups) {
      const gr = h('div', 'pb-popup-group');
      gr.appendChild(h('span', 'pb-state-text ' + meta(g.color).cls, meta(g.color).name));
      gr.appendChild(h('span', 'pb-popup-group-name', ' ' + g.heading.replace(/（.*$/, '') + '  承' + g.scenN + '/' + g.scenM + ' 実' + g.implDone + '/' + g.implTotal));
      b.appendChild(gr);
      const cs = h('div', 'pb-popup-cases');
      for (const c of g.cases) cs.appendChild(h('span', 'pb-case', (c.checked ? '✓' : '☐') + ' ' + c.caseId + (c.implState === 'done' ? ' ✅' : '')));
      b.appendChild(cs);
    }
  });
  popupBack.hidden = false;
}

function openMini(colorKey, ctxObj, anchor) {
  const m = (ctxObj && ctxObj.mini) || {};
  miniEl.innerHTML = '';
  miniEl.appendChild(h('div', 'pb-mini-state ' + meta(colorKey).cls, meta(colorKey).name));
  if (m.why) miniEl.appendChild(h('div', 'pb-mini-why', 'なぜ: ' + m.why));
  if (m.next) miniEl.appendChild(h('div', 'pb-mini-next', '変わる: ' + m.next));
  for (const dl of (m.depLines || [])) miniEl.appendChild(h('div', 'pb-mini-edge', dl));
  const r = anchor.getBoundingClientRect();
  miniEl.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  miniEl.style.top = (r.bottom + 4) + 'px';
  miniEl.hidden = false;
}

// 対象ページ直行（◆5=リンク割り振りはSheet/Library確定後・本便はSC-Fへ直行のみ確定）。
function jumpScenario(code) {
  if (!currentCtx || !currentCtx.openSheet) return;
  currentCtx.openSheet('scenario', 'Features/SC-F_' + code + '.md');
}
function jumpCompletion(file) {
  if (!currentCtx || !currentCtx.openSheet) return;
  currentCtx.openSheet('completion', file);
}

registerView({ id: 'progressboard', tabLabel: '進捗', create, onShow });
