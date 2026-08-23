'use strict';

// views/gamedata.js — データ 群（便23・build 49・Mac板 便16〜18 の移植）。
// §0-9「2板同内容の原則」（2026-08-23ユーザー裁定）の適用第1弾。
// 正はファイル（台帳 GAME_MASTER_DATA.md ／定義文書 Projects/GameMode/Data/*.md ／
// データファイル game-prototype/data/*.json）。導出は parser.js（Mac server.js と同名・挙動互換）。
// この画面から書けるのは2つだけ＝定義文書の💬（ご意見）と、行ごとの確認の印。
// クラスの違いで表示・操作を変えない（文言だけが変わる＝台帳§3bの決め）。
// md記号ゼロ保証で textContent へ流す（h は textContent 設定・stripInlineMdNoise を通す）。

import { registerView } from '../registry.js';
import { h } from './shared.js';
import { stripInlineMdNoise } from '../parser.js';

function txt(tag, cls, s) { return h(tag, cls, stripInlineMdNoise(s == null ? '' : String(s))); }

let root, srcEl, toolbar, searchEl, distEl, bodyEl, ctxRef;
const state = { data: null, query: '', selected: null, detail: {}, error: {}, draft: {}, busy: {}, notice: {} };

// ---- Mac板と同名の純ロジック（挙動互換） ----
function gdCompactValue(v, depth) {
  const d = depth == null ? 0 : depth;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (d >= 3) return '…';
  if (Array.isArray(v)) return v.map((x) => gdCompactValue(x, d + 1)).filter((s) => s !== '').join('、');
  if (typeof v === 'object') {
    if (typeof v.type === 'string' && (typeof v.id === 'string' || typeof v.id === 'number')) return v.type + ':' + v.id;
    return Object.keys(v).map((k) => k + '=' + gdCompactValue(v[k], d + 1)).join(' ');
  }
  return String(v);
}
function gdClassText(row) {
  const key = (row && row.managementClass) || '';
  if (!key) return 'クラス —';
  const label = (row && row.classLabel) || '';
  return 'クラス' + key + (label ? '（' + label + '）' : '');
}
function gdStageOf(stages, n) { return (stages || []).find((s) => s.n === n) || null; }
function gdImplText(row) {
  const s = (row && row.implState) || '';
  if (s === 'implemented') return '実装投入済み';
  if (s === 'candidate') return '検討中の候補';
  return '';
}
function gdCheckText(row) {
  const c = row && row.checkCounts;
  if (!c || !c.rows) return '';
  const parts = ['確認済み ' + c.checked + '／' + c.rows + '行'];
  if (c.stale) parts.push('原文が新しい ' + c.stale);
  return parts.join('・');
}
function gdItemCountText(row) {
  if (!row.fileExists) {
    if (row.docExists) {
      if (row.docError) return '定義文書を読めません';
      return '候補' + (row.candidateRows || 0) + '行（共同編集中）';
    }
    return 'データファイル未作成';
  }
  if (!row.boardVisible) return 'ボードに出さない設定';
  if (row.itemCount == null) return '中身の並びなし（設定の形）';
  return row.itemCount + '件';
}

function create(ctx) {
  ctxRef = ctx;
  root = h('div', 'gamedata');
  srcEl = h('div', 'gd-source view-hint');
  root.appendChild(srcEl);

  toolbar = h('div', 'gd-toolbar');
  searchEl = h('input', 'k-search');
  searchEl.type = 'search';
  searchEl.placeholder = 'データ種の名前・内容で探す';
  searchEl.oninput = () => { state.query = searchEl.value; render(); };
  toolbar.appendChild(searchEl);
  root.appendChild(toolbar);

  root.appendChild(legendDetails());
  distEl = h('div', 'gd-dist');
  root.appendChild(distEl);

  bodyEl = h('div', 'gd-body');
  bodyEl.textContent = '読み込み中…';
  root.appendChild(bodyEl);
  return root;
}

// 凡例（Mac板の凡例パネルの「データ」節と同じ内容）。
function legendDetails() {
  const d = h('details', 'gd-legend');
  d.appendChild(h('summary', 'gd-legend-sum', '言葉と記号の意味（データ）'));
  const b = h('div', 'gd-legend-body');
  const line = (s) => b.appendChild(h('div', '', s));
  line('進み具合の6つの段 ①②③④⑤⑥: 台帳が決めた段の順番。いま居る段を濃く示し、その段の名前を横に出します');
  line('誰が書くかのクラス: 台帳§3bの言い方をそのまま出します。クラスによる表示・操作の差はありません');
  line('中身の件数: データファイルがある種は件数、定義文書だけの種は「候補n行（共同編集中）」、どちらも無い種は「データファイル未作成」');
  line('⚠️: 定義文書の中の「重複疑い・どちらも残してある」印です');
  line('💬: 定義文書のご意見欄です。この画面から書くと、文書のその節の💬へそのまま入ります（↳＝データ担当の応答）');
  line('📱: モバイルから書いたご意見に付く印です（誰がどこから書いたかが後から分かります）');
  line('実装への投入: 「実装投入済み」＝データファイルが作られた種／「検討中の候補」＝まだ定義文書だけの種');
  line('確認（候補表の各行の印）: あなたが読んで確かめた印です。記録はボード側に持ち、定義文書は書き換えません。種の最終承認そのものではありません');
  line('原文が新しい: 確認したあとにその行の原文が変わった印です。確認は無効になり、読み直しが要ります');
  d.appendChild(b);
  return d;
}

async function onShow(ctx) {
  ctxRef = ctx;
  if (state.data) return;
  await load();
}

async function load() {
  try {
    state.data = await ctxRef.program.loadGameData();
    render();
  } catch (e) {
    bodyEl.textContent = '';
    bodyEl.appendChild(h('div', 'view-hint', 'データの読み込みに失敗: ' + (e && e.message ? e.message : e)));
  }
}

async function loadDetail(type) {
  try {
    state.detail[type] = await ctxRef.program.loadGameDataDetail(type);
    delete state.error[type];
  } catch (e) {
    state.error[type] = e && e.message ? e.message : String(e);
  }
  render();
}

function render() {
  if (!bodyEl) return;
  bodyEl.textContent = '';
  distEl.textContent = '';
  const data = state.data;
  if (!data) { bodyEl.appendChild(h('div', 'view-hint', '読み込み中…')); return; }

  const t = data.ledger.title || {};
  const defSrc = (data.defDir && data.defDir.source) ? data.defDir.source : '';
  srcEl.textContent = '種の正は台帳 ' + data.ledger.source
    + (t.version ? '（' + t.version + (t.statusNote ? '・' + t.statusNote : '') + '）' : '') + '、'
    + (defSrc ? '中身の正は定義文書 ' + defSrc + '/〈データ種〉.md、' : '')
    + '実装に渡すのはデータファイル ' + data.dataDir.source + ' です。この画面から書けるのは定義文書の💬（ご意見）と、行ごとの確認の印だけです。';

  if (!data.available) {
    bodyEl.appendChild(h('div', 'view-hint', '台帳（' + data.ledger.source + '）が見つかりません。台帳が置かれれば、この画面はそのまま表示できます。'));
    return;
  }

  const chip = (s, cls) => distEl.appendChild(h('span', 'gd-dist-chip' + (cls ? ' ' + cls : ''), s));
  chip('データ種 ' + data.counts.total);
  chip('データファイルのある種 ' + data.counts.withFile + '／' + data.counts.total);
  if (data.counts.withDoc) chip('定義文書のある種 ' + data.counts.withDoc + '／' + data.counts.total + '（候補' + (data.counts.candidateRows || 0) + '行）');
  chip('実装投入済み ' + (data.counts.implemented || 0));
  if (data.counts.candidates) chip('検討中の候補 ' + data.counts.candidates + '種');
  if (data.counts.candidateRows) chip('確認済みの行 ' + (data.counts.checkedRows || 0) + '／' + data.counts.candidateRows);
  if (data.counts.staleCheckedRows) chip('原文が新しい行 ' + data.counts.staleCheckedRows, 'is-warn');
  (data.lifecycle || []).forEach((s) => {
    const n = data.counts.byLifecycle[s.n] || 0;
    if (n) chip(s.mark + s.label + ' ' + n);
  });
  Object.keys(data.counts.byClass).sort().forEach((k) => chip('クラス' + k + ' ' + data.counts.byClass[k]));
  if (data.counts.withWarning) chip('確認してほしい点のある種 ' + data.counts.withWarning, 'is-warn');

  const q = state.query.trim().toLowerCase();
  const match = (x) => !q || (x.type + ' ' + x.nameJa + ' ' + x.defines + ' ' + x.mainFields).toLowerCase().includes(q);
  const rows = data.types.filter(match);
  if (!rows.length) { bodyEl.appendChild(h('div', 'view-hint', '（該当なし）')); return; }

  const groups = [];
  (data.ledger.categories || []).forEach((c) => {
    const list = rows.filter((x) => x.category === c.key);
    if (list.length) groups.push({ title: c.key + '. ' + c.label + '（' + list.length + '種）', list });
  });
  const orphan = rows.filter((x) => !x.category);
  if (orphan.length) groups.push({ title: '台帳に載っていない種（' + orphan.length + '）', list: orphan });
  groups.forEach((g) => {
    bodyEl.appendChild(txt('div', 'gd-group-title', g.title));
    g.list.forEach((row) => bodyEl.appendChild(typeCard(row, data)));
  });
}

// 狭い画面のため、Mac板の表1行ぶんをカード1枚にする（出す中身は同じ）。
function typeCard(row, data) {
  const open = state.selected === row.type;
  const card = h('div', 'gd-card' + (open ? ' is-open' : ''));
  const head = h('div', 'gd-card-head');
  head.onclick = () => {
    state.selected = open ? null : row.type;
    if (!open && !state.detail[row.type]) loadDetail(row.type); else render();
  };
  head.appendChild(h('span', 'gd-caret', open ? '▾' : '▸'));
  head.appendChild(txt('span', 'gd-name', row.nameJa || row.type));
  head.appendChild(h('span', 'gd-type', row.type));
  card.appendChild(head);

  const chips = h('div', 'gd-card-chips');
  const impl = gdImplText(row);
  if (impl) chips.appendChild(h('span', 'chip gd-impl gd-impl-' + row.implState, impl));
  if (!row.boardVisible) chips.appendChild(h('span', 'chip gd-hidden', 'ボードに出さない設定'));
  if (row.warnings && row.warnings.length) chips.appendChild(h('span', 'chip gd-warn', '確認してほしい点 ' + row.warnings.length));
  chips.appendChild(h('span', 'chip gd-class', gdClassText(row)));
  card.appendChild(chips);

  card.appendChild(lifecycleBar(row, data.lifecycle));
  const line = h('div', 'gd-card-items');
  line.appendChild(h('span', '', gdItemCountText(row)));
  const chk = gdCheckText(row);
  if (chk) line.appendChild(h('div', 'gd-check-sum', chk));
  card.appendChild(line);

  if (open) card.appendChild(detailBody(row, data));
  return card;
}

function lifecycleBar(row, stages) {
  const wrap = h('div', 'gd-lc');
  const steps = h('span', 'gd-lc-steps');
  (stages || []).forEach((s) => {
    const cls = 'gd-lc-step' + (s.n === row.lifecycle ? ' is-now' : (s.n < row.lifecycle ? ' is-past' : ''));
    const sp = h('span', cls, s.mark);
    sp.title = s.mark + s.rawLabel;
    steps.appendChild(sp);
  });
  wrap.appendChild(steps);
  const now = gdStageOf(stages, row.lifecycle);
  wrap.appendChild(h('span', 'gd-lc-now', now ? now.mark + now.label : '段が不明'));
  return wrap;
}

function field(label, nodes) {
  const r = h('div', 'gd-field');
  r.appendChild(h('span', 'gd-field-label', label));
  const v = h('div', 'gd-field-val');
  nodes.forEach((n) => v.appendChild(n));
  r.appendChild(v);
  return r;
}
const t2n = (s) => document.createTextNode(stripInlineMdNoise(s == null ? '' : String(s)));

function detailBody(row, data) {
  const body = h('div', 'gd-detail');
  const detail = state.detail[row.type] || null;
  const err = state.error[row.type];

  if (row.inLedger) {
    if (row.defines) body.appendChild(field('何を決めるか', [t2n(row.defines)]));
    if (row.mainFields) body.appendChild(field('主な項目', [t2n(row.mainFields)]));
    if (row.relations) body.appendChild(field('主な関係', [t2n(row.relations)]));
  } else {
    body.appendChild(field('台帳', [t2n('台帳に載っていない種です（データファイルだけが先にあります）。')]));
  }
  (row.notes || []).forEach((n) => body.appendChild(field('注記', [t2n(n)])));

  const classNote = row.classSource === 'file' ? 'データファイルの決めによる'
    : (row.classSource === 'ledger' ? '台帳の決めによる' : '決めがまだありません');
  body.appendChild(field('誰が書くか', [h('span', 'chip gd-class', gdClassText(row)), h('span', 'gd-src-note', classNote)]));

  const now = gdStageOf(data.lifecycle, row.lifecycle);
  const lcNote = row.lifecycleSource === 'file' ? 'データファイルの決めによる'
    : (row.lifecycleSource === 'doc' ? '定義文書の状態の書き方による'
      : '進み具合の記録がまだ無いため最初の段として扱っています');
  const lcRaw = (now && now.rawLabel !== now.label) ? '台帳の書き方: ' + now.rawLabel + '／' : '';
  body.appendChild(field('進み具合', [lifecycleBar(row, data.lifecycle), h('span', 'gd-src-note', lcRaw + lcNote)]));

  const implText = gdImplText(row);
  if (implText) {
    const implNote = row.implState === 'implemented'
      ? 'データファイルがあります（最終承認のあとに作られる形）。'
      : 'まだ定義文書だけの段階です（実装へ渡すのは最終承認のあと）。';
    body.appendChild(field('実装への投入', [h('span', 'chip gd-impl gd-impl-' + row.implState, implText), h('span', 'gd-src-note', implNote)]));
  }
  const checkText = gdCheckText(row);
  if (checkText) body.appendChild(field('確認の進み', [t2n(checkText + '（あなたが読んで確かめた印です。種の最終承認そのものではありません）')]));

  if (row.warnings && row.warnings.length) {
    const w = h('div', 'gd-warn-list');
    row.warnings.forEach((x) => w.appendChild(txt('div', 'gd-warn-item', x)));
    body.appendChild(field('確認してほしい点', [w]));
  }

  if (err) { body.appendChild(h('div', 'view-hint', '中身の読み込みに失敗: ' + err)); return body; }
  if (!detail) { body.appendChild(h('div', 'view-hint', '読み込み中…')); return body; }
  if (detail.error) { body.appendChild(h('div', 'view-hint', detail.error)); return body; }

  if (detail.doc) body.appendChild(field('中身の正（定義文書）', [docBox(detail.doc, row.type)]));

  if (!row.fileExists) {
    if (detail.doc) {
      body.appendChild(field('データファイル', [t2n('実装に渡すデータファイル（' + data.dataDir.source + '/' + row.type
        + '.json）はまだありません。中身の正は上の定義文書で、JSONは最終承認のあとに作ります。')]));
      return body;
    }
    const s = (data.schema && data.schema.title) || null;
    const st = s ? ('項目の設計（' + data.schema.source + '・' + (s.version || '') + (s.statusNote ? '・' + s.statusNote : '') + '）')
      : '項目の設計の文書が見つかりません';
    body.appendChild(field('中身', [t2n('データファイル（' + data.dataDir.source + '/' + row.type + '.json）はまだありません。今の段階は ' + st + ' です。')]));
    return body;
  }
  if (detail.itemsHidden) {
    body.appendChild(field('中身', [t2n('ボードに出さない設定です。理由: ' + (detail.hiddenReason || '（理由が書かれていません）'))]));
    return body;
  }
  if (detail.meta) body.appendChild(field('ファイルの属性', [metaTable(detail.meta)]));
  if (Array.isArray(detail.items)) {
    if (!detail.items.length) body.appendChild(field('中身', [t2n('中身はまだ0件です。')]));
    else body.appendChild(field('中身（' + detail.items.length + '件）', [itemsTable(detail.items)]));
  } else {
    body.appendChild(field('中身', [t2n('中身の並び（items）を持たない形のファイルです。')]));
  }
  return body;
}

// 定義文書（中身の正）。候補表は原文のまま・言い換えない。
function docBox(doc, type) {
  const box = h('div', 'gd-doc');
  box.appendChild(h('div', 'gd-doc-lead',
    '中身の正はこの定義文書です。ご意見は下の💬欄から書けます（文書のその節の💬へそのまま入り、モバイルからの分には📱が付きます）。行の追加や書き換えは、いまのところ文書へ直接どうぞ。'));
  const head = ((doc.title && doc.title.raw) || '').replace(/^#\s+/, '');
  if (head) box.appendChild(field('文書', [t2n(head)]));
  if (doc.source) box.appendChild(field('置き場所', [t2n(doc.source)]));
  if (doc.statusLine) box.appendChild(field('文書の状態', [t2n(doc.statusLine)]));
  if (doc.error) { box.appendChild(field('読み取り', [t2n(doc.error)])); return box; }
  const parts = ['候補' + doc.candidateRows + '行（共同編集中）'];
  if (doc.warnRows) parts.push('⚠️の付いた行 ' + doc.warnRows);
  if (doc.commentSlots) parts.push('💬 ' + doc.commentSlots + 'か所（記入あり ' + doc.commentSlotsFilled + '）');
  if (doc.checkCounts && doc.checkCounts.rows) {
    parts.push('確認済み ' + doc.checkCounts.checked + '／' + doc.checkCounts.rows + '行');
    if (doc.checkCounts.stale) parts.push('原文が新しい ' + doc.checkCounts.stale + '行');
  }
  box.appendChild(field('いまの量', [t2n(parts.join('／'))]));
  if (state.notice[type]) box.appendChild(h('div', 'gd-notice', state.notice[type]));
  (doc.tables || []).filter((t) => t.kind === 'candidate').forEach((t) => {
    const cell = h('div', 'gd-doc-section');
    cell.appendChild(docTable(t, type));
    cell.appendChild(docThread(doc, t, type));
    box.appendChild(field(stripInlineMdNoise(t.section) || '候補表', [cell]));
  });
  return box;
}

// 候補表1つ（列＝文書のヘッダそのまま・先頭に確認の印）。
function docTable(t, type) {
  const wrap = h('div', 'gd-items-wrap');
  const table = h('table', 'gd-table gd-items');
  const thead = h('thead');
  const hr = h('tr');
  hr.appendChild(h('th', 'gd-check-col', '確認'));
  (t.headers || []).forEach((x) => hr.appendChild(txt('th', '', x)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  (t.rows || []).forEach((r, ri) => {
    const meta = (t.rowMeta || [])[ri] || {};
    const tr = h('tr', meta.stale ? 'is-stale' : '');
    const ctd = h('td', 'gd-check-col');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!meta.checked;
    box.disabled = !!state.busy[type];
    box.title = meta.checked && meta.checkedAt ? ('確認: ' + meta.checkedAt) : '読んで確かめた印（記録はボード側・文書は変わりません）';
    box.onclick = (ev) => { ev.stopPropagation(); toggleCheck(type, meta.id); };
    ctd.appendChild(box);
    if (meta.stale) ctd.appendChild(h('div', 'gd-stale', '原文が新しい'));
    tr.appendChild(ctd);
    (t.headers || []).forEach((x, i) => tr.appendChild(txt('td', '', r[i] == null ? '' : r[i])));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// 節ごとの💬のやりとりと記入欄。
function docThread(doc, t, type) {
  const wrap = h('div', 'gd-thread');
  const slots = (doc.comments || []).filter((c) => c.sectionLine === t.sectionLine);
  const written = slots.filter((c) => c.filled);
  if (!written.length) wrap.appendChild(h('div', 'gd-thread-empty', 'この節へのご意見はまだありません。'));
  written.forEach((c) => {
    const item = h('div', 'gd-thread-item');
    item.appendChild(txt('div', 'gd-thread-comment', '💬 ' + c.text));
    (c.replies || []).forEach((rp) => item.appendChild(txt('div', 'gd-thread-reply', (rp.kind === 'reply' ? '↳ ' : '') + rp.text)));
    wrap.appendChild(item);
  });
  if (!slots.length) {
    wrap.appendChild(h('div', 'gd-thread-empty', 'この節には💬の欄がないため、ボードからは書き込めません（文書へ直接どうぞ）。'));
    return wrap;
  }
  const key = type + '\n' + t.section;
  const form = h('div', 'gd-thread-form');
  const sel = document.createElement('select');
  sel.className = 'gd-thread-row';
  sel.appendChild(new Option('この節ぜんたいについて', ''));
  (t.rowMeta || []).forEach((m, i) => {
    if (!m.id) return;
    sel.appendChild(new Option(m.id + '（' + stripInlineMdNoise(((t.rows || [])[i] || [])[1] || '') + '）', m.id));
  });
  sel.value = state.draft[key + '\nrow'] || '';
  sel.onchange = () => { state.draft[key + '\nrow'] = sel.value; };
  const ta = document.createElement('textarea');
  ta.className = 'gd-thread-text';
  ta.rows = 3;
  ta.placeholder = 'この節へのご意見（文書の💬へそのまま入ります・📱が付きます）';
  ta.value = state.draft[key] || '';
  ta.oninput = () => { state.draft[key] = ta.value; };
  const btn = h('button', 'btn-secondary', state.busy[type] ? '書き込み中…' : '💬へ書く');
  btn.disabled = !!state.busy[type];
  btn.onclick = (ev) => { ev.stopPropagation(); submitComment(type, t.section, t.sectionAnchor, sel.value, key); };
  form.appendChild(sel);
  form.appendChild(ta);
  form.appendChild(btn);
  form.onclick = (ev) => ev.stopPropagation();
  wrap.appendChild(form);
  return wrap;
}

const META_LABEL = {
  type: 'データ種の名前', schemaVersion: '項目設計の版', managementClass: '誰が書くか',
  lifecycle: '進み具合の段', boardVisible: 'ボードに出すか', boardExclusionReason: 'ボードに出さない理由',
};
function metaTable(meta) {
  const table = h('table', 'gd-kv');
  Object.keys(meta).forEach((k) => {
    const tr = h('tr');
    tr.appendChild(h('th', '', META_LABEL[k] || k));
    tr.appendChild(txt('td', '', gdCompactValue(meta[k])));
    table.appendChild(tr);
  });
  return table;
}

function itemsTable(items) {
  const cols = [];
  items.forEach((it) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return;
    Object.keys(it).forEach((k) => { if (cols.indexOf(k) < 0) cols.push(k); });
  });
  const wrap = h('div', 'gd-items-wrap');
  const table = h('table', 'gd-table gd-items');
  const thead = h('thead');
  const hr = h('tr');
  cols.forEach((c) => hr.appendChild(h('th', '', c)));
  if (!cols.length) hr.appendChild(h('th', '', '中身'));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  items.forEach((it) => {
    const tr = h('tr');
    if (!cols.length) { tr.appendChild(txt('td', '', gdCompactValue(it))); tbody.appendChild(tr); return; }
    cols.forEach((c) => tr.appendChild(txt('td', '', gdCompactValue(it && it[c]))));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ---- 書き込み2つ（Sheetと同水準の安全機構＝program.js 側・ここは呼ぶだけ） ----

async function apply(type, fn, okNotice) {
  if (state.busy[type]) return;
  state.busy[type] = true;
  state.notice[type] = '';
  render();
  try {
    const res = await fn();
    if (res && res.detail) state.detail[type] = res.detail;
    state.notice[type] = okNotice || '';
    delete state.error[type];
  } catch (e) {
    state.notice[type] = '書き込めませんでした: ' + (e && e.message ? e.message : e);
  } finally {
    state.busy[type] = false;
    // 一覧側の集計（確認済みの行数など）も追随させる
    try { state.data = await ctxRef.program.loadGameData(); } catch { /* 一覧の再取得に失敗しても詳細は出す */ }
    render();
  }
}

function submitComment(type, section, anchor, rowId, key) {
  const text = (state.draft[key] || '').trim();
  if (!text) { state.notice[type] = 'ご意見が空です。'; render(); return; }
  apply(type, () => ctxRef.program.addGameDocComment(type, { type, section, anchor, rowId: rowId || '', comment: text }),
    '💬へ書きました（📱が付いています）。')
    .then(() => { state.draft[key] = ''; render(); });
}

function toggleCheck(type, rowId) {
  if (!rowId) return;
  apply(type, () => ctxRef.program.toggleGameRowCheck(type, rowId));
}

registerView({
  id: 'gamedata',
  tabLabel: 'データ',
  create,
  onShow,
});
