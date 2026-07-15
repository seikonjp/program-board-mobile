'use strict';

// views/board.js — ボード（状態5列）。狭幅=セグメント切替の縦1カラム／広幅=カンバン。
// モバイルの主動線＝「写真を選ぶ」→カード作成。

import { registerView } from '../registry.js';
// DOM ヘルパはローカルに用意。
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const STATUS_ORDER = ['new', 'annotated', 'waiting', 'acceptance', 'consumed'];

let root;              // ビュー要素
let columnsWrap;       // #board-columns
let pendingFiles = []; // 新規カードに添付する File[]
let pendingUrls = [];  // プレビュー用 objectURL
let activeSegment = 'new';
let newType = 'reference';    // 新規カードの種別セグメント（既定=参考）
let subjectsFromLedger = [];  // SUBJECTS.md の主題名（サジェスト用・一度だけ取得）
let subjectsFetched = false;

function create(ctx) {
  root = h('div', 'board');

  // 主動線バー
  const bar = h('div', 'board-actionbar');
  const fileInput = h('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', (e) => {
    addPendingFiles(e.target.files);
    openNewCard(ctx);
    fileInput.value = '';
  });
  const photoBtn = h('button', 'btn-primary btn-big', '📷 写真を選ぶ');
  photoBtn.onclick = () => fileInput.click();
  const textBtn = h('button', 'btn-secondary', '＋ テキストで作成');
  textBtn.onclick = () => { clearPending(); openNewCard(ctx); };
  bar.appendChild(photoBtn);
  bar.appendChild(textBtn);
  bar.appendChild(fileInput);
  root.appendChild(bar);

  // セグメント（狭幅のみ表示）
  const seg = h('div', 'board-segments');
  seg.id = 'board-segments';
  STATUS_ORDER.forEach((s) => {
    const b = h('button', 'segment', ctx.constants.STATUS_JP[s]);
    b.dataset.status = s;
    b.onclick = () => { activeSegment = s; syncSegments(ctx); };
    seg.appendChild(b);
  });
  root.appendChild(seg);

  // カラム
  columnsWrap = h('div', 'board-columns');
  columnsWrap.id = 'board-columns';
  columnsWrap.dataset.active = activeSegment;
  root.appendChild(columnsWrap);

  // 詳細モーダル・新規カードモーダルを内包
  root.appendChild(buildDetailModal(ctx));
  root.appendChild(buildNewModal(ctx));

  return root;
}

function onData(ctx) {
  renderColumns(ctx);
  syncSegments(ctx);
}
function onShow(ctx) {
  renderColumns(ctx);
  syncSegments(ctx);
}

function syncSegments(ctx) {
  columnsWrap.dataset.active = activeSegment;
  const seg = document.getElementById('board-segments');
  if (!seg) return;
  for (const b of seg.children) {
    b.classList.toggle('is-active', b.dataset.status === activeSegment);
  }
}

function renderColumns(ctx) {
  // type=knowledge（知見・ストック型）はカンバンから除外し「知見」タブへ分離する（フロー汚染防止）。
  const cards = (ctx.state.cards || []).filter((c) => c.type !== 'knowledge');
  columnsWrap.innerHTML = '';
  const byStatus = {};
  STATUS_ORDER.forEach((s) => (byStatus[s] = []));
  cards.forEach((c) => {
    const s = STATUS_ORDER.includes(c.status) ? c.status : 'new';
    byStatus[s].push(c);
  });
  STATUS_ORDER.forEach((s) => {
    const col = h('div', 'column');
    col.dataset.status = s;
    const head = h('div', 'column-head');
    head.appendChild(h('span', 'column-title', ctx.constants.STATUS_JP[s]));
    head.appendChild(h('span', 'column-count', String(byStatus[s].length)));
    col.appendChild(head);
    if (byStatus[s].length === 0) {
      col.appendChild(h('p', 'column-empty', '（なし）'));
    }
    byStatus[s].forEach((c) => col.appendChild(cardTile(c, ctx)));
    columnsWrap.appendChild(col);
  });
}

function cardTile(card, ctx) {
  const t = h('div', 'card-tile');
  if (card.images && card.images.length) {
    const img = h('img', 'card-thumb');
    img.alt = card.title || '';
    ctx.attachImage(img, card.dir, card.images[0]);
    t.appendChild(img);
  } else {
    t.appendChild(h('div', 'card-thumb card-thumb-empty', '画像なし'));
  }
  const body = h('div', 'card-tile-body');
  body.appendChild(h('div', 'card-tile-title', card.title || '（無題）'));
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  if (card.type) meta.appendChild(h('span', 'chip', ctx.constants.TYPE_JP[card.type] || card.type));
  (card.tags || []).forEach((tag) => meta.appendChild(h('span', 'chip', '#' + tag)));
  body.appendChild(meta);
  t.appendChild(body);
  t.onclick = () => openDetail(card, ctx);
  return t;
}

// ---- 詳細モーダル ----
function buildDetailModal(ctx) {
  const backdrop = h('div', 'backdrop');
  backdrop.id = 'detail-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'detail-backdrop') backdrop.hidden = true; });
  const sheet = h('div', 'sheet');
  sheet.id = 'detail-sheet';
  backdrop.appendChild(sheet);
  return backdrop;
}
function openDetail(card, ctx) {
  const sheet = document.getElementById('detail-sheet');
  sheet.innerHTML = '';
  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, card.title || '（無題）'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = () => { document.getElementById('detail-backdrop').hidden = true; };
  head.appendChild(close);
  sheet.appendChild(head);

  const body = h('div', 'sheet-body');
  const meta = h('div', 'card-meta');
  meta.appendChild(h('span', 'chip chip-id', card.id));
  meta.appendChild(h('span', 'chip', ctx.constants.STATUS_JP[card.status] || card.status));
  if (card.type) meta.appendChild(h('span', 'chip', ctx.constants.TYPE_JP[card.type] || card.type));
  if (card.subject) meta.appendChild(h('span', 'chip', '主題: ' + card.subject));
  if (card.direction) meta.appendChild(h('span', 'chip', ctx.constants.DIRECTION_JP[card.direction] || card.direction));
  if (card.surface) meta.appendChild(h('span', 'chip', '浮上: ' + card.surface));
  (card.tags || []).forEach((tag) => meta.appendChild(h('span', 'chip', '#' + tag)));
  body.appendChild(meta);

  if (card.images && card.images.length) {
    const imgs = h('div', 'detail-imgs');
    card.images.forEach((f) => {
      const im = h('img', 'detail-img');
      ctx.attachImage(im, card.dir, f);
      imgs.appendChild(im);
    });
    body.appendChild(imgs);
  }
  addSection(body, '本文', card.sections.body);
  addSection(body, '注釈', card.sections.note);
  addSection(body, '処理記録', card.sections.record);

  sheet.appendChild(body);
  document.getElementById('detail-backdrop').hidden = false;
}
function addSection(wrap, title, content) {
  if (!content) return;
  const s = h('div', 'detail-section');
  s.appendChild(h('h4', null, title));
  s.appendChild(h('pre', 'detail-text', content));
  wrap.appendChild(s);
}

// ---- 新規カードモーダル ----
function buildNewModal(ctx) {
  const backdrop = h('div', 'backdrop');
  backdrop.id = 'new-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'new-backdrop') closeNew(); });

  const sheet = h('div', 'sheet');
  const head = h('div', 'sheet-head');
  head.appendChild(h('h2', null, '新規カード'));
  const close = h('button', 'icon-btn', '×');
  close.onclick = closeNew;
  head.appendChild(close);
  sheet.appendChild(head);

  const body = h('div', 'sheet-body');

  const thumbs = h('div', 'new-thumbs');
  thumbs.id = 'new-thumbs';
  body.appendChild(thumbs);

  const addPhoto = h('button', 'btn-secondary', '📷 写真を追加');
  const addInput = h('input');
  addInput.type = 'file';
  addInput.accept = 'image/*';
  addInput.multiple = true;
  addInput.hidden = true;
  addInput.addEventListener('change', (e) => { addPendingFiles(e.target.files); renderThumbs(); addInput.value = ''; });
  addPhoto.onclick = () => addInput.click();
  body.appendChild(addPhoto);
  body.appendChild(addInput);

  const title = h('input', 'field');
  title.id = 'new-title';
  title.type = 'text';
  title.placeholder = 'タイトル';
  body.appendChild(labeled('タイトル', title));

  const bodyText = h('textarea', 'field');
  bodyText.id = 'new-body';
  bodyText.rows = 4;
  bodyText.placeholder = '本文（任意）';
  body.appendChild(labeled('本文', bodyText));

  // 種別セグメント（参考/知見/要望・既定=参考）
  const typeSeg = h('div', 'type-segment');
  typeSeg.id = 'new-type-seg';
  [['reference', '参考'], ['knowledge', '知見'], ['request', '要望']].forEach(([v, t]) => {
    const b = h('button', 'seg-btn', t);
    b.type = 'button';
    b.dataset.type = v;
    b.onclick = () => { newType = v; syncTypeSegment(); };
    typeSeg.appendChild(b);
  });
  body.appendChild(labeled('種別', typeSeg));

  // 主題入力（datalist サジェスト＝読込済み全カードの subject ∪ SUBJECTS.md の主題名・自由入力可）
  const subjectInput = h('input', 'field');
  subjectInput.id = 'new-subject';
  subjectInput.type = 'text';
  subjectInput.placeholder = '主題（任意・例: 自動調整）';
  subjectInput.autocomplete = 'off';
  subjectInput.setAttribute('list', 'subject-list');
  const datalist = document.createElement('datalist');
  datalist.id = 'subject-list';
  body.appendChild(labeled('主題', subjectInput));
  body.appendChild(datalist);

  const dirSel = h('select', 'field');
  dirSel.id = 'new-direction';
  [['user-to-claude', 'あなた→AI'], ['claude-to-user', 'AI→あなた']].forEach(([v, t]) => {
    const o = h('option', null, t); o.value = v; dirSel.appendChild(o);
  });
  body.appendChild(labeled('方向', dirSel));

  const submit = h('button', 'btn-primary btn-big', 'カードを作成');
  submit.id = 'new-submit';
  submit.onclick = () => submitNew(ctx, submit);
  body.appendChild(submit);

  sheet.appendChild(body);
  backdrop.appendChild(sheet);
  return backdrop;
}

function labeled(labelText, field) {
  const wrap = h('div', 'field-row');
  const l = h('label', null, labelText);
  if (field.id) l.htmlFor = field.id;
  wrap.appendChild(l);
  wrap.appendChild(field);
  return wrap;
}

function openNewCard(ctx) {
  renderThumbs();
  syncTypeSegment();
  populateSubjectDatalist(ctx);
  ensureSubjects(ctx);
  document.getElementById('new-backdrop').hidden = false;
}
function closeNew() {
  document.getElementById('new-backdrop').hidden = true;
}

function syncTypeSegment() {
  const seg = document.getElementById('new-type-seg');
  if (!seg) return;
  for (const b of seg.children) b.classList.toggle('is-active', b.dataset.type === newType);
}

// 既存カードの subject 値 ∪ SUBJECTS.md の主題名を datalist に反映（自由入力は妨げない）。
function populateSubjectDatalist(ctx) {
  const datalist = document.getElementById('subject-list');
  if (!datalist) return;
  const set = new Set();
  (ctx.state.cards || []).forEach((c) => { if (c.subject) set.add(c.subject); });
  subjectsFromLedger.forEach((s) => { if (s) set.add(s); });
  datalist.innerHTML = '';
  [...set].sort((a, b) => a.localeCompare(b, 'ja')).forEach((s) => {
    const o = document.createElement('option');
    o.value = s;
    datalist.appendChild(o);
  });
}

// SUBJECTS.md を一度だけ取得してサジェストへ合流（無ければ既存カードの subject のみ）。
function ensureSubjects(ctx) {
  if (subjectsFetched) return;
  subjectsFetched = true;
  Promise.resolve()
    .then(() => ctx.program.readSubjects())
    .then((names) => { subjectsFromLedger = names || []; populateSubjectDatalist(ctx); })
    .catch(() => { /* SUBJECTS.md 無し等は無視（サジェストは既存カードのみ） */ });
}

function addPendingFiles(fileList) {
  for (const f of [...fileList]) {
    if ((f.type || '').startsWith('image/')) pendingFiles.push(f);
  }
}
function clearPending() {
  pendingFiles = [];
  pendingUrls.forEach((u) => URL.revokeObjectURL(u));
  pendingUrls = [];
  newType = 'reference';
  const t = document.getElementById('new-title'); if (t) t.value = '';
  const b = document.getElementById('new-body'); if (b) b.value = '';
  const s = document.getElementById('new-subject'); if (s) s.value = '';
}
function renderThumbs() {
  const wrap = document.getElementById('new-thumbs');
  if (!wrap) return;
  wrap.innerHTML = '';
  pendingUrls.forEach((u) => URL.revokeObjectURL(u));
  pendingUrls = [];
  pendingFiles.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    pendingUrls.push(url);
    const im = h('img', 'new-thumb');
    im.src = url;
    im.title = 'タップで削除';
    im.onclick = () => { pendingFiles.splice(i, 1); renderThumbs(); };
    wrap.appendChild(im);
  });
}

async function submitNew(ctx, submitBtn) {
  const title = document.getElementById('new-title').value.trim();
  const body = document.getElementById('new-body').value;
  const subject = document.getElementById('new-subject').value.trim();
  const type = newType;
  const direction = document.getElementById('new-direction').value;
  if (!title && pendingFiles.length === 0) {
    ctx.toast('タイトルまたは写真が必要です');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = '作成中…';
  try {
    const images = await ctx.prepareImages(pendingFiles);
    await ctx.program.createCard({ title: title || '（無題）', body, type, direction, subject, images }, ctx.state.cardDirs);
    clearPending();
    closeNew();
    ctx.toast('カードを作成しました');
    await ctx.reload();
  } catch (e) {
    ctx.toast('作成に失敗: ' + (e.message || e));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'カードを作成';
  }
}

registerView({
  id: 'board',
  tabLabel: 'ボード',
  create,
  onData,
  onShow,
});
