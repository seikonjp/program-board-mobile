'use strict';

// views/memo.js — メモ（Program/Memos/・1メモ=1ファイル・v1.8。旧 Quick/INBOX を置換）。
// 一覧（新しい順・先頭行表示）／新規メモ（1行入力）／編集（内容 textarea＋保存・カード化・削除）。
// カード化は Board の新規カードフォームを本文プリフィルで開き、作成成功で元メモを _done へ移す。

import { registerView } from '../registry.js';
import { h } from './shared.js';

let root, listEl;
let memos = [];

function create(ctx) {
  root = h('div', 'memo-view');

  const head = h('div', 'view-head');
  head.appendChild(h('h2', null, 'メモ'));
  head.appendChild(h('p', 'view-hint', '思いつきを1メモ=1ファイルで保存。タップで編集・カード化（本文へ引き継ぎ）・削除。'));
  root.appendChild(head);

  const newBtn = h('button', 'btn-primary btn-big', '＋ 新規メモ');
  newBtn.onclick = () => openNewMemo();
  root.appendChild(newBtn);

  listEl = h('div', 'memo-list');
  root.appendChild(listEl);

  root.appendChild(buildNewMemoModal(ctx));
  root.appendChild(buildEditMemoModal(ctx));

  // Board の「＋ メモ」から新規メモ入力を開くためのフック（v1.8）。
  ctx.requestNewMemo = () => openNewMemo();
  return root;
}

async function loadAndRender(ctx) {
  try {
    memos = await ctx.program.loadMemos();
    renderList(ctx);
  } catch (e) {
    ctx.toast('メモ取得に失敗: ' + (e.message || e));
  }
}
function onShow(ctx) { void loadAndRender(ctx); }

function renderList(ctx) {
  listEl.innerHTML = '';
  if (!memos.length) { listEl.appendChild(h('p', 'view-empty', 'メモはまだありません。')); return; }
  memos.forEach((m) => {
    const item = h('div', 'memo-item');
    item.appendChild(h('div', 'memo-first', m.firstLine || '（空のメモ）'));
    item.appendChild(h('div', 'memo-id', m.id));
    item.onclick = () => openEditMemo(ctx, m);
    listEl.appendChild(item);
  });
}

// ---- 新規メモ（1行入力） ----
function buildNewMemoModal(ctx) {
  const backdrop = h('div', 'backdrop');
  backdrop.id = 'memo-new-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'memo-new-backdrop') closeNewMemo(); });

  const sheet = h('div', 'sheet');
  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, '新規メモ'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = closeNewMemo;
  head.appendChild(close);
  sheet.appendChild(head);

  const body = h('div', 'sheet-body');
  const input = h('input', 'field');
  input.id = 'memo-new-text';
  input.type = 'text';
  input.placeholder = '1行メモ（例: 収納の自動配置をもっと壁面に）';
  body.appendChild(input);
  const submit = h('button', 'btn-primary btn-big', '保存');
  submit.onclick = () => submitNewMemo(ctx, submit);
  body.appendChild(submit);
  sheet.appendChild(body);

  backdrop.appendChild(sheet);
  return backdrop;
}
function openNewMemo() {
  const t = document.getElementById('memo-new-text');
  if (t) t.value = '';
  document.getElementById('memo-new-backdrop').hidden = false;
  if (t) t.focus();
}
function closeNewMemo() { document.getElementById('memo-new-backdrop').hidden = true; }

async function submitNewMemo(ctx, submit) {
  const t = document.getElementById('memo-new-text');
  const text = (t.value || '').trim();
  if (!text) { t.focus(); return; }
  submit.disabled = true;
  try {
    await ctx.program.createMemo(text);
    closeNewMemo();
    ctx.toast('メモを保存しました');
    await loadAndRender(ctx);
  } catch (e) {
    ctx.toast('保存に失敗: ' + (e.message || e));
  } finally {
    submit.disabled = false;
  }
}

// ---- メモ編集（内容 textarea＋保存／カードを作成する／削除） ----
function buildEditMemoModal(ctx) {
  const backdrop = h('div', 'backdrop');
  backdrop.id = 'memo-edit-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'memo-edit-backdrop') closeEditMemo(); });

  const sheet = h('div', 'sheet');
  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, 'メモ'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = closeEditMemo;
  head.appendChild(close);
  sheet.appendChild(head);

  const body = h('div', 'sheet-body');
  const ta = h('textarea', 'field');
  ta.id = 'memo-edit-text';
  ta.rows = 8;
  body.appendChild(ta);

  const actions = h('div', 'edit-actions');
  const save = h('button', 'btn-primary', '保存');
  save.id = 'memo-edit-save';
  const toCard = h('button', 'btn-secondary', 'カードを作成する');
  toCard.id = 'memo-edit-tocard';
  actions.appendChild(save);
  actions.appendChild(toCard);
  body.appendChild(actions);

  const del = h('button', 'btn-danger memo-del', '削除');
  del.id = 'memo-edit-delete';
  body.appendChild(del);

  sheet.appendChild(body);
  backdrop.appendChild(sheet);
  return backdrop;
}
function openEditMemo(ctx, memo) {
  const ta = document.getElementById('memo-edit-text');
  ta.value = memo.text || '';
  document.getElementById('memo-edit-save').onclick = () => saveEditMemo(ctx, memo);
  document.getElementById('memo-edit-tocard').onclick = () => convertMemoToCard(ctx, memo);
  document.getElementById('memo-edit-delete').onclick = () => deleteMemo(ctx, memo);
  document.getElementById('memo-edit-backdrop').hidden = false;
}
function closeEditMemo() { document.getElementById('memo-edit-backdrop').hidden = true; }

async function saveEditMemo(ctx, memo) {
  const text = document.getElementById('memo-edit-text').value;
  const btn = document.getElementById('memo-edit-save');
  btn.disabled = true;
  try {
    await ctx.program.updateMemo(memo.name, text);
    closeEditMemo();
    ctx.toast('メモを保存しました');
    await loadAndRender(ctx);
  } catch (e) {
    ctx.toast('保存に失敗: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function deleteMemo(ctx, memo) {
  if (!window.confirm('このメモを削除しますか？（Memos/_trash へ移動します・復元可能）')) return;
  try {
    await ctx.program.trashMemo(memo.name);
    closeEditMemo();
    ctx.toast('メモを削除しました（_trash へ移動）');
    await loadAndRender(ctx);
  } catch (e) {
    ctx.toast('削除に失敗: ' + (e.message || e));
  }
}

// メモ内容を本文に埋め込んだ新規カードフォームを開く（作成成功で元メモを _done へ移動）。
function convertMemoToCard(ctx, memo) {
  closeEditMemo();
  if (!ctx.requestNewCard) { ctx.toast('Board タブを開いてから実行してください'); return; }
  if (ctx.setTab) ctx.setTab('board'); // 新規カードフォームは Board ビュー内（表示してから開く）
  ctx.requestNewCard({
    body: memo.text || '',
    onCreated: async () => {
      await ctx.program.doneMemo(memo.name);
      ctx.toast('メモをカード化しました');
      await loadAndRender(ctx);
    },
  });
}

registerView({
  id: 'memo',
  tabLabel: 'Memo',
  create,
  onShow,
});
