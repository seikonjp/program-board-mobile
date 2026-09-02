'use strict';

// views/progressboard.js — 進捗タブ（便5・build 34／便10+11・build 41・独立タブ・SPEC_V3 §5/§5f/§5g）。
// 3切替: 状態マップ（機能＞実装単位＞CASEグループ＋作業順序リスト）／フロー俯瞰（全数配置・放置ゼロ）／
//         直近の詳細（第一線の背骨→並走枠→将来領域）。状態マップは program.loadProgressBoard() の機械導出。
// フロー俯瞰・直近の詳細は、ビルド時に焼き込んだ静的ペイロード（program.loadFlowOverview/loadFlowView）を読むだけ
//   （Mac版と同じ純関数の機械導出＝手書きしない・245KBのcensus生データはモバイルへ運ばない）。読み取り専用。
//   静的のため、台帳更新後は scripts/build-flow.cjs を再実行して反映（builtAt に焼き込み時刻を明示）。

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

// 作業フロービュー（便10+11・Mac版と同一語彙）。状態6色＋シナリオ状態チップの色分け。凡例に新記号は増やさない。
const FLOW_STATE = {
  startable:  { name: '出発可能',     cls: 'flow-green' },
  waiting:    { name: '待ち',         cls: 'flow-gray' },
  review:     { name: '検討中・調査', cls: 'flow-yellow' },
  inprogress: { name: '進行中',       cls: 'flow-blue' },
  declared:   { name: '予定',         cls: 'flow-declared' },
  done:       { name: '完了',         cls: 'flow-green' },
  unknown:    { name: '不明',         cls: 'flow-unknown' },
};
const FLOW_STATE_ORDER = ['startable', 'waiting', 'review', 'inprogress', 'declared', 'done', 'unknown'];
const SCEN_CLS = { 'scen-approved': 'scen-approved', 'scen-progress': 'scen-progress', 'scen-created': 'scen-created', 'scen-legacy': 'scen-legacy', 'scen-none': 'scen-none', 'scen-na': 'scen-na' };

let currentCtx = null;
let root, noteEl, distEl, searchEl, listEl, workEl, popupBack, popupEl, miniEl;
let mapWrap, overviewWrap, flowWrap;
let data = null;
let expanded = new Set();
let pbview = 'map';
let flowData = null;      // 直近の詳細（/data/flow-view.json）
let overviewData = null;  // フロー俯瞰（/data/flow-overview.json）
let stageView = '第1弾';  // 弾ビュー（既定=第1弾・2026-08-15基幹回付①）|'全弾'
let sphereView = 'all';   // 第1弾サブフィルタ=通常/ゲーム/共通（2026-08-17基幹回付）|'normal'|'game'|'shared'
let decisionsEl = null;   // 決定待ち（板ID R4-4・2026-09-02）＝進捗タブ上部の折りたたみ
let decisionsLoaded = false;

// 弾ラベルの「第1弾」判定（2026-09-02）。`第1弾` / `第1弾追加` など前方一致で1つに寄せる（Mac板 public/app.js と同型）。
const isFirstStage = (stage) => /^第1弾/.test(String(stage || ''));

// 錨チップ（板ID R4-4・2026-09-02）＝UNIT_REGISTRY の anchors（要件REQ／機能PL_／表紙）を行に小さく出す。
//   登記に無い件は **1つも出さない**（推測で作らない）。title に ID を全部並べる。
//   表紙（anchors.cover）は機能チップの title に「表紙＝<パス>」として添える（ローカルパスなので文字表示のみ）。
function flowAnchorChips(meta, anchors) {
  if (!meta || !anchors) return;
  const req = anchors.req || [];
  const feature = anchors.feature || [];
  if (req.length) {
    const c = h('span', 'flow-anchor-chip', '要件' + req.length);
    c.title = '要件: ' + req.join(' / ');
    meta.appendChild(c);
  }
  if (feature.length) {
    const c = h('span', 'flow-anchor-chip', '機能' + feature.length);
    c.title = '機能: ' + feature.join(' / ') + (anchors.cover ? '\n表紙＝' + anchors.cover : '');
    meta.appendChild(c);
  }
}


function create(ctx) {
  currentCtx = ctx;
  root = h('div', 'pb-root');

  // 進捗まわりの切替（状態マップ／フロー俯瞰／直近の詳細）——Mac版に揃える。
  const switchBar = h('div', 'pb-switch');
  for (const [key, label] of [['map', '状態マップ'], ['overview', 'フロー俯瞰'], ['flow', '直近の詳細']]) {
    const b = h('button', 'pb-switch-btn' + (key === pbview ? ' is-active' : ''), label);
    b.dataset.pbview = key;
    b.onclick = () => setPbView(key);
    switchBar.appendChild(b);
  }
  root.appendChild(switchBar);

  // 決定待ち（板ID R4-4・2026-09-02）＝進捗タブの上部・既定は閉じた折りたたみ。
  //   決定待ち箱が読めない／0件のときは何も出さない（素通り）。
  decisionsEl = h('div', 'pb-decisions');
  decisionsEl.hidden = true;
  root.appendChild(decisionsEl);

  // 状態マップ（既存＝進捗リスト＋作業順序リスト）を1枠にまとめる。
  mapWrap = h('div', 'pb-mapwrap');
  const toolbar = h('div', 'pb-toolbar');
  searchEl = h('input', 'field pb-search');
  searchEl.type = 'search'; searchEl.placeholder = '機能・実装単位ID・名称で検索';
  searchEl.oninput = () => { if (data) render(); };
  toolbar.appendChild(searchEl);
  distEl = h('div', 'pb-dist');
  toolbar.appendChild(distEl);
  mapWrap.appendChild(toolbar);
  noteEl = h('p', 'pb-note view-hint');
  mapWrap.appendChild(noteEl);

  const progTitle = h('h3', 'pb-col-title');
  progTitle.appendChild(h('span', null, '進捗リスト'));
  progTitle.appendChild(h('span', 'pb-col-sub', '状態の地図（機能＞実装単位＞CASEグループ）'));
  mapWrap.appendChild(progTitle);
  listEl = h('div', 'pb-list');
  listEl.textContent = '読み込み中…';
  mapWrap.appendChild(listEl);

  const workTitle = h('h3', 'pb-col-title');
  workTitle.appendChild(h('span', null, '作業順序リスト'));
  workTitle.appendChild(h('span', 'pb-col-sub', '運転計画（=CASEグループ・完了は保持）'));
  mapWrap.appendChild(workTitle);
  workEl = h('div', 'pb-worklist');
  mapWrap.appendChild(workEl);
  root.appendChild(mapWrap);

  // フロー俯瞰・直近の詳細（切替時に読み込み）。
  overviewWrap = h('div', 'pb-flowwrap');
  overviewWrap.hidden = true;
  root.appendChild(overviewWrap);
  flowWrap = h('div', 'pb-flowwrap');
  flowWrap.hidden = true;
  root.appendChild(flowWrap);

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
  if (!decisionsLoaded) { decisionsLoaded = true; loadDecisions(ctx); }
  if (!data) await load(ctx);
}

// 決定待ちの折りたたみ（板ID R4-4）。読めない／0件は出さない＝進捗タブは何も変わらない。
async function loadDecisions(ctx) {
  if (!decisionsEl || !ctx || !ctx.program || typeof ctx.program.loadDecisions !== 'function') return;
  let list = [];
  try { list = await ctx.program.loadDecisions(); } catch (e) { list = []; }
  if (!Array.isArray(list) || list.length === 0) return;
  const det = h('details', 'pb-decisions-det');
  det.appendChild(h('summary', 'pb-decisions-sum', '決定待ち ' + list.length + '件'));
  const ul = h('div', 'pb-decisions-list');
  for (const d of list) {
    const row = h('div', 'pb-decisions-row');
    if (d.priority) row.appendChild(h('span', 'pb-decisions-pri', d.priority));
    if (d.id) row.appendChild(h('span', 'pb-decisions-id', d.id));
    row.appendChild(h('span', 'pb-decisions-title', d.title || '（題なし）'));
    if (d.source) row.appendChild(h('span', 'pb-decisions-src', '出所: ' + d.source));
    row.title = 'DECISION_QUEUE.md の ' + (d.line || '?') + ' 行目';
    ul.appendChild(row);
  }
  det.appendChild(ul);
  decisionsEl.innerHTML = '';
  decisionsEl.appendChild(det);
  decisionsEl.hidden = false;
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

// ====== 作業フロービュー（便10+11・SPEC_V3 §5f/§5g・静的ペイロード読取り） ======

// 進捗タブ内の切替（状態マップ／フロー俯瞰／直近の詳細）。フローは初回切替時に読み込む。
function setPbView(view) {
  pbview = view;
  if (root) root.querySelectorAll('.pb-switch-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.pbview === view));
  if (mapWrap) mapWrap.hidden = view !== 'map';
  if (overviewWrap) overviewWrap.hidden = view !== 'overview';
  if (flowWrap) flowWrap.hidden = view !== 'flow';
  if (miniEl) miniEl.hidden = true;
  if (view === 'overview') { if (!overviewData) loadOverview(); else renderFlowOverview(); }
  if (view === 'flow') { if (!flowData) loadDetail(); else renderFlowView(); }
}

async function loadDetail() {
  flowWrap.textContent = '読み込み中…';
  try { flowData = await currentCtx.program.loadFlowView(); renderFlowView(); }
  catch (e) { flowWrap.innerHTML = ''; flowWrap.appendChild(h('p', 'view-hint', '直近の詳細の読み込みに失敗: ' + (e.message || e))); }
}
async function loadOverview() {
  overviewWrap.textContent = '読み込み中…';
  try { overviewData = await currentCtx.program.loadFlowOverview(); renderFlowOverview(); }
  catch (e) { overviewWrap.innerHTML = ''; overviewWrap.appendChild(h('p', 'view-hint', 'フロー俯瞰の読み込みに失敗: ' + (e.message || e))); }
}

function flowMeta(state) { return FLOW_STATE[state] || FLOW_STATE.unknown; }

// 焼き込み時刻の注記（静的のため台帳更新後は再ビルドで反映）。
function builtNote(p) {
  let stamp = '不明';
  if (p && p.builtAt) { try { stamp = new Date(p.builtAt).toLocaleString('ja-JP', { hour12: false }); } catch { stamp = String(p.builtAt); } }
  return h('div', 'flow-built', 'この表示は ' + stamp + ' 時点の焼き込み（台帳更新後は再ビルドで反映）');
}

// 状態ミニポップアップ（miniEl 共用・なぜ＋何待ちか）。
function openFlowMini(it, anchor) {
  if (!miniEl) return;
  miniEl.innerHTML = '';
  const m = flowMeta(it.state);
  miniEl.appendChild(h('div', 'pb-mini-state ' + m.cls, it.stateLabel || m.name));
  const mm = it.mini || {};
  if (mm.why) miniEl.appendChild(h('div', 'pb-mini-why', 'なぜ: ' + mm.why));
  for (const dl of (mm.depLines || [])) miniEl.appendChild(h('div', 'pb-mini-edge', '待ち: ' + dl));
  if (it.ref) miniEl.appendChild(h('div', 'pb-mini-edge', '台帳: ' + it.ref));
  const r = anchor.getBoundingClientRect();
  miniEl.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  miniEl.style.top = (r.bottom + 4) + 'px';
  miniEl.hidden = false;
}

function flowStateChip(it) {
  const m = flowMeta(it.state);
  const chip = h('span', 'flow-chip ' + m.cls, it.stateLabel || m.name);
  if (it.mini && (it.mini.why || (it.mini.depLines && it.mini.depLines.length))) {
    chip.classList.add('is-click');
    chip.onclick = (e) => { e.stopPropagation(); openFlowMini(it, chip); };
  }
  return chip;
}
function flowScenChip(sc) {
  if (!sc) return null;
  const chip = h('span', 'scen-chip ' + (SCEN_CLS[sc.cls] || 'scen-na'), sc.label);
  if (sc.why) { chip.classList.add('is-click'); chip.onclick = (e) => { e.stopPropagation(); openFlowMini({ state: 'declared', stateLabel: sc.label, mini: { why: sc.why } }, chip); }; }
  return chip;
}
// 対象ページ直行（モバイルは Sheets 群へ切替＝jumpScenario と同方式）。
function flowSheetLink(link, label) {
  const lk = h('span', 'flow-link', '📋');
  lk.title = label;
  lk.onclick = (e) => { e.stopPropagation(); if (currentCtx && currentCtx.openSheet) currentCtx.openSheet(link.type, link.file); };
  return lk;
}

// 短い機能名チップ（どの機能・どの大枠作業の話かを行だけで読めるようにする・2026-09-02）。
//   unitLabel が無ければ出さない。全角8字を超えるものは「…」で切り、title に全文と大枠（親）を入れる
//   （長押し・ホバーで大枠が読める）。
function flowUnitChips(it) {
  const out = [];
  if (it && it.unitLabel) {
    const full = String(it.unitLabel);
    const text = full.length > 8 ? full.slice(0, 8) + '…' : full;
    const chip = h('span', 'flow-unit-chip', text);
    const tip = [];
    if (text !== full) tip.push(full);
    if (it.parentName) tip.push('大枠: ' + it.parentName);
    if (tip.length) chip.title = tip.join(' ／ ');
    out.push(chip);
    // 実装ではない整理・確認の件（klass='タスク'）だけ第2チップ。
    if (it.klass === 'タスク') {
      const t = h('span', 'flow-unit-chip is-task', '整理');
      t.title = '実装ではない整理・確認の件';
      out.push(t);
    }
  }
  return out;
}

// 直近の詳細の1項目（状態チップ＋シナリオ状態＋平易名＋種類/ID＋台帳＋Sheetリンク）。
function flowItemRow(it) {
  const row = h('div', 'flow-item flow-item-' + it.state);
  row.appendChild(flowStateChip(it));
  flowUnitChips(it).forEach((c) => row.appendChild(c));
  const sc = flowScenChip(it.scenario); if (sc) row.appendChild(sc);
  const body = h('span', 'flow-item-body');
  body.appendChild(h('span', 'flow-item-label', it.label || it.name || it.code || ''));
  const meta = h('span', 'flow-item-meta');
  if (it.kind) meta.appendChild(h('span', 'flow-kind', it.kind));
  if (it.code) meta.appendChild(h('span', 'flow-code', it.code));
  if (it.ref) meta.appendChild(h('span', 'flow-ref', '台帳: ' + it.ref));
  flowAnchorChips(meta, it.anchors);
  body.appendChild(meta);
  row.appendChild(body);
  if (it.link && it.link.file && (it.link.type === 'scenario' || it.link.type === 'completion')) {
    row.appendChild(flowSheetLink(it.link, it.link.type === 'scenario' ? 'シナリオへ' : '完成定義へ'));
  }
  return row;
}

function renderFlowView() {
  const p = flowData;
  if (!flowWrap) return;
  flowWrap.innerHTML = '';
  if (!p) { flowWrap.textContent = '読み込み中…'; return; }
  const head = h('div', 'flow-head');
  head.appendChild(h('div', 'flow-title', (p.meta && p.meta.title) || '作業フロー'));
  if (p.meta && p.meta.subtitle) head.appendChild(h('div', 'flow-sub', p.meta.subtitle));
  const dist = h('div', 'flow-dist');
  for (const k of FLOW_STATE_ORDER) { const n = (p.dist || {})[k] || 0; if (!n) continue; dist.appendChild(h('span', 'flow-chip ' + flowMeta(k).cls, flowMeta(k).name + ' ' + n)); }
  head.appendChild(dist);
  if (!p.sourcesOk || !p.sourcesOk.edges) head.appendChild(h('div', 'view-hint', '依存地図が読めないため状態は「不明」表示です。'));
  head.appendChild(builtNote(p));
  flowWrap.appendChild(head);

  // 段1: 第一線（柱＋調査枠）
  const s1 = h('div', 'flow-stage');
  s1.appendChild(h('h3', 'flow-stage-title', (p.firstLine && p.firstLine.title) || '第一線の背骨'));
  if (p.firstLine && p.firstLine.note) s1.appendChild(h('p', 'flow-stage-note', p.firstLine.note));
  const pillarsWrap = h('div', 'flow-pillars');
  for (const pl of (p.firstLine && p.firstLine.pillars) || []) {
    const col = h('div', 'flow-pillar');
    const ph = h('div', 'flow-pillar-head');
    ph.appendChild(h('span', 'flow-pillar-title', pl.title));
    if (pl.serial) ph.appendChild(h('span', 'flow-serial', '順に進める'));
    col.appendChild(ph);
    if (pl.note) col.appendChild(h('div', 'flow-pillar-note', pl.note));
    const list = h('div', 'flow-item-list' + (pl.serial ? ' is-serial' : ''));
    (pl.items || []).forEach((it, i) => {
      if (pl.serial && i > 0) list.appendChild(h('div', 'flow-arrow', '↓'));
      list.appendChild(flowItemRow(it));
    });
    col.appendChild(list);
    pillarsWrap.appendChild(col);
  }
  s1.appendChild(pillarsWrap);
  const inv = p.firstLine && p.firstLine.investigation;
  if (inv) {
    const invWrap = h('div', 'flow-investigation');
    invWrap.appendChild(h('div', 'flow-pillar-title', inv.title));
    if (inv.note) invWrap.appendChild(h('div', 'flow-pillar-note', inv.note));
    const list = h('div', 'flow-item-list flow-inv-list');
    (inv.items || []).forEach((it) => list.appendChild(flowItemRow(it)));
    invWrap.appendChild(list);
    s1.appendChild(invWrap);
  }
  flowWrap.appendChild(s1);

  // 段2: 並走枠
  if (p.parallel) {
    const s2 = h('div', 'flow-stage flow-parallel');
    s2.appendChild(h('h3', 'flow-stage-title', p.parallel.title));
    if (p.parallel.note) s2.appendChild(h('p', 'flow-stage-note', p.parallel.note));
    const ul = h('ul', 'flow-parallel-list');
    (p.parallel.items || []).forEach((t) => ul.appendChild(h('li', null, t)));
    s2.appendChild(ul);
    flowWrap.appendChild(s2);
  }

  // 段3: 将来領域（表）
  if (p.future) {
    const s3 = h('div', 'flow-stage flow-future');
    s3.appendChild(h('h3', 'flow-stage-title', p.future.title));
    if (p.future.note) s3.appendChild(h('p', 'flow-stage-note', p.future.note));
    const tableWrap = h('div', 'flow-table-scroll');
    const table = h('table', 'flow-future-table');
    const thead = h('tr');
    ['領域', 'いまやること', '再開の条件'].forEach((hh) => thead.appendChild(h('th', null, hh)));
    table.appendChild(thead);
    (p.future.rows || []).forEach((r) => {
      const tr = h('tr');
      tr.appendChild(h('td', 'flow-future-area', r.area));
      tr.appendChild(h('td', null, r.now));
      tr.appendChild(h('td', null, r.resume));
      table.appendChild(tr);
    });
    tableWrap.appendChild(table);
    s3.appendChild(tableWrap);
    flowWrap.appendChild(s3);
  }
}

// ====== フロー俯瞰（便11・全対象を棚へ配置・放置ゼロ・未分類0が正常） ======
// 状態マップに当該機能が載っているか（相互ジャンプの壊れリンク回避）。
function flowStateMapFeatures() {
  const set = new Set();
  if (data && Array.isArray(data.features)) for (const f of data.features) { if (f.code) set.add(f.code); }
  return set;
}
// フロー俯瞰から状態マップへ切替＆当該機能で絞り込み（既存の検索フィルタを利用）。
function flowJumpToMap(featureCode) {
  if (searchEl) searchEl.value = featureCode;
  setPbView('map');
  if (data) render();
  if (mapWrap && mapWrap.scrollIntoView) mapWrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// フロー俯瞰の1行（実装状態＋シナリオ状態の2チップ・平易名・系統/ID・Sheetリンク・状態マップ相互ジャンプ）。
function flowOvRow(it, mapFeats) {
  const row = h('div', 'flow-ov-row flow-item flow-item-' + it.state);
  const chips = h('span', 'flow-ov-chips');
  chips.appendChild(flowStateChip(it));
  flowUnitChips(it).forEach((c) => chips.appendChild(c));
  const sc = flowScenChip(it.scenario); if (sc) chips.appendChild(sc);
  if (it.legacyDone) {
    const lg = h('span', 'legacy-done-chip', it.legacyChip || '旧方式での完成・新方式での再確認待ち');
    lg.title = '旧方式で完成した扱いだが、新方式での再確認（精査）待ち。精査確定までは完了棚には正式計上しない。';
    chips.appendChild(lg);
  }
  row.appendChild(chips);
  const body = h('span', 'flow-item-body');
  body.appendChild(h('span', 'flow-item-label', it.label || it.name || it.code || ''));
  const meta = h('span', 'flow-item-meta');
  // 弾ラベル（UNIT_REGISTRY stage欄・2026-08-15）。第1弾は強調・他は淡色。
  if (it.stage) meta.appendChild(h('span', 'flow-stage-chip' + (isFirstStage(it.stage) ? ' is-first' : ''), it.stage));
  if (it.kind) meta.appendChild(h('span', 'flow-kind', it.kind));
  if (it.code) meta.appendChild(h('span', 'flow-code', it.code));
  if (it.origin === 'inventory') meta.appendChild(h('span', 'flow-ref', '目録'));
  if (it.ref) meta.appendChild(h('span', 'flow-ref', it.ref.length > 40 ? it.ref.slice(0, 40) + '…' : it.ref));
  flowAnchorChips(meta, it.anchors);
  body.appendChild(meta);
  row.appendChild(body);
  if (it.link && it.link.file && it.link.type === 'scenario') row.appendChild(flowSheetLink(it.link, 'シナリオ（ケース表）へ'));
  if (it.stateMapKey && mapFeats && mapFeats.has(it.stateMapKey)) {
    const jp = h('span', 'flow-link flow-mapjump', '↔');
    jp.title = '状態マップの該当機能へ';
    jp.onclick = (e) => { e.stopPropagation(); flowJumpToMap(it.stateMapKey); };
    row.appendChild(jp);
  }
  return row;
}

function renderFlowOverview() {
  const p = overviewData;
  if (!overviewWrap) return;
  overviewWrap.innerHTML = '';
  if (!p) { overviewWrap.textContent = '読み込み中…'; return; }
  const mapFeats = flowStateMapFeatures();
  const head = h('div', 'flow-head');
  head.appendChild(h('div', 'flow-title', (p.meta && p.meta.title) || 'フロー俯瞰'));
  if (p.meta && p.meta.subtitle) head.appendChild(h('div', 'flow-sub', p.meta.subtitle));
  const b = p.balance || {};
  const bal = h('div', 'flow-balance' + (b.unclassified ? ' is-bad' : ''));
  bal.appendChild(h('span', 'flow-bal-main', '全対象 ' + (b.total || 0) + '件 ＝ 表示 ' + (b.shown || 0) + '件・未分類 ' + (b.unclassified || 0) + '件'));
  bal.appendChild(h('span', 'flow-bal-sub', '（登記簿 ' + (b.registry || 0) + '＋機能外目録 ' + (b.inventory || 0) + '）'));
  head.appendChild(bal);
  if (!p.sourcesOk || !p.sourcesOk.edges) head.appendChild(h('div', 'view-hint', '依存地図が読めないため状態は「不明」表示です。'));
  if (!p.sourcesOk || !p.sourcesOk.inventory) head.appendChild(h('div', 'view-hint', '機能外タスク目録が読めないため独立タスクは非表示です。'));
  head.appendChild(builtNote(p));

  // 弾ビュー切替（既定=第1弾・2026-08-15基幹回付①・Mac板と同型）。表示だけを絞る（収支の正は上の行）。
  const firstOnly = stageView === '第1弾';
  const stageMatch = (it) => !firstOnly || isFirstStage(it.stage);
  const firstCount = (p.shelves || []).reduce((n, s) => n + (s.groups || []).reduce(
    (m, g) => m + (g.items || []).filter((it) => isFirstStage(it.stage)).length, 0), 0);
  const tg = h('div', 'flow-stageview-toggle');
  const mkBtn = (label, mode) => {
    const btn = h('button', 'flow-stageview-btn' + (stageView === mode ? ' is-active' : ''), label);
    btn.onclick = () => { stageView = mode; renderFlowOverview(); };
    return btn;
  };
  tg.appendChild(mkBtn('第1弾（' + firstCount + '件）', '第1弾'));
  tg.appendChild(mkBtn('全弾', '全弾'));
  if (firstOnly) tg.appendChild(h('span', 'flow-stageview-hint', '第1弾の単位だけを表示中（弾ラベルなしの目録行も隠れます）'));
  head.appendChild(tg);

  // 第1弾サブフィルタ=通常/ゲーム/共通（2026-08-17基幹回付・Mac板と同型）。
  const sphereMatch = (it) => !firstOnly || sphereView === 'all' || it.sphere === sphereView;
  if (firstOnly) {
    const countOf = (sv) => (p.shelves || []).reduce((n, s2) => n + (s2.groups || []).reduce(
      (m, g) => m + (g.items || []).filter((it) => isFirstStage(it.stage) && (sv === 'all' || it.sphere === sv)).length, 0), 0);
    const sg = h('div', 'flow-stageview-toggle flow-sphere-toggle');
    const mkSphereBtn = (label, mode) => {
      const b = h('button', 'flow-stageview-btn' + (sphereView === mode ? ' is-active' : ''), label);
      b.onclick = () => { sphereView = mode; renderFlowOverview(); };
      return b;
    };
    sg.appendChild(mkSphereBtn('すべて（' + countOf('all') + '）', 'all'));
    sg.appendChild(mkSphereBtn('通常（' + countOf('normal') + '）', 'normal'));
    sg.appendChild(mkSphereBtn('ゲーム（' + countOf('game') + '）', 'game'));
    sg.appendChild(mkSphereBtn('共通（' + countOf('shared') + '）', 'shared'));
    head.appendChild(sg);
  }
  overviewWrap.appendChild(head);

  for (const shelf of (p.shelves || [])) {
    if (shelf.key === 'unclassified' && shelf.count === 0) continue; // 0件が正常＝出さない
    const groups = (shelf.groups || [])
      .map((g) => ({ ...g, items: (g.items || []).filter((it) => stageMatch(it) && sphereMatch(it)) }))
      .map((g) => ({ ...g, count: g.items.length }))
      .filter((g) => g.count > 0);
    const shownCount = groups.reduce((n, g) => n + g.count, 0);
    if (firstOnly && shownCount === 0 && shelf.key !== 'unclassified') continue; // 第1弾ビューでは空棚を出さない
    const sec = h('div', 'flow-shelf flow-shelf-' + shelf.key + (shelf.key === 'unclassified' ? ' is-bad' : ''));
    const sh = h('div', 'flow-shelf-head');
    sh.appendChild(h('span', 'flow-shelf-title', shelf.title));
    sh.appendChild(h('span', 'flow-shelf-count', firstOnly ? (shownCount + '件（全' + shelf.count + '件）') : (shelf.count + '件')));
    sec.appendChild(sh);
    if (shelf.note) sec.appendChild(h('div', 'flow-shelf-note', shelf.note));
    if (shownCount === 0) { sec.appendChild(h('div', 'flow-shelf-empty', '該当なし。')); overviewWrap.appendChild(sec); continue; }
    for (const g of groups) {
      const grp = h('div', 'flow-sysgroup');
      const gh = h('div', 'flow-sysgroup-head');
      gh.appendChild(h('span', 'flow-sysgroup-title', g.title));
      gh.appendChild(h('span', 'flow-sysgroup-count', g.count + '件'));
      grp.appendChild(gh);
      const list = h('div', 'flow-item-list');
      for (const it of (g.items || [])) list.appendChild(flowOvRow(it, mapFeats));
      grp.appendChild(list);
      sec.appendChild(grp);
    }
    overviewWrap.appendChild(sec);
  }
}

registerView({ id: 'progressboard', tabLabel: '進捗', create, onShow });
