'use strict';

// views/projects.js — Projects 群（便9・build 40・§5e・HANDOFF_K2便2＝K2b）。
// 正はファイル（CENSUS_B_PJ系.md・読み取り専用）。45PJ＋Review5＋残作業を一望・詳細展開。
// 表示原則（SUPPLEMENT v2 §0）: raw詰め替え不可・確定項目ラベル・md記号ゼロ（stripInlineMdNoise）・
// 省略表現は凡例宣言のみ。状態バケットは「一望の目安」（原文=stateRaw を詳細で常に併記＝偽装しない）。
// データ層は program.js（loadProjects）に委譲。パーサは parser.js（Mac server.js と同名・挙動互換）。

import { registerView } from '../registry.js';
import { h } from './shared.js';
import { stripInlineMdNoise } from '../parser.js';

const BUCKET_LABEL = { provisional: '暫定完成', stopped: '停止・休止', dormant: '起動のみ・移行', inprogress: '進行中', waiting: '待機・確定', done: '完成・完了', other: 'その他' };
const BUCKET_ORDER = ['done', 'provisional', 'inprogress', 'waiting', 'stopped', 'dormant', 'other'];
const PLAN_LABEL = { yes: '残計画 有', 'near-none': '残計画 ほぼ無', no: '残計画 無', unknown: '残計画 —' };
function typeLabel(section) { return section === 'review' ? 'レビュー' : 'プロジェクト'; }

// md記号ゼロ保証で textContent へ流す（h は textContent 設定）。
function txt(tag, cls, s) { return h(tag, cls, stripInlineMdNoise(s == null ? '' : String(s))); }

let root, toolbar, searchEl, distEl, noteEl, listEl;
const state = { data: null, query: '', open: {} };

function create(ctx) {
  root = h('div', 'projects');
  toolbar = h('div', 'pj-toolbar');
  searchEl = h('input', 'k-search');
  searchEl.type = 'search';
  searchEl.placeholder = 'PJ名・状態・Workで検索';
  searchEl.oninput = () => { state.query = searchEl.value; if (state.data) render(); };
  distEl = h('div', 'pj-dist');
  noteEl = h('div', 'pj-note view-hint');
  toolbar.appendChild(searchEl);
  toolbar.appendChild(distEl);
  root.appendChild(toolbar);
  root.appendChild(legendDetails());
  root.appendChild(noteEl);
  listEl = h('div', 'pj-list');
  listEl.textContent = '読み込み中…';
  root.appendChild(listEl);
  return root;
}

function legendDetails() {
  const d = h('details', 'pj-legend');
  d.appendChild(h('summary', 'pj-legend-sum', '凡例（記号の意味）'));
  const ul = h('div', 'pj-legend-body');
  ul.appendChild(h('div', '', '種別: プロジェクト ／ レビュー'));
  ul.appendChild(h('div', '', '状態バケット（一望の目安・原文は詳細で確認）: 完成・完了／暫定完成／進行中／待機・確定／停止・休止／起動のみ・移行／その他'));
  ul.appendChild(h('div', '', '残実装計画: 有 ／ ほぼ無 ／ 無'));
  ul.appendChild(h('div', '', '残作業: 既登記 ／ 新発見 ／ 横断・調整（フラグ）'));
  ul.appendChild(h('div', '', '残作業の分類仮ラベル（原典の種別仮）: fpu=機能単位／com=コム／cmp=共通部品／data=データ／doc=文書／infra=基盤／test=テスト／feature=機能／framework=枠組み／ui=画面／bug=不具合'));
  d.appendChild(ul);
  return d;
}

function onShow(ctx) { if (!state.data) load(ctx); }

async function load(ctx) {
  if (!ctx.program || !ctx.program.loadProjects) return;
  try {
    state.data = await ctx.program.loadProjects();
    render();
  } catch (e) {
    listEl.innerHTML = '';
    listEl.appendChild(h('p', 'view-hint', 'プロジェクトの読み込みに失敗: ' + (e.message || e)));
  }
}

function render() {
  listEl.innerHTML = '';
  distEl.innerHTML = '';
  const data = state.data;
  if (!data) { listEl.appendChild(h('p', 'view-hint', '読み込み中…')); return; }
  noteEl.textContent = data.available ? ('初期データ: ' + (data.source || '')) : '';
  if (!data.available) {
    listEl.appendChild(h('p', 'view-hint', 'CENSUS_B（初期データ）が見つかりません。統合台帳K2a適用後にパスを差し替えます（後方互換のため画面は壊れません）。'));
    return;
  }
  BUCKET_ORDER.forEach((b) => {
    const n = (data.counts.byBucket || {})[b] || 0;
    if (!n) return;
    distEl.appendChild(h('span', 'pj-dist-chip pj-b-' + b, BUCKET_LABEL[b] + ' ' + n));
  });
  const q = state.query.trim().toLowerCase();
  const match = (it) => !q || (it.name + ' ' + it.stateRaw + ' ' + it.workRaw).toLowerCase().includes(q);
  const projects = data.items.filter((it) => it.section === 'project' && match(it));
  const reviews = data.items.filter((it) => it.section === 'review' && match(it));
  renderGroup('プロジェクト（' + projects.length + (q ? '／' + data.counts.projects : '') + '）', projects);
  renderGroup('レビュー（' + reviews.length + (q ? '／' + data.counts.reviews : '') + '）', reviews);
  if (!projects.length && !reviews.length) listEl.appendChild(h('p', 'view-hint', '（該当なし）'));
}

function renderGroup(title, list) {
  if (!list.length) return;
  listEl.appendChild(h('h3', 'pj-group-title', title));
  list.forEach((it) => listEl.appendChild(renderCard(it)));
}

function renderCard(it) {
  const key = it.section + '::' + it.name;
  const open = !!state.open[key];
  const card = h('div', 'pj-card' + (open ? ' is-open' : ''));
  const head = h('button', 'pj-head');
  head.appendChild(h('span', 'pj-caret', open ? '▾' : '▸'));
  head.appendChild(txt('span', 'pj-name', it.name));
  head.appendChild(h('span', 'chip pj-type pj-type-' + it.section, typeLabel(it.section)));
  head.appendChild(h('span', 'chip pj-bucket pj-b-' + it.stateBucket, BUCKET_LABEL[it.stateBucket] || 'その他'));
  head.appendChild(h('span', 'chip pj-plan pj-plan-' + it.planBucket, PLAN_LABEL[it.planBucket] || PLAN_LABEL.unknown));
  if (it.residuals && it.residuals.length) head.appendChild(h('span', 'pj-residual-badge', '残作業 ' + it.residuals.length));
  head.onclick = () => { state.open[key] = !open; render(); };
  card.appendChild(head);
  if (open) card.appendChild(renderDetail(it));
  return card;
}

function field(label, valStr) {
  const r = h('div', 'pj-field');
  r.appendChild(h('span', 'pj-field-label', label));
  r.appendChild(txt('div', 'pj-field-val', valStr));
  return r;
}

function renderDetail(it) {
  const body = h('div', 'pj-detail');
  if (it.stateRaw) body.appendChild(field('状態', it.stateRaw));
  const planText = (PLAN_LABEL[it.planBucket] || PLAN_LABEL.unknown) + (it.planNote ? '（' + it.planNote + '）' : '');
  body.appendChild(field('残実装計画', planText));
  if (it.workRaw) body.appendChild(field('Work状況', it.workRaw));
  if (it.residuals && it.residuals.length) {
    const wrap = h('div', 'pj-residuals');
    wrap.appendChild(h('div', 'pj-field-label', '残作業（' + it.residuals.length + '件）'));
    it.residuals.forEach((rz) => wrap.appendChild(renderResidual(rz)));
    body.appendChild(wrap);
  }
  return body;
}

function renderResidual(rz) {
  const row = h('div', 'pj-res');
  if (rz.prose) { row.appendChild(txt('div', 'pj-res-title', rz.name)); return row; }
  row.appendChild(txt('div', 'pj-res-title', rz.name));
  const chips = h('div', 'pj-res-chips');
  if (rz.typeTag) chips.appendChild(h('span', 'chip pj-res-type', rz.typeTag));
  if (rz.hasForm && !/^形式なし$/.test(rz.hasForm)) chips.appendChild(h('span', 'chip pj-res-form', rz.hasForm));
  if (/YES/i.test(rz.crossFlag || '')) chips.appendChild(h('span', 'chip pj-res-cross', '横断・調整'));
  if (rz.registration) chips.appendChild(h('span', 'chip pj-res-reg' + (/新発見/.test(rz.registration) ? ' is-new' : ''), rz.registration));
  if (chips.children.length) row.appendChild(chips);
  if (rz.note) row.appendChild(txt('div', 'pj-res-note', rz.note));
  return row;
}

registerView({ id: 'projects', tabLabel: 'Projects', create, onShow });
