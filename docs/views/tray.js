'use strict';

// views/tray.js — 検収トレイ。type=report/acceptance かつ status=acceptance を大きく縦並び。
// 各カードに OK / NG（コメント必須）/ あとで の3ボタン。

import { registerView } from '../registry.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let root, listEl;

function isTrayCard(c) {
  return (c.type === 'report' || c.type === 'acceptance') && c.status === 'acceptance';
}

function create(ctx) {
  root = h('div', 'tray');
  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, '検収トレイ'));
  head.appendChild(h('p', 'view-hint', '完成・動作報告の検収。OK＝消化／NG＝コメント必須／あとで＝保留。'));
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
  const head = h('div', 'tray-card-head');
  head.appendChild(h('span', 'chip chip-id', card.id));
  head.appendChild(h('span', 'tray-card-title', card.title || '（無題）'));
  c.appendChild(head);

  if (card.images && card.images.length) {
    const imgs = h('div', 'tray-imgs');
    card.images.forEach((f) => {
      const im = h('img', 'tray-img');
      ctx.attachImage(im, card.dir, f);
      imgs.appendChild(im);
    });
    c.appendChild(imgs);
  }
  if (card.sections.body) c.appendChild(h('pre', 'tray-body', card.sections.body));
  if (card.sections.record) {
    const rec = h('details', 'tray-record');
    rec.appendChild(h('summary', null, '処理記録'));
    rec.appendChild(h('pre', 'detail-text', card.sections.record));
    c.appendChild(rec);
  }

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

async function act(ctx, card, action, comment, btns) {
  btns.forEach((b) => (b.disabled = true));
  try {
    await ctx.program.acceptCard(card.id, action, comment);
    ctx.toast('検収を記録しました（' + (action === 'ok' ? 'OK' : action === 'ng' ? 'NG' : 'あとで') + '）');
    await ctx.reload();
  } catch (e) {
    ctx.toast('検収の記録に失敗: ' + (e.message || e));
    btns.forEach((b) => (b.disabled = false));
  }
}

registerView({
  id: 'tray',
  tabLabel: '検収',
  badge,
  create,
  onData,
  onShow,
});
