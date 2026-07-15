'use strict';

// views/decision.js — 裁定ビュー（読み取り専用）。DECISION_QUEUE.md をそのまま整形表示。
// 裁定操作はチャットで行うため、ここでは表示のみ（書き込みなし）。

import { registerView } from '../registry.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let root, pre, statusEl;
let loadedOnce = false;

function create(ctx) {
  root = h('div', 'decision');
  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, '裁定ビュー'));
  const sub = h('p', 'view-hint', 'DECISION_QUEUE.md（読み取り専用）。裁定はチャットで行います。');
  head.appendChild(sub);
  const reloadBtn = h('button', 'btn-secondary', '再読み込み');
  reloadBtn.onclick = () => load(ctx, true);
  head.appendChild(reloadBtn);
  root.appendChild(head);

  statusEl = h('p', 'view-hint');
  root.appendChild(statusEl);

  pre = h('pre', 'raw-md');
  root.appendChild(pre);
  return root;
}

function onShow(ctx) {
  if (!loadedOnce) load(ctx, false);
}

async function load(ctx, force) {
  statusEl.textContent = '読み込み中…';
  try {
    const text = await ctx.program.readDecisionQueue();
    pre.textContent = (text === null) ? '（DECISION_QUEUE.md が見つかりません）' : text;
    statusEl.textContent = '取得: ' + new Date().toLocaleTimeString('ja-JP');
    loadedOnce = true;
  } catch (e) {
    statusEl.textContent = '読み込みエラー: ' + (e.message || e);
  }
}

registerView({
  id: 'decision',
  tabLabel: 'Decision',
  create,
  onShow,
});
