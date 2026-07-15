'use strict';

// views/quick.js — クイック登録。1行テキスト → INBOX §1 へ追記（思いつき最速登録）。

import { registerView } from '../registry.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let root, input, recentList;

function create(ctx) {
  root = h('div', 'quick');
  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, 'クイック登録'));
  head.appendChild(h('p', 'view-hint', '思いついたことを INBOX（§1 新規）へ即追記。分類不要・書き方自由。'));
  root.appendChild(head);

  const form = h('form', 'quick-form');
  input = h('textarea', 'field quick-input');
  input.rows = 3;
  input.placeholder = '例: 収納の自動配置、もっと壁面を使う発想がある気がする';
  const submit = h('button', 'btn-primary btn-big', 'INBOX へ登録');
  submit.type = 'submit';
  form.appendChild(input);
  form.appendChild(submit);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void send(ctx, submit); });
  root.appendChild(form);

  const recentHead = h('h3', 'quick-recent-head', 'この端末での直近の登録');
  root.appendChild(recentHead);
  recentList = h('ul', 'quick-recent');
  root.appendChild(recentList);

  return root;
}

async function send(ctx, submit) {
  const text = input.value.trim();
  if (!text) return;
  submit.disabled = true;
  submit.textContent = '登録中…';
  try {
    const entry = await ctx.program.appendInbox(text);
    input.value = '';
    const li = h('li', null, entry);
    recentList.prepend(li);
    ctx.toast('INBOX に登録しました');
  } catch (e) {
    ctx.toast('登録に失敗: ' + (e.message || e));
  } finally {
    submit.disabled = false;
    submit.textContent = 'INBOX へ登録';
    input.focus();
  }
}

registerView({
  id: 'quick',
  tabLabel: 'クイック',
  create,
});
