'use strict';

// views/sheets.js — Sheets 群（v2.2）。シナリオ／完成定義／RDS を項目単位で表示。
// 正はファイル（読み取り専用）。ユーザー操作＝項目直下の💬コメントのみ（本文編集はしない）。
// 承認は frontmatter state:reviewed かつ review_card ありのシートのみ活性。
// データ層は program.js（listSheets/readSheet/addSheetComment/approveSheet）に委譲。

import { registerView } from '../registry.js';
import { h } from './shared.js';

const SHEET_STATE_LABEL = { draft: '起草中', reviewed: '批評済', approved: '承認済' };

let root, listPane, detailPane, sourcesWrap, titleEl, metaEl, bodyEl;
let sources = [];
let loadedOnce = false;

function create(ctx) {
  root = h('div', 'sheets');

  // 一覧ペイン（ソース別・ファイル名のみ）
  listPane = h('div', 'sheets-list-pane');
  listPane.appendChild(h('p', 'view-hint', 'シナリオ・完成定義・RDS を項目単位で表示。項目直下に💬コメント（本文編集はしません）。承認は批評済シートのみ。'));
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
  if (!ctx.program || !ctx.program.listSheets) return;
  try {
    sources = await ctx.program.listSheets();
    loadedOnce = true;
    renderSources(ctx);
  } catch (e) {
    sourcesWrap.innerHTML = '';
    sourcesWrap.appendChild(h('p', 'view-hint', 'シートの読み込みに失敗: ' + (e.message || e)));
  }
}

function renderSources(ctx) {
  sourcesWrap.innerHTML = '';
  sources.forEach((src) => {
    const group = h('div', 'sheet-source');
    const head = h('div', 'sheet-source-head');
    head.appendChild(h('span', 'sheet-source-label', src.label));
    head.appendChild(h('span', 'sheet-source-count', String(src.files.length)));
    group.appendChild(head);
    if (!src.files.length) {
      group.appendChild(h('p', 'view-hint', '（ファイルなし）'));
    } else {
      const list = h('div', 'sheet-file-list');
      src.files.forEach((f) => {
        const b = h('button', 'sheet-file', f.file);
        b.onclick = () => openSheet(ctx, src.id, f.file);
        list.appendChild(b);
      });
      group.appendChild(list);
    }
    sourcesWrap.appendChild(group);
  });
}

function backToList() {
  detailPane.hidden = true;
  listPane.hidden = false;
}

async function openSheet(ctx, source, file) {
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

// ヘッダの状態チップ＋承認ボタン。frontmatter が無い/state が無いシートは出さない（後方互換）。
function renderHeaderMeta(ctx, payload) {
  metaEl.innerHTML = '';
  const meta = payload.meta || {};
  if (!meta.hasFrontmatter || meta.state == null) return;
  const st = String(meta.state).trim();
  metaEl.appendChild(h('span', 'chip chip-sheet-state state-' + st, SHEET_STATE_LABEL[st] || st));
  if (meta.reviewCard) metaEl.appendChild(h('span', 'chip', 'review: ' + meta.reviewCard));
  // §2-4 B: 全チェックボックスが [x] であることを承認活性条件に追加（未チェックが残れば残数を表示）。
  const cs = payload.checkStats || { total: 0, unchecked: 0 };
  const allChecked = !(cs.unchecked > 0);
  if (cs.total > 0) metaEl.appendChild(h('span', 'chip chip-check' + (allChecked ? ' is-done' : ''),
    allChecked ? '✓ 全チェック済' : '未チェック' + cs.unchecked + '件'));
  const btn = h('button', 'btn-primary sheet-approve', '承認する');
  const canApprove = !!meta.reviewCard && st === 'reviewed' && allChecked;
  btn.disabled = !canApprove;
  if (!canApprove) btn.title = !allChecked
    ? '未チェックの項目が ' + cs.unchecked + ' 件あります（全て [x] で承認できます）'
    : 'review_card があり state: reviewed のときのみ承認できます';
  btn.onclick = () => approve(ctx, payload.source, payload.file, btn);
  metaEl.appendChild(btn);
}

function renderSheet(ctx, payload) {
  renderHeaderMeta(ctx, payload);
  bodyEl.innerHTML = '';
  if (payload.preamble) renderTextRegion(ctx, payload, payload.preamble, payload.preambleStartLine || 0, 'sheet-preamble')
    .forEach((n) => bodyEl.appendChild(n));
  (payload.blocks || []).forEach((b) => bodyEl.appendChild(renderBlock(ctx, payload, b)));
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

// §2-4 A: チェックボックス1個（タップでトグル）。
function renderCheckbox(ctx, payload, absLine, lineContent, checked, label) {
  const box = h('button', 'sheet-check' + (checked ? ' is-checked' : ''));
  box.appendChild(h('span', 'sheet-check-mark', checked ? '☑' : '☐'));
  box.appendChild(h('span', 'sheet-check-label', label));
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
  return box;
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
    if (m) { flush(); nodes.push(renderCheckbox(ctx, payload, startLine + j, lines[j], m[2].toLowerCase() === 'x', m[3])); }
    else buf.push(lines[j]);
  }
  flush();
  return nodes;
}

function renderBlock(ctx, payload, block) {
  // 批評ブロックは折りたたみ（details・解釈=見出しに「批評」を含むセクション）。
  const container = block.collapse ? h('details', 'sheet-block sheet-block-collapse') : h('div', 'sheet-block');
  if (block.collapse) {
    container.appendChild(h('summary', 'sheet-block-summary', block.heading || '（批評）'));
  } else if (block.kind === 'heading') {
    container.appendChild(h('h' + Math.min(block.level + 1, 6), 'sheet-block-head', block.heading));
  }
  const rest = blockRest(block);
  if (rest) {
    if (/^\s*- \[[ xX]\]/m.test(rest)) {
      renderTextRegion(ctx, payload, rest, restStartLine(block), 'sheet-block-text').forEach((n) => container.appendChild(n));
    } else {
      container.appendChild(h('pre', 'sheet-block-text', rest));
    }
  }
  // 項目直下コメント（本文編集はしない＝コメントのみ）。
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
  container.appendChild(row);
  return container;
}

async function approve(ctx, source, file, btn) {
  if (!window.confirm('このシートを承認しますか？（reviewカードへOK＋消化・シートを承認済に更新します）')) return;
  btn.disabled = true;
  try {
    const res = await ctx.program.approveSheet(source, file);
    ctx.toast('承認しました');
    renderSheet(ctx, res.sheet);
    if (ctx.reload) await ctx.reload(); // reviewカードの状態変更をカード側へ反映
  } catch (e) {
    ctx.toast('承認に失敗: ' + (e.message || e));
    btn.disabled = false;
  }
}

registerView({ id: 'sheets', tabLabel: 'Sheets', create, onShow });
