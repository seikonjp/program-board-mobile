'use strict';

// views/production.js — 制作 群（便22・build 48・Mac板 便20/21 の移植）。
// ゲーム制作の要素（モデル・質感・設定など）をタイルで管理し、やるべきものの全量・分量・
// 進みを俯瞰する。正はファイル（Program/data/production/ の3ファイル・読み取り専用）。
// 導出は parser.js（Mac server.js と同名・挙動互換）へ委譲＝二重の正を作らない。
// 段階の点列は3記号（済●／飛ばした−／未○）。凡例は画面内の折りたたみで宣言する。

import { registerView } from '../registry.js';
import { h } from './shared.js';
import {
  prodInShelf, prodMatches, prodStageOptions, prodQuantityText,
  prodBarText, prodBarRatio, prodShelvesWithProgress,
} from '../parser.js';

// 大項目ごとの仮のサムネイル（画像は後便・Mac板と同じ割り当て）。
const PLACEHOLDER = {
  beings: '🧍', nature: '🌳', architecture: '🏠', props: '🪑', materialShelf: '🎨',
  fxAudio: '🔊', ui: '🖥', settings: '📋', writing: '📝', reference: '🖼',
};
function placeholder(topKey) { return PLACEHOLDER[topKey] || '📦'; }

let root, switchBar, toolbar, searchEl, tagEl, stageEl, noteEl, bodyEl;
const state = { data: null, view: 'tiles', shelf: null, query: '', tag: '', stage: '', treeOpen: false };

function create() {
  root = h('div', 'production');

  switchBar = h('div', 'pb-switch');
  [['tiles', 'タイル'], ['overview', '俯瞰']].forEach(([key, label]) => {
    const b = h('button', 'pb-switch-btn' + (key === state.view ? ' is-active' : ''), label);
    b.dataset.prodview = key;
    b.onclick = () => setView(key);
    switchBar.appendChild(b);
  });
  root.appendChild(switchBar);

  toolbar = h('div', 'prod-toolbar');
  searchEl = h('input', 'k-search');
  searchEl.type = 'search';
  searchEl.placeholder = '内部名・日本語名・内容で探す';
  searchEl.oninput = () => { state.query = searchEl.value; render(); };
  tagEl = h('select', 'prod-select');
  tagEl.onchange = () => { state.tag = tagEl.value; render(); };
  stageEl = h('select', 'prod-select');
  stageEl.onchange = () => { state.stage = stageEl.value; render(); };
  toolbar.appendChild(searchEl);
  toolbar.appendChild(tagEl);
  toolbar.appendChild(stageEl);
  root.appendChild(toolbar);

  root.appendChild(legendDetails());
  noteEl = h('div', 'prod-note view-hint');
  root.appendChild(noteEl);

  bodyEl = h('div', 'prod-body');
  bodyEl.textContent = '読み込み中…';
  root.appendChild(bodyEl);
  return root;
}

// 凡例（画面に出す記号は必ずここで宣言する・Mac板の凡例パネルと同じ内容）。
function legendDetails() {
  const d = h('details', 'prod-legend');
  d.appendChild(h('summary', 'prod-legend-sum', '言葉と記号の意味（制作）'));
  const b = h('div', 'prod-legend-body');
  const line = (s) => b.appendChild(h('div', '', s));
  line('段階の点列: ● 済んだ段階 ／ − 飛ばした段階（作らずに先へ進めたもの） ／ ○ これからの段階。右にいまいる段階の名前を出します');
  line('作成フロー: 棚ごとに決まっている作り方の順番です（7種類あり、段階の数も名前も種類ごとに違います）');
  line('完了: その棚の作成フローの最後の段階（実機確認・反映済みなど）まで来たものを数えます');
  line('棚の進捗: 目標数のある棚にだけ出ます。そろえる件数を自分で持つ棚（設定データなど）はその件数を、それ以外の棚は完了した件数を数えます（二重に数えないため）');
  line('0件の棚: 何も無い棚も隠さず出します（何が手つかずかが分かることが目的のため）');
  line('分割予定: いまは1つの棚にまとめてあり、件数が増えたら中で分ける予定の棚です');
  line('サムネイル: 画像はまだありません。いまは棚ごとの絵文字を仮に出しています');
  line('この画面は読むだけです。中身を直すのは制作データの担当で、ボードからは書き換えません');
  d.appendChild(b);
  return d;
}

function setView(view) {
  state.view = view;
  if (root) root.querySelectorAll('.pb-switch-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.prodview === view));
  if (toolbar) toolbar.hidden = (view !== 'tiles');
  render();
}

async function onShow(ctx) {
  if (state.data) return;
  await load(ctx);
}

async function load(ctx) {
  try {
    state.data = await ctx.program.loadProduction();
    fillFilters();
    render();
  } catch (e) {
    if (bodyEl) { bodyEl.textContent = ''; bodyEl.appendChild(h('div', 'view-hint', '制作データの読み込みに失敗: ' + (e && e.message ? e.message : e))); }
  }
}

function fillFilters() {
  const d = state.data;
  if (!d || !d.available) return;
  if (tagEl && tagEl.options.length === 0) {
    tagEl.appendChild(new Option('タグ: すべて', ''));
    for (const t of d.tags) tagEl.appendChild(new Option('タグ: ' + t.label + '（' + t.count + '）', t.label));
  }
  if (stageEl && stageEl.options.length === 0) {
    stageEl.appendChild(new Option('段階: すべて', ''));
    for (const s of prodStageOptions(d.items)) stageEl.appendChild(new Option('段階: ' + s.label + '（' + s.count + '）', s.label));
  }
}

function render() {
  if (!bodyEl) return;
  bodyEl.textContent = '';
  const d = state.data;
  if (!d) { bodyEl.appendChild(h('div', 'view-hint', '読み込み中…')); return; }
  if (!d.available) {
    const missing = [...(d.missing || []), ...(d.unreadable || [])];
    noteEl.textContent = '';
    bodyEl.appendChild(h('div', 'view-hint', '制作データがまだ置かれていません（' + d.source + '）。読めなかったファイル: ' + (missing.join('・') || 'なし')));
    return;
  }
  noteEl.textContent = 'もと＝' + d.source + '／全' + d.counts.items + '件・棚' + d.counts.shelves
    + '（うち空の棚' + d.counts.emptyShelves + '）・完了' + d.counts.done + '件';
  if (state.view === 'tiles') renderTiles();
  else renderOverview();
}

// ---- タイル（狭い画面なので、棚は折りたたみの一覧＋いま見ている棚の見出し） ----
function renderTiles() {
  const d = state.data;
  bodyEl.appendChild(shelfPicker());

  const shown = d.items.filter((it) => prodInShelf(it, state.shelf) && prodMatches(it, state.query, state.tag, state.stage));
  const head = h('div', 'prod-shelf-head');
  head.appendChild(h('span', 'prod-shelf-title', state.shelf ? trailLabels(state.shelf).join(' ＞ ') : 'すべての棚'));
  head.appendChild(h('span', 'prod-shelf-sub', shown.length + '件を表示' + (state.shelf ? '（この棚と下位の棚）' : '')));
  const shelf = state.shelf ? (d.bars || []).find((b) => b.path === state.shelf) : null;
  if (shelf && shelf.bar) head.appendChild(barEl(shelf));
  bodyEl.appendChild(head);

  if (!shown.length) {
    bodyEl.appendChild(h('div', 'view-hint', state.shelf && !state.query && !state.tag && !state.stage
      ? 'この棚にはまだ何もありません（これから作るところです）。'
      : '条件に合うものがありません。'));
    return;
  }
  const grid = h('div', 'prod-tiles');
  for (const it of shown) grid.appendChild(cardEl(it));
  bodyEl.appendChild(grid);
}

// 棚の選択（0件の棚も出す＝空棚の可視化。狭い画面のため既定は畳んでおく）。
function shelfPicker() {
  const d = h('details', 'prod-shelfpick');
  d.open = state.treeOpen;
  d.ontoggle = () => { state.treeOpen = d.open; };
  d.appendChild(h('summary', 'prod-shelfpick-sum', '棚を選ぶ（0件の棚も出します）'));
  const list = h('div', 'prod-tree');
  const rowEl = (label, path, count, depth, flatStart, note) => {
    const b = h('button', 'prod-tree-row prod-depth-' + depth + (state.shelf === path ? ' is-active' : '') + (count === 0 ? ' is-empty' : ''));
    b.appendChild(h('span', 'prod-tree-label', label));
    if (flatStart) b.appendChild(h('span', 'prod-chip', '分割予定'));
    b.appendChild(h('span', 'prod-tree-count', String(count)));
    if (note) b.title = note;
    b.onclick = () => { state.shelf = path; render(); };
    return b;
  };
  list.appendChild(rowEl('すべて', null, state.data.counts.items, 0, false, ''));
  const walk = (nodes) => {
    for (const n of nodes) {
      list.appendChild(rowEl(n.label, n.path, n.total, n.depth, n.flatStart, n.note));
      if (n.children && n.children.length) walk(n.children);
    }
  };
  walk(state.data.tree);
  d.appendChild(list);
  return d;
}

function nodeByPath(nodes, p) {
  for (const n of nodes) {
    if (n.path === p) return n;
    const hit = n.children && n.children.length ? nodeByPath(n.children, p) : null;
    if (hit) return hit;
  }
  return null;
}
function trailLabels(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.map((_, i) => {
    const n = nodeByPath(state.data.tree, parts.slice(0, i + 1).join('/'));
    return n ? n.label : parts[i];
  });
}

function cardEl(it) {
  const card = h('div', 'prod-card');
  const thumb = h('div', 'prod-thumb');
  if (it.thumbnail) {
    const img = document.createElement('img');
    img.src = it.thumbnail; img.alt = it.name; img.loading = 'lazy';
    thumb.appendChild(img);
  } else {
    thumb.appendChild(h('span', 'prod-thumb-ph', placeholder(it.top)));
  }
  card.appendChild(thumb);
  const body = h('div', 'prod-card-body');
  body.appendChild(h('div', 'prod-card-name', it.name));
  if (it.labelJa) body.appendChild(h('div', 'prod-card-ja', it.labelJa));
  body.appendChild(dotsEl(it));
  const q = prodQuantityText(it);
  if (q) body.appendChild(h('div', 'prod-card-qty', q));
  if ((it.tags || []).length) {
    const tags = h('div', 'prod-card-tags');
    for (const t of it.tags) tags.appendChild(h('span', 'prod-tag', t));
    body.appendChild(tags);
  }
  card.appendChild(body);
  card.onclick = () => openDetail(it);
  return card;
}

function dotsEl(it) {
  const row = h('div', 'prod-stage');
  const dots = h('span', 'prod-dots');
  for (const d of (it.stageDots || [])) {
    const s = h('span', 'prod-dot is-' + d.mark, d.glyph);
    s.title = d.label + '（' + (d.mark === 'done' ? '済' : d.mark === 'skipped' ? '飛ばした' : 'これから') + '）';
    dots.appendChild(s);
  }
  row.appendChild(dots);
  row.appendChild(h('span', 'prod-stage-label', it.stageLabel || '段階が読めません'));
  if (it.stageIndex >= 0) row.appendChild(h('span', 'prod-stage-n', (it.stageIndex + 1) + '/' + it.stageTotal));
  return row;
}

function barEl(shelf) {
  const box = h('div', 'prod-bar-box');
  if (shelf.bar) {
    const bar = h('span', 'prod-bar');
    const fill = h('span', 'prod-bar-fill');
    fill.style.width = Math.round(prodBarRatio(shelf.bar) * 100) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
  }
  box.appendChild(h('span', 'prod-bar-text', prodBarText(shelf)));
  return box;
}

// ---- 俯瞰（大項目×段階の件数＋棚ごとの進み具合） ----
function renderOverview() {
  const d = state.data;
  const s1 = h('div', 'prod-ov-sec');
  s1.appendChild(h('div', 'prod-ov-title', '大項目ごとの段階'));
  s1.appendChild(h('div', 'view-hint', '段階の並びは作成フローごとに違うため、行はそのフローの段階をそのまま並べています。数字はいまその段階にいる件数です。'));
  for (const r of d.overview) {
    const row = h('div', 'prod-ov-row');
    const head = h('div', 'prod-ov-head');
    head.appendChild(h('span', 'prod-ov-top', r.topLabel));
    head.appendChild(h('span', 'prod-ov-flow', r.flowLabel));
    head.appendChild(h('span', 'prod-ov-total', r.total + '件・完了' + r.done));
    row.appendChild(head);
    const cells = h('div', 'prod-ov-cells');
    r.stages.forEach((st, i) => {
      const c = h('div', 'prod-ov-cell' + (st.count ? ' has-count' : '') + (i === r.stages.length - 1 ? ' is-last' : ''));
      c.appendChild(h('span', 'prod-ov-cell-n', String(st.count)));
      c.appendChild(h('span', 'prod-ov-cell-l', st.label));
      cells.appendChild(c);
    });
    row.appendChild(cells);
    s1.appendChild(row);
  }
  bodyEl.appendChild(s1);

  const s2 = h('div', 'prod-ov-sec');
  s2.appendChild(h('div', 'prod-ov-title', '棚ごとの進み具合'));
  s2.appendChild(h('div', 'view-hint', '目標数のある棚はバーを出します。そろえる件数を自分で持つ棚（設定データなど）はその数字を使い、それ以外の棚は完了した件数を数えます。目標数の無い棚は件数だけを出します。'));
  const withProgress = prodShelvesWithProgress(d.bars);
  const omitted = d.bars.length - withProgress.length;
  if (omitted > 0) {
    s2.appendChild(h('div', 'view-hint', 'この節では、目標数も中身もまだ無い棚 ' + omitted + ' 件を省いています（何が手つかずかは、上の段階の表と、タイル画面の棚の一覧で分かります）。'));
  }
  for (const top of d.tree) {
    const shelves = withProgress.filter((b) => b.top === top.key);
    if (!shelves.length) continue;
    const g = h('div', 'prod-ov-group');
    g.appendChild(h('div', 'prod-ov-group-title', top.label));
    for (const sh of shelves) {
      const line = h('div', 'prod-ov-shelf' + (sh.count === 0 ? ' is-empty' : ''));
      line.appendChild(h('span', 'prod-ov-shelf-name', sh.trail.slice(1).join(' ＞ ') || sh.label));
      line.appendChild(barEl(sh));
      g.appendChild(line);
    }
    s2.appendChild(g);
  }
  bodyEl.appendChild(s2);
}

// ---- 詳細（全項目・狭い画面なので画面いっぱいの重ね表示） ----
function openDetail(it) {
  const back = h('div', 'prod-detail-back');
  const pop = h('div', 'prod-detail');
  const head = h('div', 'prod-detail-head');
  head.appendChild(h('span', 'prod-detail-name', it.name));
  const close = h('button', 'prod-detail-close', '×');
  close.onclick = () => back.remove();
  head.appendChild(close);
  pop.appendChild(head);
  if (it.labelJa) pop.appendChild(h('div', 'prod-detail-ja', it.labelJa));

  const thumb = h('div', 'prod-detail-thumb');
  if (it.thumbnail) {
    const img = document.createElement('img');
    img.src = it.thumbnail; img.alt = it.name;
    thumb.appendChild(img);
  } else {
    thumb.appendChild(h('span', 'prod-detail-thumb-ph', placeholder(it.top)));
    thumb.appendChild(h('span', 'prod-detail-thumb-note', '画像はまだありません'));
  }
  pop.appendChild(thumb);

  const kv = (label, value) => {
    if (value === '' || value === null || value === undefined) return;
    const d = h('div', 'prod-kv');
    d.appendChild(h('span', 'prod-kv-k', label));
    d.appendChild(h('span', 'prod-kv-v', String(value)));
    pop.appendChild(d);
  };
  const isSetting = String(it.category || '').indexOf('settings/') === 0 || it.category === 'settings';
  if (it.summary && isSetting) pop.appendChild(h('div', 'prod-detail-body', it.summary));
  else if (it.summary) kv('内容', it.summary);

  pop.appendChild(dotsEl(it));
  kv('棚', (it.categoryTrail || []).join(' ＞ '));
  kv('作成フロー', it.flowLabel);
  const skipped = (it.stageDots || []).filter((d) => d.mark === 'skipped').map((d) => d.label);
  if (skipped.length) kv('飛ばした段階', skipped.join('・'));
  const q = prodQuantityText(it);
  if (q) kv('数量', q);
  if ((it.tags || []).length) kv('タグ', it.tags.join('・'));
  kv('注記', it.note || '');
  kv('更新日', it.updatedAt || '');
  kv('内部ID', it.id);

  back.appendChild(pop);
  back.onclick = (e) => { if (e.target === back) back.remove(); };
  document.body.appendChild(back);
}

registerView({
  id: 'production',
  tabLabel: '制作',
  create,
  onShow,
});
