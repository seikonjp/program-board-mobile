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

// 処遇マーカーの DOM 要素（title 末尾右／status・type から自動導出・2026-07-17）。付かない場合は null。
function treatmentMarkerEl(status, type) {
  const m = P.treatmentMarker(status, type);
  if (!m) return null;
  const glyph = (m === '→') ? '→' : '✓';
  const variant = m === '✓hollow' ? 'is-hollow' : (m === '✓filled' ? 'is-filled' : 'is-hold');
  const span = h('span', 'treat ' + variant, glyph);
  span.title = m === '✓hollow' ? '完了提案（AIが提案・確定待ち）' : (m === '✓filled' ? '完了' : '保留（先送り／申し送り／参考）');
  return span;
}
// タイトル要素（テキスト＋末尾右の処遇マーカー）。tag は 'div'（タイル）/ 'h2'（詳細）。
function makeTitleEl(tag, cls, title, status, type) {
  const wrap = h(tag, cls);
  wrap.appendChild(h('span', 'title-text', title || '（無題）'));
  const mk = treatmentMarkerEl(status, type);
  if (mk) wrap.appendChild(mk);
  return wrap;
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
  body.appendChild(makeTitleEl('div', 'card-tile-title', card.title, card.status, card.type));
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  if (o.showType && card.type) meta.appendChild(h('span', 'chip', P.typeLabel(card.type)));
  if (card.status) meta.appendChild(h('span', 'chip chip-status', P.statusLabel(card.status, card.type)));
  if (card.subject) meta.appendChild(h('span', 'chip', '主題: ' + card.subject));
  (card.target || []).forEach((tg) => meta.appendChild(h('span', 'chip chip-target', '対象: ' + tg)));
  if (card.archived) meta.appendChild(h('span', 'chip chip-archived', 'アーカイブ'));
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
  head.appendChild(makeTitleEl('h2', 'detail-title', card.title, card.status, card.type));
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
  (card.target || []).forEach((tg) => meta.appendChild(h('span', 'chip chip-target', '対象: ' + tg)));
  if (card.status) meta.appendChild(h('span', 'chip chip-status', P.statusLabel(card.status, card.type)));
  if (card.surface) meta.appendChild(h('span', 'chip', '浮上: ' + card.surface));
  if (card.archived) meta.appendChild(h('span', 'chip chip-archived', 'アーカイブ'));
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

  // アーカイブは読み取り専用（操作系・target編集は出さない・v2.1）。
  if (!card.archived) {
    // 完了ボタン（1-2）: status=done-proposed／carried のカードは型・方向を問わず表示（carried は 2026-07-17）。
    if (card.status === 'done-proposed' || card.status === 'carried') addDoneButton(ctx, body, card);
    // target 欄の後付け編集（1-3・ユーザー発/AI発どちらでも）。
    addTargetEditor(ctx, body, card);
    // 操作系（v2.1・詳細=応答配線）。
    addOperations(ctx, body, card);
  }

  dSheet.appendChild(body);
  dBackdrop.hidden = false;
}

// カード編集フォーム（v1.8・ユーザー発のみ）。タイトル入力＋本文 textarea → 保存で
// frontmatter title と「## 本文」節のみ書き換え（注釈・処理記録・他フィールドは byte 不変）。
export function openEditCardSheet(ctx, card) {
  ensureDetail();
  dSheet.innerHTML = '';

  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, 'カードを編集'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = () => openCardDetail(ctx, card);
  head.appendChild(close);
  dSheet.appendChild(head);

  const body = h('div', 'sheet-body');

  const titleRow = h('div', 'field-row');
  titleRow.appendChild(h('label', null, 'タイトル'));
  const titleInput = h('input', 'field');
  titleInput.type = 'text';
  titleInput.value = card.title || '';
  titleRow.appendChild(titleInput);
  body.appendChild(titleRow);

  const bodyRow = h('div', 'field-row');
  bodyRow.appendChild(h('label', null, '本文'));
  const bodyTa = h('textarea', 'field');
  bodyTa.rows = 8;
  bodyTa.value = (card.sections && card.sections.body) || '';
  bodyRow.appendChild(bodyTa);
  body.appendChild(bodyRow);

  const actions = h('div', 'edit-actions');
  const cancel = h('button', 'btn-secondary', 'キャンセル');
  cancel.onclick = () => openCardDetail(ctx, card);
  const save = h('button', 'btn-primary', '保存');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await ctx.program.editCard(card.id, { title: titleInput.value, body: bodyTa.value });
      ctx.toast('カードを保存しました');
      await ctx.reload();
      const updated = (ctx.state.cards || []).find((c) => c.id === card.id);
      if (updated) openCardDetail(ctx, updated); else dBackdrop.hidden = true;
    } catch (e) {
      ctx.toast('保存に失敗: ' + (e.message || e));
      save.disabled = false;
    }
  };
  actions.appendChild(cancel);
  actions.appendChild(save);
  body.appendChild(actions);

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

// 応答をサーバへ送る共通処理（1-1・詳細シートから）。成功後は詳細を再描画。
async function sendRespond(ctx, card, kind, opts, btns) {
  (btns || []).forEach((b) => (b.disabled = true));
  try {
    await ctx.program.respondCard(card.id, kind, opts || {});
    ctx.toast('応答を記録しました');
    await ctx.reload();
    const updated = (ctx.state.cards || []).find((c) => c.id === card.id);
    if (updated) openCardDetail(ctx, updated); else dBackdrop.hidden = true;
  } catch (e) {
    ctx.toast('応答の記録に失敗: ' + (e.message || e));
    (btns || []).forEach((b) => (b.disabled = false));
  }
}

// 完了ボタン（1-2）。status=done-proposed のカードでユーザーが完了確定 → consumed + 完了確定行。
function addDoneButton(ctx, wrap, card) {
  const box = h('div', 'detail-done');
  const hint = card.status === 'carried'
    ? '申し送り済み（内容は CARRYOVER に保全）。閉じてよい状態です。'
    : 'AI側から完了が提案されています。';
  box.appendChild(h('p', 'view-hint', hint));
  const btn = h('button', 'btn-primary op-done', '完了にする');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await ctx.program.confirmDone(card.id);
      ctx.toast('完了にしました');
      await ctx.reload();
      const updated = (ctx.state.cards || []).find((c) => c.id === card.id);
      if (updated) openCardDetail(ctx, updated); else dBackdrop.hidden = true;
    } catch (e) {
      ctx.toast('完了確定に失敗: ' + (e.message || e));
      btn.disabled = false;
    }
  };
  box.appendChild(btn);
  wrap.appendChild(box);
}

// target 欄の後付け編集（1-3・ユーザー発/AI発どちらでも）。カンマ/空白区切り→配列。
function addTargetEditor(ctx, wrap, card) {
  const box = h('div', 'detail-target');
  box.appendChild(h('label', null, '対象（機能/FPU/CMP/単位ID・カンマ区切り）'));
  const input = h('input', 'field op-target');
  input.type = 'text';
  input.value = (card.target || []).join(', ');
  input.placeholder = '例: SP01, CM07';
  box.appendChild(input);
  const save = h('button', 'btn-secondary op-target-save', '対象を保存');
  save.onclick = async () => {
    save.disabled = true;
    try {
      await ctx.program.setTarget(card.id, input.value);
      ctx.toast('対象を保存しました');
      await ctx.reload();
      const updated = (ctx.state.cards || []).find((c) => c.id === card.id);
      if (updated) openCardDetail(ctx, updated); else dBackdrop.hidden = true;
    } catch (e) {
      ctx.toast('対象の保存に失敗: ' + (e.message || e));
      save.disabled = false;
    }
  };
  box.appendChild(save);
  wrap.appendChild(box);
}

// カード詳細の操作系（v2.1）。direction で出し分け。一覧タイルには出さない（Review タブの3ボタンとは別系統）。
//   edit    = ユーザー発（user-to-claude）: 編集＋コメント（即動作）＋削除
//   respond = AI発（claude-to-user）: decision=選択肢ボタン／その他=OK/NG/あとで＋コメントのみ送信
function addOperations(ctx, wrap, card) {
  const mode = P.cardOperationMode(card.direction);
  if (mode === 'none') return;
  const ops = h('div', 'detail-ops');

  if (mode === 'edit') {
    // タイトル・本文の編集（v1.8）。押すと編集フォームへ切り替わる。
    const editBtn = h('button', 'btn-secondary op-edit', '編集');
    editBtn.onclick = () => openEditCardSheet(ctx, card);
    ops.appendChild(editBtn);

    // コメント入力欄＋送信（処理記録へ即追記）。
    const ta = h('textarea', 'field op-comment');
    ta.rows = 2;
    ta.placeholder = 'コメント';
    ta.addEventListener('input', () => autoGrow(ta));
    ops.appendChild(ta);
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
    ops.appendChild(send);

    // 削除（確認 → Cards/_trash へ移動・復元可能）。
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
    // AI発（respond）: 選択→送信の一括方式（v2.7・C-U0004）。選択は即送信せず「選択状態」にとどめ、
    // [送信]1回で選択＋コメントをまとめて送る（サーバAPI・記録書式は不変＝配線の組み替えのみ）。
    const ta = h('textarea', 'field op-comment');
    ta.rows = 2;
    ta.placeholder = 'コメント（NGは一言必須）';
    ta.addEventListener('input', () => autoGrow(ta));
    ops.appendChild(ta);

    if (P.normalizeType(card.type) === 'decision') {
      // decision: 選択肢ボタンで textarea 先頭に「選択=X 」を差し込み（追記コメントは保持）。
      //          [送信]で先頭 prefix を parseChoicePrefix で分離して1回送信。
      const choices = P.extractChoices(card.sections && card.sections.body);
      const send = h('button', 'btn-primary op-send', '送信');
      if (choices.length) {
        const row = h('div', 'op-choice-row');
        const chBtns = [];
        choices.forEach((ch) => {
          const b = h('button', 'op-choice', '選択 ' + ch);
          b.dataset.choice = ch;
          b.onclick = () => {
            ta.value = P.setChoicePrefix(ta.value, ch); // 先頭「選択=X」だけ差し替え・コメント保持
            chBtns.forEach((x) => x.classList.toggle('is-selected', x === b));
            autoGrow(ta);
            ta.focus();
          };
          chBtns.push(b);
          row.appendChild(b);
        });
        ops.appendChild(row);
        send.onclick = () => {
          const { choice, comment } = P.parseChoicePrefix(ta.value);
          if (choice) sendRespond(ctx, card, 'choice', { choice, comment }, [send]);
          else if (comment) sendRespond(ctx, card, 'comment', { comment }, [send]); // 選択なし＝コメントのみ（status不変）
          else ta.focus();
        };
      } else {
        // 選択肢抽出不能: 自由入力（choice）＋コメント欄＋[送信]1回（同じ一括方式）。
        const freeRow = h('div', 'op-choice-free');
        const free = h('input', 'field op-choice-input');
        free.type = 'text';
        free.placeholder = '選択（自由入力）';
        freeRow.appendChild(free);
        ops.appendChild(freeRow);
        send.onclick = () => {
          const choice = free.value.trim();
          const comment = ta.value.trim();
          if (choice) sendRespond(ctx, card, 'choice', { choice, comment }, [send]);
          else if (comment) sendRespond(ctx, card, 'comment', { comment }, [send]);
          else free.focus();
        };
      }
      ops.appendChild(send);
    } else {
      // review/report 等: OK/NG/あとで＝「選択状態」（相互排他・再タップ解除・ハイライトのみ）。
      //          textarea へ文字列注入はしない（NG一言必須の見え方を保つ）。[送信]で該当 kind を1回送信。
      const row = h('div', 'op-respond-row');
      const okBtn = h('button', 'btn-ok op-ok', 'OK');
      const ngBtn = h('button', 'btn-ng op-ng', 'NG');
      const laterBtn = h('button', 'btn-later op-later', 'あとで');
      const respBtns = [okBtn, ngBtn, laterBtn];
      okBtn.dataset.kind = 'ok'; ngBtn.dataset.kind = 'ng'; laterBtn.dataset.kind = 'later';
      const SEND_LABEL = { ok: '送信（OK）', ng: '送信（NG）', later: '送信（あとで）' };
      let selectedKind = null;
      const send = h('button', 'btn-primary op-send', 'コメントのみ送信');
      const syncSend = () => { send.textContent = selectedKind ? SEND_LABEL[selectedKind] : 'コメントのみ送信'; };
      respBtns.forEach((b) => {
        b.onclick = () => {
          selectedKind = (selectedKind === b.dataset.kind) ? null : b.dataset.kind; // 再タップで解除
          respBtns.forEach((x) => x.classList.toggle('is-selected', x.dataset.kind === selectedKind));
          ta.classList.remove('field-error');
          syncSend();
        };
      });
      row.appendChild(okBtn);
      row.appendChild(ngBtn);
      row.appendChild(laterBtn);
      ops.appendChild(row);
      send.onclick = () => {
        const comment = ta.value.trim();
        if (selectedKind === 'ng' && !comment) { ta.focus(); ta.placeholder = 'NGには一言（コメント）が必須です'; ta.classList.add('field-error'); return; }
        if (selectedKind === 'ok') sendRespond(ctx, card, 'ok', { comment }, [send]);
        else if (selectedKind === 'ng') sendRespond(ctx, card, 'ng', { comment }, [send]);
        else if (selectedKind === 'later') sendRespond(ctx, card, 'later', {}, [send]);
        else if (comment) sendRespond(ctx, card, 'comment', { comment }, [send]); // 未選択＝コメントのみ送信
        else ta.focus(); // 未選択＋コメント空 → フォーカス誘導（送信しない）
      };
      ops.appendChild(send);
    }
  }

  wrap.appendChild(ops);
}
