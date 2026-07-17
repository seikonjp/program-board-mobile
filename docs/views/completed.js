'use strict';

// views/completed.js — 完了ビュー（2026-07-17）。完了(consumed)＋アーカイブ済みを一望する。
// メインの Board・種類別タブの既定一覧からは consumed を外している（P.listableCards）。ここで完了カードを見る。
// 全文検索で到達可（parser.js の completedCards ＋ 本ビューの検索）。タイルは全タブ共通の cardTile。

import { registerView } from '../registry.js';
import { h, cardTile } from './shared.js';
import * as P from '../parser.js';

let root, listEl, searchInput;
let query = '';

// 全文検索（typeTab と同じ横断・空白 AND）。
function matches(card, terms) {
  const s = card.sections || {};
  const hay = [
    card.title || '',
    card.subject || '',
    s.body || '',
    s.note || '',
    (card.tags || []).join(' '),
    (card.target || []).join(' '),
    s.record || '',
  ].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

let ctxRef = null;

function create(ctx) {
  ctxRef = ctx;
  root = h('div', 'subject-tab');

  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, '完了'));
  head.appendChild(h('p', 'view-hint', '完了(consumed)＋アーカイブ済みを一望。メインの Board・種類別タブには出しません。'));
  root.appendChild(head);

  searchInput = h('input', 'field k-search');
  searchInput.type = 'search';
  searchInput.placeholder = '全文検索（タイトル・主題・本文・注釈・タグ・処理記録）';
  searchInput.autocomplete = 'off';
  searchInput.addEventListener('input', (e) => { query = e.target.value; render(ctxRef); });
  root.appendChild(searchInput);

  listEl = h('div', 'k-list');
  root.appendChild(listEl);
  return root;
}

function onData(ctx) { ctxRef = ctx; render(ctx); }
function onShow(ctx) { ctxRef = ctx; render(ctx); }

function render(ctx) {
  if (!ctx || !listEl) return;
  const q = (query || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  // 完了(consumed)＋アーカイブ（純粋関数 completedCards）。検索時は全文で絞り込む。
  let cards = P.completedCards(ctx.state.cards);
  if (terms.length) cards = cards.filter((c) => matches(c, terms));

  listEl.innerHTML = '';
  if (cards.length === 0) {
    listEl.appendChild(h('p', 'view-empty', terms.length ? '該当する完了カードはありません。' : '完了したカードはまだありません。'));
    return;
  }
  cards.forEach((c) => listEl.appendChild(cardTile(ctx, c, { showType: true })));
}

registerView({
  id: 'completed',
  tabLabel: '完了',
  create,
  onData,
  onShow,
});
