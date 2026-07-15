'use strict';

// views/knowledge.js — 「知見」タブ（ストック型）。
// type=knowledge のカードを主題別にグルーピング表示し、全文検索で横断的に絞り込む。
// ボード（フロー）から分離された恒久的な設計知識・作者証言の置き場。
// カードタップで詳細（画像＋本文/注釈/処理記録）を表示（このビュー内に自前のシートを持つ）。

import { registerView } from '../registry.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const NO_SUBJECT = '（主題なし）';

let root, listEl, searchInput;
let query = '';

function create(ctx) {
  root = h('div', 'knowledge');

  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, '知見'));
  head.appendChild(h('p', 'view-hint', '設計知識・作者証言（ストック型）。主題別に整理。ボードのフローには出ません。'));
  root.appendChild(head);

  // 全文検索（title/subject/本文/注釈/tags/処理記録を横断・部分一致）
  searchInput = h('input', 'field k-search');
  searchInput.type = 'search';
  searchInput.placeholder = '全文検索（タイトル・主題・本文・注釈・タグ・処理記録）';
  searchInput.autocomplete = 'off';
  searchInput.addEventListener('input', () => { query = searchInput.value; render(ctx); });
  root.appendChild(searchInput);

  listEl = h('div', 'k-list');
  root.appendChild(listEl);

  // 詳細シート（このビュー内に内包＝表示中は前面に出る）
  root.appendChild(buildDetailModal());

  return root;
}

function onData(ctx) { render(ctx); }
function onShow(ctx) { render(ctx); }

// クエリを空白区切りの語に分解し、各語がいずれかのフィールドに部分一致（AND）するカードを残す。
function matches(card, terms) {
  const s = card.sections || {};
  const hay = [
    card.title || '',
    card.subject || '',
    s.body || '',
    s.note || '',
    (card.tags || []).join(' '),
    s.record || '',
  ].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function firstLine(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length ? lines[0] : '';
}

function render(ctx) {
  const q = (query || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  let cards = (ctx.state.cards || []).filter((c) => c.type === 'knowledge');
  if (terms.length) cards = cards.filter((c) => matches(c, terms));

  listEl.innerHTML = '';
  if (cards.length === 0) {
    listEl.appendChild(h('p', 'view-empty', terms.length ? '該当する知見カードはありません。' : '知見カードはまだありません。'));
    return;
  }

  // 主題別にグルーピング
  const groups = new Map();
  for (const c of cards) {
    const key = (c.subject && c.subject.trim()) ? c.subject.trim() : NO_SUBJECT;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === NO_SUBJECT) return 1;
    if (b === NO_SUBJECT) return -1;
    return a.localeCompare(b, 'ja');
  });

  for (const key of keys) {
    const g = groups.get(key);
    const section = h('div', 'k-group');
    const gh = h('div', 'k-group-head');
    gh.appendChild(h('span', 'k-group-title', key));
    gh.appendChild(h('span', 'k-group-count', String(g.length)));
    section.appendChild(gh);
    g.forEach((c) => section.appendChild(kRow(c, ctx)));
    listEl.appendChild(section);
  }
}

function kRow(card, ctx) {
  const row = h('div', 'k-row');
  const head = h('div', 'k-row-head');
  head.appendChild(h('span', 'chip chip-id', card.id));
  head.appendChild(h('span', 'k-row-title', card.title || '（無題）'));
  row.appendChild(head);
  const excerpt = firstLine(card.sections && card.sections.body);
  if (excerpt) row.appendChild(h('div', 'k-row-excerpt', excerpt));
  row.onclick = () => openDetail(card, ctx);
  return row;
}

// ---- 詳細シート（board のカード詳細と同じ体裁を自前で描画・タブ内前面表示） ----
function buildDetailModal() {
  const backdrop = h('div', 'backdrop');
  backdrop.id = 'k-detail-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'k-detail-backdrop') backdrop.hidden = true; });
  const sheet = h('div', 'sheet');
  sheet.id = 'k-detail-sheet';
  backdrop.appendChild(sheet);
  return backdrop;
}

function openDetail(card, ctx) {
  const sheet = document.getElementById('k-detail-sheet');
  sheet.innerHTML = '';
  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, card.title || '（無題）'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = () => { document.getElementById('k-detail-backdrop').hidden = true; };
  head.appendChild(close);
  sheet.appendChild(head);

  const body = h('div', 'sheet-body');
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  meta.appendChild(h('span', 'chip', ctx.constants.STATUS_JP[card.status] || card.status));
  if (card.type) meta.appendChild(h('span', 'chip', ctx.constants.TYPE_JP[card.type] || card.type));
  if (card.subject) meta.appendChild(h('span', 'chip', '主題: ' + card.subject));
  if (card.direction) meta.appendChild(h('span', 'chip', ctx.constants.DIRECTION_JP[card.direction] || card.direction));
  if (card.surface) meta.appendChild(h('span', 'chip', '浮上: ' + card.surface));
  (card.tags || []).forEach((tag) => meta.appendChild(h('span', 'chip', '#' + tag)));
  body.appendChild(meta);

  if (card.images && card.images.length) {
    const imgs = h('div', 'detail-imgs');
    card.images.forEach((f) => {
      const im = h('img', 'detail-img');
      ctx.attachImage(im, card.dir, f);
      imgs.appendChild(im);
    });
    body.appendChild(imgs);
  }
  addSection(body, '本文', card.sections.body);
  addSection(body, '注釈', card.sections.note);
  addSection(body, '処理記録', card.sections.record);

  sheet.appendChild(body);
  document.getElementById('k-detail-backdrop').hidden = false;
}

function addSection(wrap, title, content) {
  if (!content) return;
  const s = h('div', 'detail-section');
  s.appendChild(h('h4', null, title));
  s.appendChild(h('pre', 'detail-text', content));
  wrap.appendChild(s);
}

registerView({
  id: 'knowledge',
  tabLabel: '知見',
  create,
  onData,
  onShow,
});
