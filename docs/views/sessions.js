'use strict';

// views/sessions.js — Sessions 群（起動チケット一覧＋詳細・v2.4・Phase4）。
// 正はファイル（Program/Sessions/・読み取り専用）。frontmatter が無い手動チケットも一覧に出す。
// ▶起動はモバイル非対応＝**非活性表示＋「Macで起動」注記**（遠隔着火は Phase 外・別裁定）。
// データ層は program.js（listSessions/readSession）に委譲。

import { registerView } from '../registry.js';
import { h } from './shared.js';

let root, listPane, detailPane, listWrap, titleEl, metaEl, bodyEl;

function create(ctx) {
  root = h('div', 'sessions');

  listPane = h('div', 'sessions-list-pane');
  listPane.appendChild(h('p', 'view-hint', 'Program/Sessions/ の起動チケット一覧。▶起動は Mac 版のみ（モバイルは表示のみ）。'));
  listWrap = h('div', 'sessions-list');
  listWrap.textContent = '読み込み中…';
  listPane.appendChild(listWrap);
  root.appendChild(listPane);

  detailPane = h('div', 'sessions-detail-pane');
  detailPane.hidden = true;
  const head = h('div', 'sessions-detail-head');
  const back = h('button', 'btn-secondary', '← 一覧へ');
  back.onclick = () => backToList();
  titleEl = h('span', 'session-title');
  head.appendChild(back);
  head.appendChild(titleEl);
  detailPane.appendChild(head);
  metaEl = h('div', 'session-meta');
  detailPane.appendChild(metaEl);
  bodyEl = h('div', 'session-body');
  detailPane.appendChild(bodyEl);
  root.appendChild(detailPane);

  return root;
}

function onShow(ctx) { load(ctx); } // 表示のたびに更新（Mac側の launched 反映のため）

async function load(ctx) {
  if (!ctx.program || !ctx.program.listSessions) return;
  try {
    const list = await ctx.program.listSessions();
    renderList(ctx, list);
  } catch (e) {
    listWrap.innerHTML = '';
    listWrap.appendChild(h('p', 'view-hint', 'セッションの読み込みに失敗: ' + (e.message || e)));
  }
}

// ▶起動ボタン（モバイルは常に非活性＝「Macで起動」）。
function launchButton() {
  const btn = h('button', 'btn-primary session-launch', '▶ Macで起動');
  btn.disabled = true;
  btn.title = '起動は Mac 版のみです（モバイルは表示のみ）';
  return btn;
}

function renderList(ctx, list) {
  listWrap.innerHTML = '';
  if (!list.length) { listWrap.appendChild(h('p', 'view-hint', '起動チケットはありません。')); return; }
  list.forEach((s) => {
    const tile = h('div', 'session-tile');
    const head = h('div', 'session-tile-head');
    head.appendChild(h('span', 'session-id', s.id || s.dir));
    if (s.status) head.appendChild(h('span', 'chip chip-session-status', s.status));
    if (s.role) head.appendChild(h('span', 'chip', s.role));
    if (!s.hasFrontmatter) head.appendChild(h('span', 'chip', '手動'));
    tile.appendChild(head);
    tile.appendChild(h('div', 'session-tile-title', s.title || ''));
    if (s.target && s.target.length) {
      const t = h('div', 'session-targets');
      s.target.forEach((x) => t.appendChild(h('span', 'chip chip-target', x)));
      tile.appendChild(t);
    }
    const foot = h('div', 'session-tile-foot');
    const open = h('button', 'btn-secondary', '詳細');
    open.onclick = () => openSession(ctx, s.id || s.dir);
    foot.appendChild(open);
    foot.appendChild(launchButton());
    tile.appendChild(foot);
    listWrap.appendChild(tile);
  });
}

function backToList() {
  detailPane.hidden = true;
  listPane.hidden = false;
}

async function openSession(ctx, id) {
  listPane.hidden = true;
  detailPane.hidden = false;
  titleEl.textContent = id;
  metaEl.innerHTML = '';
  bodyEl.textContent = '読み込み中…';
  try {
    const s = await ctx.program.readSession(id);
    renderDetail(s);
  } catch (e) {
    bodyEl.textContent = '読み込みエラー: ' + (e.message || e);
  }
}

function renderDetail(s) {
  titleEl.textContent = (s.id || s.dir) + '　' + (s.title || '');
  metaEl.innerHTML = '';
  const rows = [
    ['role', s.role], ['対象', (s.target || []).join(', ')], ['model', s.model],
    ['permission_mode', s.permissionMode], ['remote_control_name', s.remoteControlName],
    ['cwd', s.cwd], ['confirm_mode', s.confirmMode], ['状態', s.status],
  ];
  rows.forEach(([k, v]) => {
    if (!v) return;
    const row = h('div', 'session-meta-row');
    row.appendChild(h('span', 'session-meta-key', k));
    row.appendChild(h('span', 'session-meta-val', v));
    metaEl.appendChild(row);
  });
  if (!s.hasFrontmatter) metaEl.appendChild(h('p', 'view-hint', 'frontmatter の無い手動チケットです。'));
  metaEl.appendChild(h('p', 'view-hint', '起動は Mac 版で行ってください（モバイルは表示のみ）。'));
  metaEl.appendChild(launchButton());
  bodyEl.innerHTML = '';
  renderBriefingBody(bodyEl, s.body || '');
}

// briefing 本文の軽量 md 整形（見出し/箇条書き/引用/段落・textContent 経由で安全）。
function renderBriefingBody(container, md) {
  let list = null;
  String(md).split('\n').forEach((line) => {
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) { list = null; container.appendChild(h('h' + Math.min(hm[1].length + 1, 6), 'briefing-h', hm[2])); return; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = h('ul', 'briefing-ul'); container.appendChild(list); } list.appendChild(h('li', null, li[1])); return; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { list = null; container.appendChild(h('blockquote', 'briefing-q', q[1])); return; }
    if (line.trim() === '') { list = null; return; }
    list = null;
    container.appendChild(h('p', 'briefing-p', line));
  });
}

registerView({ id: 'sessions', tabLabel: 'Sessions', create, onShow });
