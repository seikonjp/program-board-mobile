'use strict';

// views/views.js — Views 群（進捗＋ライブラリ・v2.3・Phase3）。
// 正はファイル（読み取り専用）。ユーザー操作＝行/項目への💬コメント＝consultカード自動生成（3-4）。
// データ層は program.js（loadProgress/listLibrary/readLibraryItem/createViewCommentCard）に委譲。

import { registerView } from '../registry.js';
import { h } from './shared.js';

const STAGE_ORDER = ['済', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', '並走', 'R7', '線外', '対象外', '（段階なし）'];
const PROGRESS_STATE_ORDER = ['実装', '一部', '未実装', '将来想定', '不明'];

let root, subtabsEl, progressPane, libraryPane;
// 進捗
let pgSearch, pgState, pgCat, pgNote, pgBody;
let progressData = null;
// ライブラリ
let libListPane, libDetailPane, libAxesWrap, libTitle, libSearch, libBody;
let libraryAxes = [];
let libraryCurrent = null;
let mode = 'progress';

function stageBase(stage) {
  if (!stage) return '（段階なし）';
  return stage.replace(/[⚠️◆?？].*/u, '').trim() || '（段階なし）';
}

function create(ctx) {
  root = h('div', 'views');

  subtabsEl = h('div', 'views-subtabs');
  const pTab = h('button', 'subtab is-active', 'Progress');
  const lTab = h('button', 'subtab', 'Library');
  pTab.onclick = () => switchMode(ctx, 'progress');
  lTab.onclick = () => switchMode(ctx, 'library');
  subtabsEl._pTab = pTab; subtabsEl._lTab = lTab;
  subtabsEl.appendChild(pTab);
  subtabsEl.appendChild(lTab);
  root.appendChild(subtabsEl);

  // ---- 進捗ペイン ----
  progressPane = h('div', 'progress-pane');
  const toolbar = h('div', 'progress-toolbar');
  pgSearch = h('input', 'field progress-search');
  pgSearch.type = 'search'; pgSearch.placeholder = '機能名で検索';
  pgSearch.oninput = renderProgress;
  pgState = h('select', 'progress-select');
  pgCat = h('select', 'progress-select');
  pgState.onchange = renderProgress;
  pgCat.onchange = renderProgress;
  toolbar.appendChild(pgSearch);
  toolbar.appendChild(pgState);
  toolbar.appendChild(pgCat);
  progressPane.appendChild(toolbar);
  pgNote = h('p', 'progress-note view-hint');
  progressPane.appendChild(pgNote);
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

  return root;
}

function onShow(ctx) {
  if (mode === 'progress' && !progressData) loadProgress(ctx);
  if (mode === 'library' && !libraryAxes.length) loadLibrary(ctx);
}

function switchMode(ctx, m) {
  mode = m;
  subtabsEl._pTab.classList.toggle('is-active', m === 'progress');
  subtabsEl._lTab.classList.toggle('is-active', m === 'library');
  progressPane.hidden = (m !== 'progress');
  libraryPane.hidden = (m !== 'library');
  if (m === 'progress' && !progressData) loadProgress(ctx);
  if (m === 'library' && !libraryAxes.length) loadLibrary(ctx);
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
    setupFilters();
    renderProgress();
  } catch (e) {
    pgBody.innerHTML = '';
    pgBody.appendChild(h('p', 'view-hint', '進捗の読み込みに失敗: ' + (e.message || e)));
  }
}

function setupFilters() {
  const rows = (progressData && progressData.rows) || [];
  const states = [...new Set(rows.filter((r) => r.hasTag).map((r) => r.state))].filter(Boolean)
    .sort((a, b) => PROGRESS_STATE_ORDER.indexOf(a) - PROGRESS_STATE_ORDER.indexOf(b));
  const cats = [...new Set(rows.map((r) => r.category))].filter(Boolean).sort();
  fillSelect(pgState, '状態: すべて', states);
  fillSelect(pgCat, 'カテゴリ: すべて', cats);
}

function fillSelect(sel, allLabel, values) {
  sel.innerHTML = '';
  const o0 = h('option', null, allLabel); o0.value = ''; sel.appendChild(o0);
  values.forEach((v) => { const o = h('option', null, v); o.value = v; sel.appendChild(o); });
}

function renderProgress() {
  if (!progressData) return;
  const p = progressData;
  const missing = [];
  if (!p.sources.taskLedger) missing.push('TASK_LEDGER');
  if (!p.sources.lanes) missing.push('LANES');
  pgNote.textContent = (p.sources.testStatus ? 'テスト状況あり' : 'テスト状況なし（無表示）')
    + (p.skipped ? '・崩れ行' + p.skipped + '件skip' : '')
    + (missing.length ? '・未取得: ' + missing.join('/') : '');

  const q = (pgSearch.value || '').trim().toLowerCase();
  const fState = pgState.value;
  const fCat = pgCat.value;
  let rows = p.rows.filter((r) => r.hasTag);
  if (q) rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.id || '').toLowerCase().includes(q));
  if (fState) rows = rows.filter((r) => r.state === fState);
  if (fCat) rows = rows.filter((r) => r.category === fCat);

  pgBody.innerHTML = '';
  if (!rows.length) { pgBody.appendChild(h('p', 'view-hint', '該当する機能はありません。')); return; }

  const groups = new Map();
  rows.forEach((r) => { const k = stageBase(r.stage); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a); const ib = STAGE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  keys.forEach((k) => {
    const section = h('div', 'progress-group');
    const gh = h('div', 'progress-group-head');
    gh.appendChild(h('span', 'progress-group-title', '段階 ' + k));
    gh.appendChild(h('span', 'progress-group-count', String(groups.get(k).length)));
    section.appendChild(gh);
    groups.get(k).forEach((r) => section.appendChild(progressRow(r)));
    pgBody.appendChild(section);
  });
}

function progressRow(r) {
  const row = h('div', 'progress-row' + (r.level === 'fpu' ? ' is-fpu' : ''));
  row.appendChild(h('span', 'progress-name', r.name));
  const meta = h('div', 'progress-meta');
  if (r.category) meta.appendChild(h('span', 'chip chip-cat', r.category));
  if (r.state) meta.appendChild(h('span', 'chip chip-state-' + r.state, r.state));
  if (r.form && r.form !== '−') meta.appendChild(h('span', 'chip', r.form));
  if (r.stage) meta.appendChild(h('span', 'chip', r.stage));
  if (r.taskCount > 0) meta.appendChild(h('span', 'chip chip-task', 'タスク' + r.taskCount));
  if (r.laneActive) meta.appendChild(h('span', 'chip chip-lane', '稼働'));
  if (r.testColor) meta.appendChild(h('span', 'chip chip-test-' + r.testColor, r.testColor === 'green' ? '緑' : '赤'));
  const cbtn = h('button', 'view-comment-btn', '💬');
  meta.appendChild(cbtn);
  row.appendChild(meta);
  const quote = r.name + (r.stage ? '（' + r.stage + '/' + (r.state || '') + '）' : '');
  attachCommentBox(currentCtx, cbtn, row, r.id, r.name, quote);
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

// progressRow は ctx を引数に取らないため、onShow/create 時の ctx を保持して使う。
let currentCtx = null;
function onShowWrap(ctx) { currentCtx = ctx; onShow(ctx); }
function createWrap(ctx) { currentCtx = ctx; return create(ctx); }

registerView({ id: 'views', tabLabel: 'Views', create: createWrap, onShow: onShowWrap });
