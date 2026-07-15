'use strict';

// views/typeTab.js — Reference / Knowledge / Consult の3タブを生成する共有ファクトリ。
// 3タブは完全に同一のレイアウト（主題別グルーピング＋全文検索）を type パラメータだけ変えて共有する
// （コード複製でなく1モジュールの再利用・v1.3 §2-2）。各タブは自前の閉包状態を持つ（3インスタンス共存）。

import { h, cardTile } from './shared.js';
import * as P from '../parser.js';

const NO_SUBJECT = '（主題なし）';

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

// 1タブ分のビュー定義を作る。{ id, tabLabel, type, hint }。
export function makeTypeTabView({ id, tabLabel, type, hint }) {
  let root, listEl, searchInput;
  let query = '';

  function create() {
    root = h('div', 'subject-tab');

    const head = h('div', 'view-head');
    head.appendChild(h('h2', null, tabLabel));
    if (hint) head.appendChild(h('p', 'view-hint', hint));
    root.appendChild(head);

    // 全文検索（title/subject/本文/注釈/tags/処理記録 横断・空白 AND）
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

  let ctxRef = null;
  function onData(ctx) { ctxRef = ctx; render(ctx); }
  function onShow(ctx) { ctxRef = ctx; render(ctx); }

  function render(ctx) {
    if (!ctx || !listEl) return;
    const q = (query || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    let cards = P.cardsForType(ctx.state.cards, type);
    if (terms.length) cards = cards.filter((c) => matches(c, terms));

    listEl.innerHTML = '';
    if (cards.length === 0) {
      listEl.appendChild(h('p', 'view-empty', terms.length ? '該当するカードはありません。' : 'カードはまだありません。'));
      return;
    }

    // 主題別グルーピング（（主題なし）は末尾・他は日本語ソート）
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
      g.forEach((c) => section.appendChild(cardTile(ctx, c, { showType: false })));
      listEl.appendChild(section);
    }
  }

  return { id, tabLabel, create, onData, onShow };
}
