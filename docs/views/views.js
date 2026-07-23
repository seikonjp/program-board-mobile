'use strict';

// views/views.js — Views 群（進捗＋ライブラリ・v2.3・Phase3）。
// 正はファイル（読み取り専用）。ユーザー操作＝行/項目への💬コメント＝consultカード自動生成（3-4）。
// データ層は program.js（loadProgress/listLibrary/readLibraryItem/createViewCommentCard）に委譲。

import { registerView } from '../registry.js';
import { h } from './shared.js';

const STAGE_ORDER = ['済', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', '随時', '並走', 'R7', '線外', '対象外', '—', '不明', '（段階なし）'];
const USTATUS_ORDER = ['進行中', '待ち', '未着手', '完了', '対象外', '不明'];
const KIND_ORDER = ['feature', 'fpu', 'com', 'cmp', 'data', 'infra', 'framework', 'doc', 'ui', 'test'];
const KIND_LABEL = {
  feature: '機能', fpu: 'FPU', com: 'コム', cmp: '部品', data: 'データ',
  infra: '基盤', framework: '大枠', doc: '文書', ui: 'UI', test: 'テスト',
};
const BLOCKED_LABEL = { '裁定': '裁定待ち', '依存': '依存待ち', '上流': '上流待ち', '順番': '順番待ち', '容量': '容量' };

let root, subtabsEl, progressPane, libraryPane;
// 進捗
let pgSearch, pgKind, pgStatus, pgGroupBy, pgSelBar, pgNote, pgBody;
let progressData = null;
let progressSelected = null;
let progressGroupBy = 'stage';
// ライブラリ
let libListPane, libDetailPane, libAxesWrap, libTitle, libSearch, libBody;
let libraryAxes = [];
let libraryCurrent = null;
let mode = 'progress';
// Library原典（§4・便4）
let originsPane, origListPane, origDetailPane, origBoardWrap, origTitle, origSearch, origBody;
let originsBoard = null;
let originsCurrent = null;

function stageBase(stage) {
  if (!stage) return '（段階なし）';
  return stage.replace(/[⚠️◆?？].*/u, '').trim() || '（段階なし）';
}

function create(ctx) {
  root = h('div', 'views');

  subtabsEl = h('div', 'views-subtabs');
  const pTab = h('button', 'subtab is-active', 'Progress');
  const lTab = h('button', 'subtab', 'Library');
  const oTab = h('button', 'subtab', 'Library原典');
  pTab.onclick = () => switchMode(ctx, 'progress');
  lTab.onclick = () => switchMode(ctx, 'library');
  oTab.onclick = () => switchMode(ctx, 'origins');
  subtabsEl._pTab = pTab; subtabsEl._lTab = lTab; subtabsEl._oTab = oTab;
  subtabsEl.appendChild(pTab);
  subtabsEl.appendChild(lTab);
  subtabsEl.appendChild(oTab);
  root.appendChild(subtabsEl);

  // ---- 進捗ペイン ----
  progressPane = h('div', 'progress-pane');
  const toolbar = h('div', 'progress-toolbar');
  pgSearch = h('input', 'field progress-search');
  pgSearch.type = 'search'; pgSearch.placeholder = 'id・名称で検索';
  pgSearch.oninput = renderProgress;
  pgGroupBy = h('select', 'progress-select');
  pgGroupBy.innerHTML = '<option value="stage">段階で分類</option><option value="kind">種別で分類</option><option value="status">状態で分類</option>';
  pgGroupBy.onchange = () => { progressGroupBy = pgGroupBy.value; renderProgress(); };
  pgKind = h('select', 'progress-select');
  pgStatus = h('select', 'progress-select');
  pgKind.onchange = renderProgress;
  pgStatus.onchange = renderProgress;
  toolbar.appendChild(pgSearch);
  toolbar.appendChild(pgGroupBy);
  toolbar.appendChild(pgKind);
  toolbar.appendChild(pgStatus);
  progressPane.appendChild(toolbar);
  pgNote = h('p', 'progress-note view-hint');
  progressPane.appendChild(pgNote);
  pgSelBar = h('div', 'progress-selection');
  pgSelBar.hidden = true;
  progressPane.appendChild(pgSelBar);
  pgBody = h('div', 'progress-body');
  progressPane.appendChild(pgBody);
  root.appendChild(progressPane);

  // ---- ライブラリペイン ----
  libraryPane = h('div', 'library-pane-root');
  libraryPane.hidden = true;
  libListPane = h('div', 'library-list-pane');
  libListPane.appendChild(h('p', 'view-hint', '設計基盤軸の正本を読み取り表示（編集はしません）。項目にコメントするとconsultカードが生成されます。'));
  libAxesWrap = h('div', 'library-axes');
  libAxesWrap.textContent = '読み込み中…';
  libListPane.appendChild(libAxesWrap);
  libraryPane.appendChild(libListPane);

  libDetailPane = h('div', 'library-detail-pane');
  libDetailPane.hidden = true;
  const dhead = h('div', 'library-detail-head');
  const back = h('button', 'btn-secondary', '← 一覧へ');
  back.onclick = () => { libDetailPane.hidden = true; libListPane.hidden = false; };
  libTitle = h('span', 'library-title');
  libSearch = h('input', 'field library-search');
  libSearch.type = 'search'; libSearch.placeholder = 'この軸内を検索';
  libSearch.oninput = () => { if (libraryCurrent) renderLibraryItem(ctx, libraryCurrent); };
  dhead.appendChild(back);
  dhead.appendChild(libTitle);
  dhead.appendChild(libSearch);
  libDetailPane.appendChild(dhead);
  libBody = h('div', 'library-body');
  libDetailPane.appendChild(libBody);
  libraryPane.appendChild(libDetailPane);
  root.appendChild(libraryPane);

  // ---- Library原典ペイン（§4・便4）: Sheet原典を俯瞰・状態=新着アイコンのみ ----
  originsPane = h('div', 'library-pane-root');
  originsPane.hidden = true;
  origListPane = h('div', 'library-list-pane');
  origListPane.appendChild(h('p', 'view-hint', 'Sheetの原典（変換前の正本）を読み取り表示（編集はしません）。状態は「変更から一定期間の新着（🆕）」のみ。実パス未特定は「未整備（原典未特定）」と正直に表示します。'));
  origBoardWrap = h('div', 'origins-board');
  origBoardWrap.textContent = '読み込み中…';
  origListPane.appendChild(origBoardWrap);
  originsPane.appendChild(origListPane);

  origDetailPane = h('div', 'library-detail-pane');
  origDetailPane.hidden = true;
  const ohead = h('div', 'library-detail-head');
  const oback = h('button', 'btn-secondary', '← 一覧へ');
  oback.onclick = () => { origDetailPane.hidden = true; origListPane.hidden = false; };
  origTitle = h('span', 'library-title');
  origSearch = h('input', 'field library-search');
  origSearch.type = 'search'; origSearch.placeholder = 'この原典内を検索';
  origSearch.oninput = () => { if (originsCurrent) renderOriginFile(originsCurrent); };
  ohead.appendChild(oback);
  ohead.appendChild(origTitle);
  ohead.appendChild(origSearch);
  origDetailPane.appendChild(ohead);
  origBody = h('div', 'library-body');
  origDetailPane.appendChild(origBody);
  originsPane.appendChild(origDetailPane);
  root.appendChild(originsPane);

  return root;
}

function onShow(ctx) {
  if (mode === 'progress' && !progressData) loadProgress(ctx);
  if (mode === 'library' && !libraryAxes.length) loadLibrary(ctx);
  if (mode === 'origins' && !originsBoard) loadLibraryOrigins(ctx);
}

function switchMode(ctx, m) {
  mode = m;
  subtabsEl._pTab.classList.toggle('is-active', m === 'progress');
  subtabsEl._lTab.classList.toggle('is-active', m === 'library');
  subtabsEl._oTab.classList.toggle('is-active', m === 'origins');
  progressPane.hidden = (m !== 'progress');
  libraryPane.hidden = (m !== 'library');
  originsPane.hidden = (m !== 'origins');
  if (m === 'progress' && !progressData) loadProgress(ctx);
  if (m === 'library' && !libraryAxes.length) loadLibrary(ctx);
  if (m === 'origins' && !originsBoard) loadLibraryOrigins(ctx);
}

// ---- View行コメント → consultカード（3-4） ----
function attachCommentBox(ctx, anchorBtn, container, itemId, itemLabel, quote) {
  anchorBtn.onclick = () => {
    const ex = container.querySelector('.view-comment-box');
    if (ex) { ex.remove(); return; }
    const box = h('div', 'view-comment-box');
    const ta = h('textarea', 'field view-comment-input');
    ta.rows = 2;
    ta.placeholder = '💬 コメント（送信すると consult カードに）';
    const send = h('button', 'btn-primary', '送信');
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      send.disabled = true;
      try {
        await ctx.program.createViewCommentCard({ itemId, itemLabel, comment: text, quote });
        ctx.toast('consultカードを作成しました');
        box.remove();
        if (ctx.reload) await ctx.reload();
      } catch (e) {
        ctx.toast('コメント送信に失敗: ' + (e.message || e));
        send.disabled = false;
      }
    };
    box.appendChild(ta);
    box.appendChild(send);
    container.appendChild(box);
    ta.focus();
  };
}

// ---- 進捗 ----
async function loadProgress(ctx) {
  if (!ctx.program || !ctx.program.loadProgress) return;
  pgBody.textContent = '読み込み中…';
  try {
    progressData = await ctx.program.loadProgress();
    progressSelected = null;
    setupFilters();
    renderProgress();
  } catch (e) {
    pgBody.innerHTML = '';
    pgBody.appendChild(h('p', 'view-hint', '進捗の読み込みに失敗: ' + (e.message || e)));
  }
}

function setupFilters() {
  const units = (progressData && progressData.units) || [];
  const kinds = [...new Set(units.map((u) => u.kind))].filter(Boolean)
    .sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  fillSelect(pgKind, '種別: すべて', kinds.map((k) => ({ v: k, label: KIND_LABEL[k] || k })));
  fillSelect(pgStatus, '状態: すべて', USTATUS_ORDER.map((s) => ({ v: s, label: s })));
}

function fillSelect(sel, allLabel, values) {
  sel.innerHTML = '';
  const o0 = h('option', null, allLabel); o0.value = ''; sel.appendChild(o0);
  values.forEach((v) => { const o = h('option', null, v.label); o.value = v.v; sel.appendChild(o); });
}

function groupKeyOf(u) {
  if (progressGroupBy === 'kind') return u.kind;
  if (progressGroupBy === 'status') return u.status;
  return stageBase(u.stage);
}
function groupLabelOf(k) {
  if (progressGroupBy === 'kind') return '種別 ' + (KIND_LABEL[k] || k);
  if (progressGroupBy === 'status') return '状態 ' + k;
  return '段階 ' + k;
}
function groupSortOf(a, b) {
  const order = progressGroupBy === 'kind' ? KIND_ORDER : (progressGroupBy === 'status' ? USTATUS_ORDER : STAGE_ORDER);
  const ia = order.indexOf(a); const ib = order.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
}

function selectProgressNode(nodeId) {
  progressSelected = (progressSelected === nodeId) ? null : nodeId;
  renderProgress();
}

function renderProgressSelection(byId) {
  pgSelBar.innerHTML = '';
  if (!progressSelected) { pgSelBar.hidden = true; return; }
  pgSelBar.hidden = false;
  const lit = (progressData.reverseClosure && progressData.reverseClosure[progressSelected]) || [];
  const selUnit = byId.get(progressSelected);
  const kindTxt = selUnit ? (KIND_LABEL[selUnit.kind] || selUnit.kind)
    : (/^Q-/.test(progressSelected) ? '裁定' : (/^S[0-6]$/.test(progressSelected) ? '段階' : '外部'));
  pgSelBar.appendChild(h('span', 'progress-sel-label', '🔦 選択: ' + progressSelected + '（' + kindTxt + '）→ ' + lit.length + '件が依存（点灯中）'));
  const clr = h('button', 'progress-sel-clear', '選択解除');
  clr.onclick = () => { progressSelected = null; renderProgress(); };
  pgSelBar.appendChild(clr);
}

function renderProgress() {
  if (!progressData) return;
  const p = progressData;
  const units = p.units || [];
  const byId = new Map(units.map((u) => [u.id, u]));

  const missing = [];
  if (!p.sources.comTargets) missing.push('COM_TARGETS');
  if (!p.sources.progressAxis) missing.push('PROGRESS_AXIS');
  if (!p.sources.taskLedger) missing.push('TASK_LEDGER');
  if (!p.sources.lanes) missing.push('LANES');
  if (!p.sources.carryover) missing.push('CARRYOVER');
  const skipTotal = (p.skipped.census || 0) + (p.skipped.com || 0) + (p.skipped.axis || 0);
  pgNote.textContent = '全' + p.counts.total + '件（' + KIND_ORDER.filter((k) => p.counts.byKind[k])
    .map((k) => (KIND_LABEL[k] || k) + p.counts.byKind[k]).join('・') + '）'
    + (p.sources.testStatus ? '・テスト状況あり' : '')
    + (skipTotal ? '・崩れ行' + skipTotal + '件skip' : '')
    + (missing.length ? '・未取得: ' + missing.join('/') : '');

  renderProgressSelection(byId);

  const q = (pgSearch.value || '').trim().toLowerCase();
  const fKind = pgKind.value;
  const fStat = pgStatus.value;
  let rows = units.slice();
  if (q) rows = rows.filter((u) => (u.title || '').toLowerCase().includes(q) || (u.id || '').toLowerCase().includes(q));
  if (fKind) rows = rows.filter((u) => u.kind === fKind);
  if (fStat) rows = rows.filter((u) => u.status === fStat);

  pgBody.innerHTML = '';
  if (!rows.length) { pgBody.appendChild(h('p', 'view-hint', '該当する作業単位はありません。')); return; }

  const litSet = progressSelected ? new Set((p.reverseClosure && p.reverseClosure[progressSelected]) || []) : null;

  const groups = new Map();
  rows.forEach((u) => { const k = groupKeyOf(u); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(u); });
  const keys = [...groups.keys()].sort(groupSortOf);
  keys.forEach((k) => {
    const section = h('div', 'progress-group');
    const gh = h('div', 'progress-group-head');
    gh.appendChild(h('span', 'progress-group-title', groupLabelOf(k)));
    gh.appendChild(h('span', 'progress-group-count', String(groups.get(k).length)));
    section.appendChild(gh);
    groups.get(k).forEach((u) => section.appendChild(progressRow(u, byId, litSet)));
    pgBody.appendChild(section);
  });
}

function depChipSuffix(d) {
  if (d.kind === 'decision') return '（裁定待ち）';
  if (d.kind === 'stage') return '（段階待ち）';
  if (d.kind === 'unit') return '（依存: ' + (d.status || '') + '）';
  return '';
}

function computeUnmet(u, byId) {
  return (u.deps || []).map((d) => {
    if (byId.has(d)) { const t = byId.get(d); return { dep: d, kind: 'unit', resolved: t.status === '完了', status: t.status }; }
    if (/^Q-/.test(d)) return { dep: d, kind: 'decision', resolved: false };
    if (/^S[0-6]$/.test(d)) return { dep: d, kind: 'stage', resolved: false };
    return { dep: d, kind: 'external', resolved: false };
  }).filter((x) => !x.resolved);
}

function progressRow(u, byId, litSet) {
  const isSelected = progressSelected && u.id === progressSelected;
  const isLit = litSet && litSet.has(u.id);
  let cls = 'progress-row';
  if (u.kind === 'fpu') cls += ' is-fpu';
  if (isSelected) cls += ' is-selected';
  else if (isLit) cls += ' is-lit';
  const row = h('div', cls);

  const nm = h('span', 'progress-name', u.title || u.id);
  nm.appendChild(h('span', 'progress-id', ' ' + u.id));
  row.appendChild(nm);

  const meta = h('div', 'progress-meta');
  meta.appendChild(h('span', 'chip chip-kind', KIND_LABEL[u.kind] || u.kind));
  meta.appendChild(h('span', 'chip chip-ust chip-ust-' + u.status, u.status + (u.statusSub ? '（' + u.statusSub + '）' : '')));
  if (u.status === '待ち' && u.blocked_reason) meta.appendChild(h('span', 'chip chip-blocked', BLOCKED_LABEL[u.blocked_reason] || u.blocked_reason));
  if (u.stage) meta.appendChild(h('span', 'chip chip-stage', u.stage));
  if (u.form && u.form !== '−' && u.form !== '-') meta.appendChild(h('span', 'chip', u.form));
  if (u.taskCount > 0) meta.appendChild(h('span', 'chip chip-task', 'タスク' + u.taskCount));
  if (u.laneActive) meta.appendChild(h('span', 'chip chip-lane', '稼働'));
  if (u.testColor) meta.appendChild(h('span', 'chip chip-test-' + u.testColor, u.testColor === 'green' ? '緑' : '赤'));
  if (u.carryoverCount > 0) meta.appendChild(h('span', 'chip chip-carry', '申し送り' + u.carryoverCount));
  const cbtn = h('button', 'view-comment-btn', '💬');
  cbtn.onclick = (e) => e.stopPropagation();
  meta.appendChild(cbtn);
  row.appendChild(meta);

  const frontier = computeUnmet(u, byId);
  if (frontier.length) {
    const fr = h('div', 'progress-frontier');
    fr.appendChild(h('span', 'progress-frontier-label', 'フロンティア:'));
    frontier.forEach((d) => {
      const dc = h('button', 'dep-chip dep-' + d.kind, d.dep + depChipSuffix(d));
      dc.onclick = (e) => { e.stopPropagation(); selectProgressNode(d.dep); };
      fr.appendChild(dc);
    });
    row.appendChild(fr);
  }

  row.onclick = () => selectProgressNode(u.id);

  const quote = (u.title || u.id) + '（' + u.kind + '/' + u.stage + '/' + u.status + '）';
  attachCommentBox(currentCtx, cbtn, row, u.id, u.title, quote);
  return row;
}

// ---- ライブラリ ----
async function loadLibrary(ctx) {
  if (!ctx.program || !ctx.program.listLibrary) return;
  libAxesWrap.textContent = '読み込み中…';
  try {
    libraryAxes = await ctx.program.listLibrary();
    renderAxes(ctx);
  } catch (e) {
    libAxesWrap.innerHTML = '';
    libAxesWrap.appendChild(h('p', 'view-hint', 'ライブラリの読み込みに失敗: ' + (e.message || e)));
  }
}

function renderAxes(ctx) {
  libAxesWrap.innerHTML = '';
  libraryAxes.forEach((ax) => {
    const b = h('button', 'library-axis' + (ax.available ? '' : ' is-empty'));
    b.appendChild(h('span', 'library-axis-label', ax.label));
    b.appendChild(h('span', 'library-axis-meta', ax.available ? ax.type : '未整備'));
    if (ax.available) b.onclick = () => openAxis(ctx, ax.id);
    else b.disabled = true;
    libAxesWrap.appendChild(b);
  });
}

async function openAxis(ctx, id) {
  libListPane.hidden = true;
  libDetailPane.hidden = false;
  libTitle.textContent = id;
  libSearch.value = '';
  libBody.textContent = '読み込み中…';
  try {
    const payload = await ctx.program.readLibraryItem(id);
    libraryCurrent = payload;
    libTitle.textContent = payload.label + '（' + payload.type + '）';
    renderLibraryItem(ctx, payload);
  } catch (e) {
    libBody.textContent = '読み込みエラー: ' + (e.message || e);
  }
}

function renderLibraryItem(ctx, payload) {
  libBody.innerHTML = '';
  if (!payload.available) { libBody.appendChild(h('p', 'view-hint', 'この軸の正本は未整備です。')); return; }
  const q = (libSearch.value || '').trim().toLowerCase();

  if (payload.type === 'json') {
    const wrap = h('div', 'library-block');
    const cbtn = h('button', 'view-comment-btn', '💬 この軸にコメント');
    wrap.appendChild(cbtn);
    attachCommentBox(ctx, cbtn, wrap, payload.id, payload.label, payload.label + '（JSON全体）');
    libBody.appendChild(wrap);
    const src = payload.parsedOk ? payload.pretty : payload.text;
    const lines = src.split('\n');
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    libBody.appendChild(h('pre', 'library-pre', shown.join('\n')));
    return;
  }

  const blocks = (payload.blocks || []).filter((b) => b.heading);
  const toc = h('div', 'library-toc');
  blocks.forEach((b) => {
    if (q && !(b.heading || '').toLowerCase().includes(q)) return;
    const item = h('div', 'library-block');
    const bh = h('div', 'library-block-head');
    bh.appendChild(h('span', 'library-block-heading lvl-' + b.level, b.heading));
    const cbtn = h('button', 'view-comment-btn', '💬');
    bh.appendChild(cbtn);
    item.appendChild(bh);
    attachCommentBox(ctx, cbtn, item, payload.id + '#' + (b.id || b.index), b.heading, b.heading);
    toc.appendChild(item);
  });
  if (!toc.children.length) toc.appendChild(h('p', 'view-hint', q ? '該当する見出しはありません。' : '（見出しがありません）'));
  libBody.appendChild(toc);
}

// ---- Library原典（§4・便4）: Sheet原典をSheetと同方式で俯瞰・状態=新着アイコンのみ ----
const ORIGIN_STATE_ICON = { new: '🆕', reviewing: '◐', done: '✓', reapprove: '↺' };

async function loadLibraryOrigins(ctx) {
  if (!ctx.program || !ctx.program.loadLibraryOrigins) return;
  origBoardWrap.textContent = '読み込み中…';
  try {
    originsBoard = await ctx.program.loadLibraryOrigins();
    renderLibraryOrigins(ctx);
  } catch (e) {
    origBoardWrap.innerHTML = '';
    origBoardWrap.appendChild(h('p', 'view-hint', 'Library原典の読み込みに失敗: ' + (e.message || e)));
  }
}

function renderLibraryOrigins(ctx) {
  origBoardWrap.innerHTML = '';
  const board = originsBoard;
  if (!board || !(board.tags || []).length) { origBoardWrap.appendChild(h('p', 'view-hint', '（原典がありません）')); return; }
  (board.tags || []).forEach((tag) => {
    const tagBox = h('div', 'origins-tag');
    tagBox.appendChild(h('div', 'origins-tag-head', tag.label));
    (tag.subcategories || []).forEach((sc) => {
      const scBox = h('div', 'origins-sub');
      scBox.appendChild(h('div', 'origins-sub-head', sc.label));
      (sc.origins || []).forEach((o) => {
        const oBox = h('div', 'origins-origin');
        const oh = h('div', 'origins-origin-head');
        oh.appendChild(h('span', 'origins-origin-label', o.label));
        if (!o.available) oh.appendChild(h('span', 'origins-unmapped', o.reason || '未整備（原典未特定）'));
        else oh.appendChild(h('span', 'origins-count', String((o.entries || []).length)));
        oBox.appendChild(oh);
        (o.entries || []).forEach((en) => {
          const row = h('button', 'origins-entry');
          const st = h('span', 'doc-state' + (en.state ? ' st-' + en.state : ''));
          st.textContent = en.state ? (ORIGIN_STATE_ICON[en.state] || '') : '';
          row.appendChild(st);
          const mid = h('div', 'origins-entry-mid');
          mid.appendChild(h('div', 'origins-entry-name', en.name));
          const sub = h('div', 'origins-entry-sub');
          if (en.dir && en.dir !== '.') sub.appendChild(h('span', 'origins-entry-dir', en.dir));
          if (en.updated) sub.appendChild(h('span', 'origins-entry-updated', en.updated));
          mid.appendChild(sub);
          row.appendChild(mid);
          row.onclick = () => openOriginFile(ctx, en.file);
          oBox.appendChild(row);
        });
        scBox.appendChild(oBox);
      });
      tagBox.appendChild(scBox);
    });
    origBoardWrap.appendChild(tagBox);
  });
}

async function openOriginFile(ctx, sub) {
  origListPane.hidden = true;
  origDetailPane.hidden = false;
  origTitle.textContent = sub;
  origSearch.value = '';
  origBody.textContent = '読み込み中…';
  try {
    const payload = await ctx.program.readOriginFile(sub);
    originsCurrent = payload;
    origTitle.textContent = payload.name + '（' + payload.type + '・読み取り専用）';
    renderOriginFile(payload);
  } catch (e) {
    origBody.textContent = '読み込みエラー: ' + (e.message || e);
  }
}

// 原典の閲覧（読み取り専用・コメント口なし＝原典への書き込みは一切しない・§4）。
function renderOriginFile(payload) {
  origBody.innerHTML = '';
  const q = (origSearch.value || '').trim().toLowerCase();
  const src = (payload.type === 'json') ? (payload.parsedOk ? payload.pretty : payload.text) : (payload.text || '');
  const lines = String(src).split('\n');
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  origBody.appendChild(h('pre', 'library-pre', shown.join('\n')));
}

// progressRow は ctx を引数に取らないため、onShow/create 時の ctx を保持して使う。
let currentCtx = null;
function onShowWrap(ctx) { currentCtx = ctx; onShow(ctx); }
function createWrap(ctx) { currentCtx = ctx; return create(ctx); }

registerView({ id: 'views', tabLabel: 'Views', create: createWrap, onShow: onShowWrap });
