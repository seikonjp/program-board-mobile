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

  // 操作系（v1.7・詳細=選択状態のみ）。ユーザー発=削除+コメント（即動作）／AI発=OK/NGトグル(表示のみ)+コメント(準備中)。
  addOperations(ctx, body, card);

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

// textarea を内容に合わせて自動伸長（上限240pxで以降スクロール）。
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

// カード詳細の操作系（v1.7）。direction で出し分け。一覧タイルには出さない（Acceptance タブの3ボタンとは別系統）。
function addOperations(ctx, wrap, card) {
  const mode = P.cardOperationMode(card.direction);
  if (mode === 'none') return;
  const ops = h('div', 'detail-ops');

  if (mode === 'review') {
    // OK/NG トグル（どちらか一方 or 無選択・同じボタン再タップで解除）。表示のみ＝保存しない（画面内のみ）。
    const row = h('div', 'op-toggle-row');
    const okBtn = h('button', 'op-toggle op-ok', 'OK');
    const ngBtn = h('button', 'op-toggle op-ng', 'NG');
    let sel = null;
    const sync = () => {
      okBtn.classList.toggle('is-on', sel === 'ok');
      ngBtn.classList.toggle('is-on', sel === 'ng');
    };
    okBtn.onclick = () => { sel = (sel === 'ok') ? null : 'ok'; sync(); };
    ngBtn.onclick = () => { sel = (sel === 'ng') ? null : 'ng'; sync(); };
    row.appendChild(okBtn);
    row.appendChild(ngBtn);
    ops.appendChild(row);
  }

  // コメント入力欄（両モード共通の大きさ・日本語20〜30字が見える2行前後・上限なし・自動伸長）。
  const ta = h('textarea', 'field op-comment');
  ta.rows = 2;
  ta.placeholder = 'コメント';
  ta.addEventListener('input', () => autoGrow(ta));
  ops.appendChild(ta);

  const sendRow = h('div', 'op-send-row');
  if (mode === 'edit') {
    // ユーザー発: コメント送信（処理記録へ即追記）。
    const send = h('button', 'btn-primary op-send', '送信');
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      send.disabled = true;
      try {
        await ctx.program.addComment(card.id, text);
        ctx.toast('コメントを追記しました');
        await ctx.reload();
        const updated = (ctx.state.cards || []).find((c) => c.id === card.id);
        if (updated) openCardDetail(ctx, updated); else dBackdrop.hidden = true;
      } catch (e) {
        ctx.toast('コメント追記に失敗: ' + (e.message || e));
        send.disabled = false;
      }
    };
    sendRow.appendChild(send);
    ops.appendChild(sendRow);

    // ユーザー発: 削除（確認 → Cards/_trash へ移動・復元可能）。
    const del = h('button', 'btn-danger op-delete', 'このカードを削除');
    del.onclick = async () => {
      if (!window.confirm('このカードを削除しますか？（Cards/_trash へ移動します・復元可能）')) return;
      del.disabled = true;
      try {
        await ctx.program.deleteCard(card.id);
        ctx.toast('カードを削除しました（_trash へ移動）');
        await ctx.reload();
        dBackdrop.hidden = true;
      } catch (e) {
        ctx.toast('削除に失敗: ' + (e.message || e));
        del.disabled = false;
      }
    };
    ops.appendChild(del);
  } else {
    // AI発: 送信は準備中（不活性・今回は配線しない）。
    const send = h('button', 'btn-primary op-send', '送信（準備中）');
    send.disabled = true;
    sendRow.appendChild(send);
    ops.appendChild(sendRow);
  }

  wrap.appendChild(ops);
}
