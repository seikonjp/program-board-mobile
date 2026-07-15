'use strict';

// views/decision.js — 「Decision」タブ（type=decision＝AI 発の裁定依頼・v1.5）。
// 上段: type=decision のカードを他タブと同一機構（typeTab ファクトリ）で主題別に表示。
// 下段: DECISION_QUEUE.md 全文を折りたたみ（details/summary・既定は閉）で残す
//       ＝正本の閲覧手段を消さない。裁定操作はチャットまたはカードへの返答で行う（書き込みなし）。

import { registerView } from '../registry.js';
import { makeTypeTabView } from './typeTab.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 上段のカード一覧は Reference/Knowledge/Consult/Report と完全に同一のレイアウトを共有する。
const inner = makeTypeTabView({
  id: 'decision',
  tabLabel: 'Decision',
  type: 'decision',
  hint: '裁定依頼カード（type=decision）。主題別に整理。裁定はチャットまたはカードへの返答で行います。',
});

let root, pre, statusEl;
let loadedOnce = false;

function create(ctx) {
  root = h('div', 'decision');

  // 上段: カード表示（typeTab を再利用）。
  root.appendChild(inner.create(ctx));

  // 下段: DECISION_QUEUE.md 全文（折りたたみ・既定は閉・開いた時に初回読み込み）。
  const details = h('details', 'queue-details');
  const summary = h('summary', null, 'DECISION_QUEUE.md 全文（読み取り専用）');
  details.appendChild(summary);

  const head = h('div', 'queue-details-head');
  statusEl = h('span', 'view-hint');
  head.appendChild(statusEl);
  const reloadBtn = h('button', 'btn-secondary', '再読み込み');
  reloadBtn.onclick = () => load(ctx, true);
  head.appendChild(reloadBtn);
  details.appendChild(head);

  pre = h('pre', 'raw-md');
  details.appendChild(pre);

  details.addEventListener('toggle', () => { if (details.open && !loadedOnce) load(ctx, false); });
  root.appendChild(details);

  return root;
}

function onData(ctx) { if (inner.onData) inner.onData(ctx); }
function onShow(ctx) { if (inner.onShow) inner.onShow(ctx); }

async function load(ctx, force) {
  if (!statusEl) return;
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
  onData,
  onShow,
});
