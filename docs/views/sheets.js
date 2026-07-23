'use strict';

// views/sheets.js — Sheets 群（v2.2〜v2.11 便2）。シナリオ／完成定義／RDS を項目単位で表示。
// 正はファイル（読み取り専用）。ユーザー操作＝項目直下の💬コメント＋CASEチェックのトグルのみ（本文編集はしない）。
// 承認モデルv2（§2-3）: 承認＝チェックの純粋導出（承認ボタン概念は撤去）。グループ承認n/m＋文書レベル✓を導出表示。
// D-1 CASE は合成表示（記載順0〜10・§2-1）。データ層は program.js に委譲（readSheet が caseFields/approval を同梱）。

import { registerView } from '../registry.js';
import { h, openCardDetail } from './shared.js';
import { deriveDocState, DOC_STATE_ICON, buildInbox, cardNeedsUserAction, typeLabel, statusLabel } from '../parser.js';

const SHEET_STATE_LABEL = { draft: '起草中', reviewed: '批評済', approved: '承認済' };

let root, listPane, detailPane, sourcesWrap, titleEl, metaEl, bodyEl;
let board = null;          // loadSheetBoard の結果（3画面タグ＋共通列・便1）
let activeTag = 'inbox';   // 既定ビュー=統合インボックス（§1-2c）
let currentEntry = null;   // 開いているシートの board エントリ（確認型の読了マーク用）
let loadedOnce = false;

// 開封・読了の記録＝端末 localStorage（正本へ書かない・§1-1a）。
const SHEET_OPEN_KEY = 'pbm_sheet_open_v1';
function readOpenRecords() { try { return JSON.parse(localStorage.getItem(SHEET_OPEN_KEY) || '{}') || {}; } catch { return {}; } }
function writeOpenRecords(m) { try { localStorage.setItem(SHEET_OPEN_KEY, JSON.stringify(m)); } catch { /* quota */ } }
function openRecordFor(k) { return readOpenRecords()[k] || null; }
function markSeen(k, hash) { const m = readOpenRecords(); const r = m[k] || {}; r.seenHash = hash; m[k] = r; writeOpenRecords(m); }
function markDone(k, hash) { const m = readOpenRecords(); const r = m[k] || {}; r.doneHash = hash; r.seenHash = hash; m[k] = r; writeOpenRecords(m); }
function stateKindFor(dk) { return dk === 'approval' ? 'approval' : (dk === 'confirm' ? 'confirm' : 'general'); }
function entryDocState(en) {
  if (en.docKind === 'approval' && en.checkboxTotal > 0 && en.checkboxChecked === en.checkboxTotal) {
    const r = openRecordFor(en.path);
    if (!r || r.doneHash !== en.currentHash) markDone(en.path, en.currentHash);
  }
  return deriveDocState({ kind: stateKindFor(en.docKind), checkboxTotal: en.checkboxTotal, checkboxChecked: en.checkboxChecked, currentHash: en.currentHash, updatedDaysAgo: en.updatedDaysAgo }, openRecordFor(en.path));
}

function create(ctx) {
  root = h('div', 'sheets');

  // 一覧ペイン（3画面タグ＋統合インボックス・便1）
  listPane = h('div', 'sheets-list-pane');
  sourcesWrap = h('div', 'sheets-sources');
  sourcesWrap.textContent = '読み込み中…';
  listPane.appendChild(sourcesWrap);
  root.appendChild(listPane);

  // 詳細ペイン（開いたシート）
  detailPane = h('div', 'sheets-detail-pane');
  detailPane.hidden = true;
  const head = h('div', 'sheets-detail-head');
  const back = h('button', 'btn-secondary', '← 一覧へ');
  back.onclick = () => backToList();
  titleEl = h('span', 'sheet-title');
  head.appendChild(back);
  head.appendChild(titleEl);
  detailPane.appendChild(head);
  metaEl = h('div', 'sheet-header-meta');
  detailPane.appendChild(metaEl);
  bodyEl = h('div', 'sheet-body');
  detailPane.appendChild(bodyEl);
  root.appendChild(detailPane);

  return root;
}

function onShow(ctx) { if (!loadedOnce) load(ctx); }

async function load(ctx) {
  if (!ctx.program || !ctx.program.loadSheetBoard) return;
  sourcesWrap.innerHTML = '';
  sourcesWrap.appendChild(h('p', 'view-hint', '読み込み中…'));
  try {
    board = await ctx.program.loadSheetBoard();
    loadedOnce = true;
    renderBoard(ctx);
  } catch (e) {
    sourcesWrap.innerHTML = '';
    sourcesWrap.appendChild(h('p', 'view-hint', 'シートの読み込みに失敗: ' + (e.message || e)));
  }
}

function allEntries() {
  const out = [];
  ((board && board.tags) || []).forEach((t) => (t.subcategories || []).forEach((sc) => (sc.entries || []).forEach((en) => out.push(en))));
  return out;
}

// 全画面共通の凡例（§1-1c・凡例に無い記号は画面に出さない）。モバイルは Sheets 上部に常設。
function legendDetails() {
  const d = h('details', 'sheet-legend');
  d.appendChild(h('summary', 'sheet-legend-sum', '凡例（記号の意味）'));
  const ul = h('div', 'sheet-legend-body');
  ul.appendChild(h('div', '', '🆕 新着（未開封） ／ ◐ 確認中 ／ ✓ 完了（全[x]・読了） ／ ↺ 再承認要'));
  ul.appendChild(h('div', '', '承認＝チェックで承認 ／ 確認＝読了で確認 ／ stale＝要旨が原典より古い'));
  ul.appendChild(h('div', '', '解除→N＝承認すると動ける作業単位数（概算）'));
  ul.appendChild(h('div', '', '状態語彙7値: 実装済み／実装可（未着手）／追加実装が必要／他機能の実装待ち（〇〇）／実装中／テスト一部成功・停止中（n/m）／デバッグ中／不明'));
  ul.appendChild(h('div', '', '実装可否マーカー: 🟢実装可 🟡同時実装 🔴他機能の実装待ち（見出し直下） ／ グループ承認＝グループ内全ケース[x]で自動成立'));
  d.appendChild(ul);
  return d;
}

function renderBoard(ctx) {
  sourcesWrap.innerHTML = '';
  sourcesWrap.appendChild(legendDetails());
  const nav = h('div', 'sheet-tagnav');
  const tabs = [{ id: 'inbox', label: '📥 インボックス' }].concat(((board && board.tags) || []).map((t) => ({ id: t.id, label: t.label })));
  tabs.forEach((t) => {
    const b = h('button', 'sheet-tag-btn' + (activeTag === t.id ? ' is-active' : ''), t.label);
    b.onclick = () => { activeTag = t.id; renderBoard(ctx); };
    nav.appendChild(b);
  });
  sourcesWrap.appendChild(nav);
  if (activeTag === 'inbox') renderInbox(ctx);
  else renderTag(ctx, activeTag);
}

// 統合インボックス（§1-2c）: 未処理Sheet＋要ユーザーアクションカードを解除インパクト降順で一列。タップ直行。
function renderInbox(ctx) {
  sourcesWrap.appendChild(h('p', 'view-hint', 'あなたの承認・確認待ち（未処理Sheet＋応答待ちカード）。解除インパクト降順。タップで直行。'));
  const recs = readOpenRecords();
  const sheetItems = allEntries().map((en) => {
    let unresolved = en.unresolved;
    if (en.docKind === 'confirm') { const r = recs[en.path]; unresolved = !(r && r.doneHash === en.currentHash); }
    if (en.docKind === 'display') unresolved = false;
    return { ...en, unresolved };
  });
  const cards = (ctx.state.cards || []).map((c) => ({ ...c, impact: 0 }));
  const rows = buildInbox(sheetItems, cards);
  if (!rows.length) { sourcesWrap.appendChild(h('p', 'view-hint', '（未処理はありません）')); return; }
  const list = h('div', 'inbox-list');
  rows.forEach((r) => list.appendChild(r.kind === 'sheet' ? inboxSheetRow(ctx, r) : inboxCardRow(ctx, r)));
  sourcesWrap.appendChild(list);
}

function kindBadge(dk) {
  if (dk === 'approval') return h('span', 'kind-badge kind-approval', '承認');
  if (dk === 'confirm') return h('span', 'kind-badge kind-confirm', '確認');
  return h('span', 'kind-badge kind-display', '表示');
}
function impactBadge(n) { return h('span', 'impact-badge', '解除→' + (n || 0)); }
function stateIcon(en) { const st = entryDocState(en); const s = h('span', 'doc-state' + (st ? ' st-' + st : '')); s.textContent = st ? DOC_STATE_ICON[st] : ''; return s; }

function inboxSheetRow(ctx, r) {
  const en = r.ref;
  const row = h('button', 'inbox-row inbox-sheet');
  row.appendChild(stateIcon(en));
  row.appendChild(kindBadge(en.docKind));
  const mid = h('div', 'inbox-mid');
  mid.appendChild(h('div', 'inbox-title', (en.flow ? '[' + en.flow + '] ' : '') + en.title));
  if (en.summary) { const s = h('div', 'inbox-summary', en.summary); if (en.stale) s.appendChild(h('span', 'stale-badge', 'stale')); mid.appendChild(s); }
  row.appendChild(mid);
  row.appendChild(impactBadge(en.impact));
  row.onclick = () => { markSeen(en.path, en.currentHash); openSheet(ctx, en.source, en.file, en); };
  return row;
}
function inboxCardRow(ctx, r) {
  const c = r.ref;
  const row = h('button', 'inbox-row inbox-card');
  row.appendChild(h('span', 'doc-state', '🗂'));
  row.appendChild(h('span', 'kind-badge kind-card', typeLabel(c.type) || 'カード'));
  const mid = h('div', 'inbox-mid');
  mid.appendChild(h('div', 'inbox-title', c.title || c.id));
  mid.appendChild(h('div', 'inbox-summary', c.id + '・' + (statusLabel(c.status, c.type) || c.status)));
  row.appendChild(mid);
  row.onclick = () => openCardDetail(ctx, c);
  return row;
}

// タグ別ビュー（開発フロー/設計基盤/RDS）: サブカテゴリ＞エントリ行（共通列）。
function renderTag(ctx, tagId) {
  const tag = ((board && board.tags) || []).find((t) => t.id === tagId);
  if (!tag) { sourcesWrap.appendChild(h('p', 'view-hint', '（該当なし）')); return; }
  if (tag.pending) { sourcesWrap.appendChild(h('p', 'view-hint', '準備中（便4でB-1〜B-6枠を作成）。')); return; }
  (tag.subcategories || []).forEach((sc) => {
    const group = h('div', 'sheet-source');
    const head = h('div', 'sheet-source-head');
    head.appendChild(h('span', 'sheet-source-label', sc.label));
    head.appendChild(h('span', 'sheet-source-count', String((sc.entries || []).length)));
    group.appendChild(head);
    if (!(sc.entries || []).length) { group.appendChild(h('p', 'view-hint', '（ファイルなし）')); }
    else {
      const list = h('div', 'sheet-entry-list');
      sc.entries.forEach((en) => list.appendChild(sheetEntryRow(ctx, en)));
      group.appendChild(list);
    }
    sourcesWrap.appendChild(group);
  });
}

// 2層一覧（§2-3）: 文書行→展開→グループ行（各グループ行に状態アイコン/承認n/m）。
function sheetEntryRow(ctx, en) {
  const wrap = h('div', 'sheet-entry-wrap');
  const row = h('div', 'sheet-entry');
  const groups = en.groups || [];
  const openThis = () => { markSeen(en.path, en.currentHash); openSheet(ctx, en.source, en.file, en); };
  let expanded = false;
  const groupBox = h('div', 'sheet-entry-groups');
  groupBox.hidden = true;
  if (groups.length) {
    const caret = h('button', 'entry-caret', '▸');
    caret.onclick = (e) => { e.stopPropagation(); expanded = !expanded; caret.textContent = expanded ? '▾' : '▸'; groupBox.hidden = !expanded; };
    row.appendChild(caret);
  } else {
    row.appendChild(h('span', 'entry-caret-spacer', ''));
  }
  row.appendChild(stateIcon(en));
  row.appendChild(kindBadge(en.docKind));
  const mid = h('div', 'entry-mid');
  mid.appendChild(h('div', 'entry-title', en.title));
  const sub = h('div', 'entry-sub');
  if (en.summary) { sub.appendChild(h('span', 'entry-summary', en.summary)); if (en.stale) sub.appendChild(h('span', 'stale-badge', 'stale')); }
  if (en.relatedUnits && en.relatedUnits.length) sub.appendChild(h('span', 'entry-units', en.relatedUnits.join('・')));
  if (en.stage) sub.appendChild(h('span', 'entry-stage', en.stage));
  if (groups.length) sub.appendChild(h('span', 'entry-groupsum' + (en.docApproved ? ' is-done' : ''),
    (en.docApproved ? '✓ ' : '') + 'グループ' + groups.filter((g) => g.approved).length + '/' + groups.length));
  if (en.updated) sub.appendChild(h('span', 'entry-updated', en.updated));
  mid.appendChild(sub);
  mid.onclick = openThis;
  row.appendChild(mid);
  row.appendChild(impactBadge(en.impact));
  wrap.appendChild(row);
  groups.forEach((g) => {
    const gr = h('button', 'sheet-group-row ' + (g.approved ? 'grp-approved' : 'grp-open'));
    gr.appendChild(h('span', 'group-state-icon', g.approved ? '✓' : '◐'));
    gr.appendChild(h('span', 'group-heading', g.heading));
    gr.appendChild(h('span', 'group-approval' + (g.approved ? ' is-done' : ''), g.approvedCount + '/' + g.total));
    gr.onclick = openThis;
    groupBox.appendChild(gr);
  });
  wrap.appendChild(groupBox);
  return wrap;
}

function backToList() {
  detailPane.hidden = true;
  listPane.hidden = false;
}

async function openSheet(ctx, source, file, entry) {
  currentEntry = entry || null;
  listPane.hidden = true;
  detailPane.hidden = false;
  titleEl.textContent = file;
  metaEl.innerHTML = '';
  bodyEl.textContent = '読み込み中…';
  try {
    const payload = await ctx.program.readSheet(source, file);
    renderSheet(ctx, payload);
  } catch (e) {
    bodyEl.textContent = '読み込みエラー: ' + (e.message || e);
  }
}

// ヘッダの状態チップ＋承認集計（§2-3・承認ボタン概念は撤去＝チェックの純粋導出）。
function renderHeaderMeta(ctx, payload) {
  metaEl.innerHTML = '';
  const meta = payload.meta || {};
  // frontmatter state は情報チップとして残す（承認ボタンは出さない）。
  if (meta.hasFrontmatter && meta.state != null) {
    const st = String(meta.state).trim();
    metaEl.appendChild(h('span', 'chip chip-sheet-state state-' + st, SHEET_STATE_LABEL[st] || st));
  }
  // §2-3 グループ承認n/m＋文書レベル✓（全グループ承認済み）を導出表示。
  const ap = payload.approval || null;
  if (ap && ap.groupTotal > 0) {
    const done = ap.allApproved;
    metaEl.appendChild(h('span', 'chip chip-approval' + (done ? ' is-done' : ''),
      (done ? '✓ 全グループ承認済み ' : '') + 'グループ承認 ' + ap.groupApproved + '/' + ap.groupTotal));
    metaEl.appendChild(h('span', 'chip chip-approval-cases', 'ケース ' + ap.approvedCases + '/' + ap.totalCases));
  } else {
    const cs = payload.checkStats || { total: 0, unchecked: 0 };
    if (cs.total > 0) metaEl.appendChild(h('span', 'chip chip-check' + (cs.unchecked > 0 ? '' : ' is-done'),
      cs.unchecked > 0 ? '未チェック' + cs.unchecked + '件' : '✓ 全チェック済'));
  }

  // 確認型シート（D-2/D-4/RDS）: 読了マーク（端末 localStorage・§1-1a）。原典へは書かない。
  const en = currentEntry;
  if (en && en.docKind === 'confirm') {
    const rec = openRecordFor(en.path);
    const read = !!(rec && rec.doneHash === en.currentHash);
    const rb = h('button', 'btn-secondary sheet-read' + (read ? ' is-read' : ''), read ? '読了済み ✓' : '読了にする');
    rb.onclick = () => {
      if (read) { const m = readOpenRecords(); if (m[en.path]) { delete m[en.path].doneHash; writeOpenRecords(m); } }
      else markDone(en.path, en.currentHash);
      renderHeaderMeta(ctx, payload);
    };
    metaEl.appendChild(rb);
  }
}

function renderSheet(ctx, payload) {
  renderHeaderMeta(ctx, payload);
  bodyEl.innerHTML = '';
  if (payload.preamble) renderTextRegion(ctx, payload, payload.preamble, payload.preambleStartLine || 0, 'sheet-preamble')
    .forEach((n) => bodyEl.appendChild(n));
  const groupByHeading = {};
  ((payload.approval && payload.approval.groups) || []).forEach((g) => { if (g.headingIndex != null && g.headingIndex >= 0) groupByHeading[g.headingIndex] = g; });
  (payload.blocks || []).forEach((b) => bodyEl.appendChild(renderBlock(ctx, payload, b, groupByHeading[b.index] || null)));
}

// 分類→CSS スラッグ。
function classSlug(cls) {
  return { '正常系': 'normal', '境界値': 'boundary', '状態依存': 'state', '優雅な失敗': 'graceful', '望ましさ観察': 'desire' }[cls] || 'other';
}
function dedentLines(lines) {
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  let min = Infinity;
  nonEmpty.forEach((l) => { const m = /^(\s*)/.exec(l); min = Math.min(min, m[1].length); });
  if (!isFinite(min) || min === 0) return lines.join('\n').replace(/^\n+|\n+$/g, '');
  return lines.map((l) => l.slice(min)).join('\n').replace(/^\n+|\n+$/g, '');
}
function sectionText(sec) {
  const lines = [];
  (sec.segments || []).forEach((seg) => { (seg.lines || []).forEach((l) => lines.push(l)); });
  return dedentLines(lines);
}
function renderCaseSection(sec) {
  const secEl = h('div', 'case-sec case-sec-' + sec.key);
  const num = String(sec.item).replace(/\..*$/, '');
  secEl.appendChild(h('div', 'case-sec-label', num + ' ' + sec.label));
  secEl.appendChild(h('pre', 'case-sec-body', sectionText(sec)));
  return secEl;
}

// CASEブロックの合成表示（§2-1・記載順0〜10・対象/根拠のみ折りたたみ）。
function renderComposedCase(ctx, payload, block) {
  const cf = block.caseFields || {};
  const container = h('div', 'sheet-block sheet-case' + (cf.checked ? ' is-checked' : ''));
  const headerLine = (block.raw || '').split('\n')[0];
  const m = /^- \[([ xX])\] ?(.*)$/.exec(headerLine);
  const checked = m ? m[1].toLowerCase() === 'x' : !!cf.checked;
  const label = m ? m[2] : (cf.headingText || '');
  container.appendChild(renderCheckbox(ctx, payload, block.startLine, headerLine, checked, label, true));
  const metaRow = h('div', 'case-meta-row');
  if (cf.caseId) metaRow.appendChild(h('span', 'chip chip-case-id', cf.caseId));
  if (cf.classification) metaRow.appendChild(h('span', 'chip chip-case-class class-' + classSlug(cf.classification), cf.classification));
  if (cf.marker) metaRow.appendChild(h('span', 'case-marker', cf.marker));
  if (cf.status && cf.status.vocab) metaRow.appendChild(h('span', 'chip chip-case-status src-' + (cf.status.source || 'none'), '状態: ' + cf.status.vocab));
  container.appendChild(metaRow);
  const flat = (cf.sections || []).filter((s) => !s.collapse);
  const collapsibles = (cf.sections || []).filter((s) => s.collapse);
  flat.forEach((sec) => container.appendChild(renderCaseSection(sec)));
  if (cf.concerns && cf.concerns.length) {
    const secEl = h('div', 'case-sec case-sec-concern');
    secEl.appendChild(h('div', 'case-sec-label', '8 気になる点（◆）'));
    secEl.appendChild(h('pre', 'case-sec-body', dedentLines(cf.concerns)));
    container.appendChild(secEl);
  }
  collapsibles.forEach((sec) => {
    const d = h('details', 'case-collapse');
    d.appendChild(h('summary', 'case-sec-label', sec.label + '（参照・折りたたみ）'));
    d.appendChild(h('pre', 'case-sec-body', sectionText(sec)));
    container.appendChild(d);
  });
  container.appendChild(commentRow(ctx, payload, block));
  return container;
}

// 項目直下コメント欄（全ブロック共通）。
function commentRow(ctx, payload, block) {
  const row = h('div', 'sheet-comment-row');
  const ta = h('textarea', 'field sheet-comment-input');
  ta.rows = 1;
  ta.placeholder = '💬 この項目にコメント';
  const send = h('button', 'btn-secondary sheet-comment-send', '追記');
  send.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    send.disabled = true;
    try {
      const updated = await ctx.program.addSheetComment(payload.source, payload.file, block.index, text);
      ctx.toast('コメントを追記しました');
      renderSheet(ctx, updated);
    } catch (e) {
      ctx.toast('コメント追記に失敗: ' + (e.message || e));
      send.disabled = false;
    }
  };
  row.appendChild(ta);
  row.appendChild(send);
  return row;
}

// heading ブロックは先頭行（見出し）を除いた残りを本文に、item ブロックは raw をそのまま。
function blockRest(block) {
  if (block.kind === 'heading') {
    const nl = block.raw.indexOf('\n');
    return nl === -1 ? '' : block.raw.slice(nl + 1).replace(/^\n+/, '');
  }
  return block.raw;
}

// blockRest の先頭行が全文の何行目か（heading は見出し行＋先頭空行ぶんを足す）。
function restStartLine(block) {
  if (block.kind !== 'heading') return block.startLine || 0;
  const nl = block.raw.indexOf('\n');
  if (nl === -1) return block.startLine || 0;
  const afterHeading = block.raw.slice(nl + 1);
  const stripped = afterHeading.length - afterHeading.replace(/^\n+/, '').length; // 先頭空行数（1行=1改行）
  return (block.startLine || 0) + 1 + stripped;
}

// インライン Markdown の軽量整形（**太字**・`code` のみ）。XSS 安全＝text ノードのみで構築。
function renderInlineMd(text) {
  const s = String(text == null ? '' : text);
  const nodes = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push(document.createTextNode(s.slice(last, m.index)));
    if (m[1] !== undefined) { const b = h('strong'); b.textContent = m[1]; nodes.push(b); }
    else { const c = h('code'); c.textContent = m[2]; nodes.push(c); }
    last = re.lastIndex;
  }
  if (last < s.length) nodes.push(document.createTextNode(s.slice(last)));
  if (!nodes.length) nodes.push(document.createTextNode(s));
  return nodes;
}

// §2-4 A: チェックボックス1個。タップ対象＝チェック部分のみ（行全体ではない＝誤タップ防止）。
// isCaseTitle=トップレベル（インデントなし）＝サブ項目タイトル行（大きめ表示）。ラベルはインラインmd整形。
function renderCheckbox(ctx, payload, absLine, lineContent, checked, label, isCaseTitle) {
  const row = h('div', 'sheet-check-row' + (checked ? ' is-checked' : '') + (isCaseTitle ? ' is-case-title' : ''));
  const box = h('button', 'sheet-check-box');
  box.setAttribute('aria-label', checked ? 'チェック済み（タップで解除）' : '未チェック（タップでチェック）');
  box.appendChild(h('span', 'sheet-check-mark', checked ? '☑' : '☐'));
  box.onclick = async () => {
    box.disabled = true;
    try {
      const updated = await ctx.program.toggleSheetCheckbox(payload.source, payload.file, absLine, lineContent);
      renderSheet(ctx, updated);
    } catch (e) {
      ctx.toast('チェック切替に失敗: ' + (e.message || e) + '（開き直してください）');
      box.disabled = false;
    }
  };
  const lab = h('span', 'sheet-check-label');
  renderInlineMd(label).forEach((n) => lab.appendChild(n));
  row.appendChild(box);
  row.appendChild(lab);
  return row;
}

// テキスト領域を行単位で描画。チェックボックス行はタップ可能に、その他は連続を <pre> にまとめる。
// startLine = text 先頭行の全文行番号。preClass は非チェック行の <pre> クラス。
function renderTextRegion(ctx, payload, text, startLine, preClass) {
  const nodes = [];
  const lines = String(text == null ? '' : text).split('\n');
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (t !== '') nodes.push(h('pre', preClass || 'sheet-block-text', t));
    buf = [];
  };
  for (let j = 0; j < lines.length; j++) {
    const m = /^(\s*)- \[([ xX])\] ?(.*)$/.exec(lines[j]);
    if (m) { flush(); nodes.push(renderCheckbox(ctx, payload, startLine + j, lines[j], m[2].toLowerCase() === 'x', m[3], m[1].length === 0)); }
    else buf.push(lines[j]);
  }
  flush();
  return nodes;
}

function renderBlock(ctx, payload, block, group) {
  // CASEブロック（§2-1）: 合成表示（記載順0〜10）へ委譲。
  if (block.kind === 'case' && block.caseFields) return renderComposedCase(ctx, payload, block);
  // 批評ブロックは折りたたみ（details・解釈=見出しに「批評」を含むセクション）。
  const container = block.collapse ? h('details', 'sheet-block sheet-block-collapse') : h('div', 'sheet-block');
  if (block.collapse) {
    container.appendChild(h('summary', 'sheet-block-summary', block.heading || '（批評）'));
  } else if (block.kind === 'heading') {
    const head = h('h' + Math.min(block.level + 1, 6), 'sheet-block-head', block.heading);
    // CASEグループ見出し（§2-3）: 状態色＋承認n/m。
    if (group) {
      head.classList.add('is-case-group', group.approved ? 'grp-approved' : 'grp-open');
      head.appendChild(h('span', 'group-approval' + (group.approved ? ' is-done' : ''),
        (group.approved ? '✓ ' : '') + '承認 ' + group.approvedCount + '/' + group.total));
    }
    container.appendChild(head);
  }
  const rest = blockRest(block);
  if (rest) {
    if (/^\s*- \[[ xX]\]/m.test(rest)) {
      renderTextRegion(ctx, payload, rest, restStartLine(block), 'sheet-block-text').forEach((n) => container.appendChild(n));
    } else {
      container.appendChild(h('pre', 'sheet-block-text', rest));
    }
  }
  container.appendChild(commentRow(ctx, payload, block));
  return container;
}

registerView({ id: 'sheets', tabLabel: 'Sheets', create, onShow });
