'use strict';

// views/tray.js — 検収トレイ（Review タブ）。type=report/review かつ status=review を縦並び。
// タイル部は全タブ共通の cardTile を使用（サムネイル+タイトル+chip・v1.5 §3）＝一覧の見た目が全タブで揃う。
// タイルをタップで詳細シート（原寸画像・本文・注釈・処理記録）。各カードに OK / NG（コメント必須）/ あとで の3ボタン。

import { registerView } from '../registry.js';
import { h, cardTile } from './shared.js';

let root, listEl;

function isTrayCard(c) {
  return (c.type === 'report' || c.type === 'review') && c.status === 'review' && !c.archived;
}

function create(ctx) {
  root = h('div', 'tray');
  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, '検収トレイ'));
  head.appendChild(h('p', 'view-hint', '完成・動作報告の検収。OK＝完了／NG＝コメント必須／あとで＝保留。'));
  root.appendChild(head);
  listEl = h('div', 'tray-list');
  root.appendChild(listEl);
  return root;
}

function onData(ctx) { render(ctx); }
function onShow(ctx) { render(ctx); }

function badge(ctx) {
  return (ctx.state.cards || []).filter(isTrayCard).length;
}

function render(ctx) {
  const cards = (ctx.state.cards || []).filter(isTrayCard);
  listEl.innerHTML = '';
  if (cards.length === 0) {
    listEl.appendChild(h('p', 'view-empty', '検収待ちのカードはありません。'));
    return;
  }
  cards.forEach((card) => listEl.appendChild(trayCard(card, ctx)));
}

function trayCard(card, ctx) {
  const c = h('div', 'tray-card');

  // タイル部は全タブ共通（Board と同一）。タップで詳細シート（原寸画像・本文・処理記録）を開く。
  c.appendChild(cardTile(ctx, card, { showType: true }));

  const actions = h('div', 'tray-actions');
  const comment = h('input', 'field');
  comment.type = 'text';
  comment.placeholder = 'コメント（NGは必須）';
  const okBtn = h('button', 'btn-ok', 'OK');
  const ngBtn = h('button', 'btn-ng', 'NG');
  const laterBtn = h('button', 'btn-later', 'あとで');
  const btns = [okBtn, ngBtn, laterBtn];
  okBtn.onclick = () => act(ctx, card, 'ok', comment.value, btns);
  ngBtn.onclick = () => {
    if (!comment.value.trim()) { comment.focus(); comment.placeholder = 'NGにはコメントが必須です'; comment.classList.add('field-error'); return; }
    act(ctx, card, 'ng', comment.value, btns);
  };
  laterBtn.onclick = () => act(ctx, card, 'later', comment.value, btns);

  actions.appendChild(comment);
  const btnRow = h('div', 'tray-btn-row');
  btnRow.appendChild(okBtn);
  btnRow.appendChild(ngBtn);
  btnRow.appendChild(laterBtn);
  actions.appendChild(btnRow);
  c.appendChild(actions);
  return c;
}

// Review タブの3ボタンも新書式・新status規則へ統一（respondCard・v2.1）。action は kind として渡す。
async function act(ctx, card, action, comment, btns) {
  btns.forEach((b) => (b.disabled = true));
  try {
    await ctx.program.respondCard(card.id, action, { comment });
    ctx.toast('応答を記録しました（' + (action === 'ok' ? 'OK' : action === 'ng' ? 'NG' : 'あとで') + '）');
    await ctx.reload();
  } catch (e) {
    ctx.toast('応答の記録に失敗: ' + (e.message || e));
    btns.forEach((b) => (b.disabled = false));
  }
}

registerView({
  id: 'tray',
  tabLabel: 'Review',
  badge,
  create,
  onData,
  onShow,
});
