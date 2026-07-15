'use strict';

// views/shared.js — 全 type 共通のカード書式（一覧タイル・詳細シート）。
// Board と Reference/Knowledge/Consult の 3 タブが同一の見た目を共有する（v1.3 §3）。
// 分類語彙は英語表示（parser.js の *_LABEL / typeLabel を使用）。

import * as P from '../parser.js';

export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 一覧タイル（全 type 統一）: サムネイル（画像があれば先頭1枚・なければ出さない）＋タイトル＋chip列。
// opts.showType=true のとき type chip を出す（種類が列で分からないタブで付与）。
// 状態(status) chip（日本語）は全タブのタイルに常に出す（v1.6）。
export function cardTile(ctx, card, opts) {
  const o = opts || {};
  const t = h('div', 'card-tile');
  if (card.images && card.images.length) {
    const img = h('img', 'card-thumb');
    img.alt = card.title || '';
    ctx.attachImage(img, card.dir, card.images[0]);
    t.appendChild(img);
  }
  const body = h('div', 'card-tile-body');
  body.appendChild(h('div', 'card-tile-title', card.title || '（無題）'));
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  if (o.showType && card.type) meta.appendChild(h('span', 'chip', P.typeLabel(card.type)));
  if (card.status) meta.appendChild(h('span', 'chip chip-status', P.STATUS_LABEL[card.status] || card.status));
  if (card.subject) meta.appendChild(h('span', 'chip', '主題: ' + card.subject));
  body.appendChild(meta);
  t.appendChild(body);
  t.onclick = () => openCardDetail(ctx, card);
  return t;
}

// ---- 詳細シート（全 type 統一・単一のグローバルオーバーレイを body 直下に持つ） ----
let dBackdrop = null;
let dSheet = null;

function ensureDetail() {
  if (dBackdrop) return;
  dBackdrop = h('div', 'backdrop');
  dBackdrop.id = 'detail-backdrop';
  dBackdrop.hidden = true;
  dBackdrop.addEventListener('click', (e) => { if (e.target === dBackdrop) dBackdrop.hidden = true; });
  dSheet = h('div', 'sheet');
  dSheet.id = 'detail-sheet';
  dBackdrop.appendChild(dSheet);
  document.body.appendChild(dBackdrop);
}

export function openCardDetail(ctx, card) {
  ensureDetail();
  dSheet.innerHTML = '';

  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, card.title || '（無題）'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = () => { dBackdrop.hidden = true; };
  head.appendChild(close);
  dSheet.appendChild(head);

  const body = h('div', 'sheet-body');

  // chip 列: type・subject・tags・status・浮上条件（先頭に識別用 id chip）。
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  if (card.type) meta.appendChild(h('span', 'chip', P.typeLabel(card.type)));
  if (card.subject) meta.appendChild(h('span', 'chip', '主題: ' + card.subject));
  (card.tags || []).forEach((tag) => meta.appendChild(h('span', 'chip', '#' + tag)));
  if (card.status) meta.appendChild(h('span', 'chip chip-status', P.STATUS_LABEL[card.status] || card.status));
  if (card.surface) meta.appendChild(h('span', 'chip', '浮上: ' + card.surface));
  body.appendChild(meta);

  // 画像: あれば縦並びで表示・なければ画像領域ごと出さない。
  if (card.images && card.images.length) {
    const imgs = h('div', 'detail-imgs');
    card.images.forEach((f) => {
      const im = h('img', 'detail-img');
      ctx.attachImage(im, card.dir, f);
      imgs.appendChild(im);
    });
    body.appendChild(imgs);
  }

  addSection(body, '本文', card.sections && card.sections.body);
  addSection(body, '注釈', card.sections && card.sections.note);
  addSection(body, '処理記録', card.sections && card.sections.record);

  dSheet.appendChild(body);
  dBackdrop.hidden = false;
}

function addSection(wrap, title, content) {
  if (!content) return;
  const s = h('div', 'detail-section');
  s.appendChild(h('h4', null, title));
  s.appendChild(h('pre', 'detail-text', content));
  wrap.appendChild(s);
}
