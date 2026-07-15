'use strict';

// app.js — アプリ殻（シェル）。ビューは登録制で読み込み、データ層は program.js に委譲。
//
// 責務: 起動 / OAuth リダイレクト処理 / タブ構築 / ポーリング / 設定 / 画像遅延読込 /
//       接続オーバーレイ / Service Worker 登録。画面の中身は views/*.js が持つ。

import { getConfig, saveConfigOverride, enabledViewIds } from './config.js';
import * as P from './parser.js';
import {
  createDropboxClient, loadTokens, saveTokens, clearTokens,
  generateCodeVerifier, codeChallengeFromVerifier, randomState,
  buildAuthorizeUrl, exchangeCodeForTokens, stashPkce, takePkce,
} from './dropbox.js';
import { createProgram } from './program.js';
import { getView, listViews } from './registry.js';

const CACHE_KEY = 'pbm_cache_cards';

const config = getConfig();
const dropbox = createDropboxClient({
  clientId: config.dropboxClientId,
  tokens: loadTokens(),
  onTokensChanged: saveTokens,
});
const program = createProgram(dropbox, config);

// ---- DOM ヘルパ ----
function $(sel) { return document.querySelector(sel); }
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---- 画像遅延読込（IntersectionObserver + objectURL キャッシュ） ----
const imgCache = new Map(); // path -> objectURL
const mimeByExt = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
function mimeOf(name) {
  const i = name.lastIndexOf('.');
  return mimeByExt[i === -1 ? '' : name.slice(i).toLowerCase()] || 'application/octet-stream';
}
const imgObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { imgObserver.unobserve(e.target); void loadImageInto(e.target); }
      }
    }, { rootMargin: '250px' })
  : null;

function attachImage(imgEl, dir, file) {
  imgEl.dataset.dir = dir;
  imgEl.dataset.file = file;
  imgEl.classList.add('img-lazy');
  if (imgObserver) imgObserver.observe(imgEl);
  else void loadImageInto(imgEl);
}
async function loadImageInto(imgEl) {
  const dir = imgEl.dataset.dir, file = imgEl.dataset.file;
  const path = program.imgPath(dir, file);
  try {
    let url = imgCache.get(path);
    if (!url) {
      const bytes = await program.downloadImage(dir, file);
      url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(file) }));
      imgCache.set(path, url);
    }
    imgEl.src = url;
    imgEl.classList.add('img-loaded');
  } catch {
    imgEl.classList.add('img-error');
    imgEl.alt = '画像を読み込めません';
  }
}

// ---- 画像の前処理（長辺上限で縮小・カメラロール由来） ----
async function prepareImages(files, maxEdge) {
  const out = [];
  for (const file of [...files]) {
    if (!(file.type || '').startsWith('image/')) continue;
    const orig = new Uint8Array(await file.arrayBuffer());
    if (!maxEdge) { out.push({ name: file.name || 'image.png', bytes: orig }); continue; }
    try {
      const bmp = await createImageBitmap(file);
      const long = Math.max(bmp.width, bmp.height);
      if (long <= maxEdge) { if (bmp.close) bmp.close(); out.push({ name: file.name || 'image.png', bytes: orig }); continue; }
      const scale = maxEdge / long;
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const base = (file.name || 'image').replace(/\.[^.]*$/, '');
      out.push({ name: base + '.jpg', bytes });
    } catch {
      out.push({ name: file.name || 'image.png', bytes: orig });
    }
  }
  return out;
}

// ---- トースト ----
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---- 同期表示・オフライン ----
function setSync(text) { $('#sync-note').textContent = text; }
function setOffline(on) {
  $('#offline-indicator').hidden = !on;
}

// ---- 共有コンテキスト（views に渡す） ----
const ctx = {
  config,
  program,
  dropbox,
  parser: P,
  constants: {
    STATUS_ORDER: P.STATUS_ORDER,
    STATUS_LABEL: P.STATUS_LABEL,
    TYPE_LABEL: P.TYPE_LABEL,
    DIRECTION_LABEL: P.DIRECTION_LABEL,
    typeLabel: P.typeLabel,
    normalizeType: P.normalizeType,
  },
  state: { cards: [], cardDirs: [], activeTab: null, online: true, connected: false },
  el,
  toast,
  attachImage,
  prepareImages: (files) => prepareImages(files, config.imageMaxEdge),
  // 書き込み後の再取得（キャッシュ無効化のうえフル同期）。
  reload: async () => { cardCache = new Map(); await refresh({ quiet: true }); },
};

// ---- ビュー生成・タブ ----
const created = {}; // id -> { def, el }
const viewHost = () => $('#view-host');
const tabbar = () => $('#tabbar');

function ensureCreated(id) {
  if (created[id]) return created[id];
  const def = getView(id);
  if (!def) return null;
  const element = def.create(ctx);
  element.classList.add('view');
  element.id = 'view-' + id;
  element.hidden = true;
  viewHost().appendChild(element);
  created[id] = { def, el: element };
  return created[id];
}

function buildTabbar() {
  const bar = tabbar();
  bar.innerHTML = '';
  const views = listViews(enabledViewIds());
  for (const def of views) {
    const btn = el('button', 'tab');
    btn.dataset.id = def.id;
    const label = el('span', 'tab-label', def.tabLabel || def.id);
    const badge = el('span', 'tab-badge');
    badge.hidden = true;
    btn.appendChild(label);
    btn.appendChild(badge);
    btn.onclick = () => setTab(def.id);
    bar.appendChild(btn);
  }
}

function updateBadges() {
  for (const btn of tabbar().children) {
    const def = getView(btn.dataset.id);
    const badge = btn.querySelector('.tab-badge');
    let n = null;
    if (def && typeof def.badge === 'function') { try { n = def.badge(ctx); } catch { n = null; } }
    if (n && n > 0) { badge.textContent = String(n); badge.hidden = false; }
    else { badge.hidden = true; }
  }
}

function setTab(id) {
  const ids = enabledViewIds();
  if (!getView(id)) id = ids[0];
  ctx.state.activeTab = id;
  for (const vid of ids) {
    const c = ensureCreated(vid);
    if (c) c.el.hidden = vid !== id;
  }
  for (const btn of tabbar().children) btn.classList.toggle('is-active', btn.dataset.id === id);
  const cur = ensureCreated(id);
  if (cur && cur.def.onShow) cur.def.onShow(ctx);
}

function notifyData() {
  for (const id of Object.keys(created)) {
    const c = created[id];
    if (c.def.onData) { try { c.def.onData(ctx); } catch (e) { console.error('onData', id, e); } }
  }
  updateBadges();
}

// ---- データ同期 ----
let cardCache = new Map();
let refreshing = false;

async function refresh(opts) {
  const quiet = opts && opts.quiet;
  if (!dropbox.isConnected()) return;
  if (refreshing) return;
  refreshing = true;
  try {
    setSync('同期中…');
    if (!quiet) flowLog('同期開始（一覧取得）');
    const { cards, cache, cardDirs } = await program.loadCards(cardCache);
    if (!quiet) flowLog('同期成功: カード' + cards.length + '件');
    cardCache = cache;
    ctx.state.cards = cards;
    ctx.state.cardDirs = cardDirs;
    ctx.state.online = true;
    setOffline(false);
    persistCache(cards);
    notifyData();
    setSync('同期: ' + new Date().toLocaleTimeString('ja-JP'));
  } catch (e) {
    ctx.state.online = false;
    setOffline(true);
    const msg = String(e && e.message || e);
    let hint = '';
    if (msg.includes('missing_scope')) hint = '→ Dropbox App設定のPermissionsで4項目にチェックし「Submit」→ このアプリの設定から「切断」→ 再接続してください';
    else if (msg.includes('not_found')) hint = '→ 設定の「Programルートパス」がDropbox上の実際の場所と一致しているか確認してください（既定 /ArchPlan/Program）';
    else if (msg.includes('invalid_access_token') || msg.includes('401')) hint = '→ 設定から「切断」→ 再接続してください';
    setSync('⚠ 同期エラー: ' + msg + ' ' + hint);
    if (!quiet) flowLog('同期失敗: ' + msg);
    if (!quiet) toast('同期エラー: ' + msg);
    if (ctx.state.cards.length === 0) {
      const cached = loadPersistedCache();
      if (cached) { ctx.state.cards = cached; notifyData(); }
    }
  } finally {
    refreshing = false;
  }
}

function persistCache(cards) {
  try {
    // 画像バイトは保持しない（メタ＋本文のみ＝オフライン閲覧用）。
    localStorage.setItem(CACHE_KEY, JSON.stringify(cards));
  } catch { /* 容量超過等は無視 */ }
}
function loadPersistedCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

// ---- ポーリング ----
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine && dropbox.isConnected()) {
      void refresh({ quiet: true });
    }
  }, config.pollIntervalMs);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---- OAuth（PKCE） ----
function redirectUri() { return location.origin + location.pathname; }
function cleanUrl() { history.replaceState({}, '', location.pathname); }

const LOG_KEY = 'pbm_flow_log';
function flowLog(msg) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { arr = []; }
  arr.push(new Date().toLocaleTimeString('ja-JP') + ' ' + msg);
  if (arr.length > 30) arr = arr.slice(-30);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(arr)); } catch { /* noop */ }
  renderFlowLog();
}
function renderFlowLog() {
  const el = $('#diag-out');
  if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { arr = []; }
  if (arr.length) el.textContent = '― 接続ログ ―\n' + arr.join('\n');
}

async function runDiagnostics() {
  const out = $('#diag-out');
  const lines = [];
  const show = () => { out.textContent = lines.join('\n'); };
  const probe = async (label, fn) => {
    try {
      const res = await fn();
      lines.push('OK ' + label + ' -> HTTP ' + res.status);
    } catch (e) {
      lines.push('NG ' + label + ' -> ' + (e && e.message || e));
    }
    show();
  };
  lines.push('環境: ' + (navigator.standalone ? 'ホーム画面アプリ' : 'ブラウザ') + ' / online=' + navigator.onLine);
  lines.push('トークン保持: ' + (dropbox.isConnected() ? 'あり' : 'なし'));
  show();
  await probe('(1) 到達確認(no-cors)', async () => { await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'GET', mode: 'no-cors' }); return { status: '到達' }; });
  await probe('(2) POST token単純', () => fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=diag&client_id=' + encodeURIComponent(config.dropboxClientId),
  }));
  await probe('(3) POST list_folderプリフライト', () => fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST', headers: { Authorization: 'Bearer diag', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '' }),
  }));
  await probe('(4) POST contentホスト', () => fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { Authorization: 'Bearer diag', 'Dropbox-API-Arg': '{"path":"/diag"}' },
  }));
  lines.push('注: HTTP 4xxは「届いている」=正常。NGだけが異常。');
  show();
}

async function startConnect(opts) {
  const force = !!(opts && opts.force);
  if (!config.dropboxClientId || config.dropboxClientId.includes('PUT_YOUR')) {
    toast('config.js に Dropbox App key を設定してください');
    $('#connect-hint').textContent = 'docs/config.js の dropboxClientId が未設定です。';
    return;
  }
  flowLog('接続開始');
  let verifier, challenge, state;
  try {
    verifier = generateCodeVerifier();
    challenge = await codeChallengeFromVerifier(verifier);
    state = randomState();
  } catch (e) { flowLog('鍵生成に失敗: ' + (e && e.message || e)); toast('鍵生成に失敗'); return; }
  stashPkce({ verifier, state });
  flowLog(force ? '一時鍵を保存→Dropbox再承認画面へ移動（force）' : '一時鍵を保存→Dropbox認可画面へ移動');
  location.href = buildAuthorizeUrl({
    clientId: config.dropboxClientId,
    redirectUri: redirectUri(),
    challenge,
    state,
    forceReapprove: force,
  });
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const err = params.get('error');
  if (err) { cleanUrl(); flowLog('認可キャンセル/拒否: ' + err); toast('認可がキャンセルされました'); return false; }
  if (!code) return false;
  flowLog('Dropboxから戻り（code受領）');
  const pk = takePkce();
  if (!pk) { cleanUrl(); flowLog('失敗: 一時鍵が見つからない（保存領域が移動中に消えた）'); toast('認可の検証に失敗（一時鍵消失）'); return false; }
  if (pk.state !== state) { cleanUrl(); flowLog('失敗: state不一致'); toast('認可の検証に失敗（state 不一致）'); return false; }
  flowLog('一時鍵OK→トークン交換を開始');
  try {
    const tokens = await exchangeCodeForTokens({
      clientId: config.dropboxClientId,
      code,
      verifier: pk.verifier,
      redirectUri: redirectUri(),
    });
    flowLog('トークン交換成功（refresh鍵: ' + (tokens.refresh_token ? 'あり' : '⚠なし') + ' / scope: ' + (tokens.scope || '省略') + '）→保存');
    saveTokens(tokens);
    dropbox.setTokens(tokens);
    cleanUrl();
    if (!tokens.refresh_token) {
      // 自動再承認では長期鍵が省かれることがある→一度だけ明示的な再承認でやり直す
      if (!sessionStorage.getItem('pbm_forced')) {
        sessionStorage.setItem('pbm_forced', '1');
        flowLog('長期鍵なし→再承認モードで自動やり直し');
        await startConnect({ force: true });
        return false;
      }
      flowLog('再承認でも長期鍵なし＝要調査（このログを報告してください）');
    }
    sessionStorage.removeItem('pbm_forced');
    return true;
  } catch (e) {
    cleanUrl();
    flowLog('失敗: トークン交換 ' + (e && e.message || e) + (e && e.status ? '［HTTP ' + e.status + '］' : ''));
    toast('接続に失敗: ' + (e.message || e));
    return false;
  }
}

function disconnect() {
  clearTokens();
  dropbox.setTokens(null);
  updateConnStatus();
  showConnectOverlay();
  stopPolling();
}

// ---- 接続オーバーレイ ----
function showConnectOverlay() { $('#connect-overlay').hidden = false; }
function hideConnectOverlay() { $('#connect-overlay').hidden = true; }

// ---- 設定 ----
function updateConnStatus() {
  const s = $('#conn-status');
  if (!s) return;
  s.textContent = dropbox.isConnected() ? '接続済み' : '未接続';
  s.classList.toggle('is-connected', dropbox.isConnected());
}

function openSettings() {
  $('#cfg-root').value = config.programRoot;
  const sel = $('#cfg-tab');
  sel.innerHTML = '';
  for (const def of listViews(enabledViewIds())) {
    const o = el('option', null, def.tabLabel || def.id);
    o.value = def.id;
    if (def.id === config.defaultTab) o.selected = true;
    sel.appendChild(o);
  }
  updateConnStatus();
  $('#settings-backdrop').hidden = false;
}
function closeSettings() { $('#settings-backdrop').hidden = true; }

function saveSettings() {
  const root = $('#cfg-root').value.trim() || '/ArchPlan/Program';
  const tab = $('#cfg-tab').value;
  saveConfigOverride({ programRoot: root, defaultTab: tab });
  toast('保存しました。反映のため再読み込みします。');
  setTimeout(() => location.reload(), 700);
}

// ---- Service Worker ----
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 失敗しても致命でない */ });
  }
}

// ---- 配線 ----
function wire() {
  $('#btn-refresh').onclick = () => refresh();
  $('#btn-settings').onclick = openSettings;
  $('#settings-close').onclick = closeSettings;
  $('#settings-backdrop').addEventListener('click', (e) => { if (e.target.id === 'settings-backdrop') closeSettings(); });
  $('#btn-connect').onclick = startConnect;
  const bd = $('#btn-diag'); if (bd) bd.onclick = () => { void runDiagnostics(); };
  $('#btn-connect2').onclick = startConnect;
  $('#btn-disconnect').onclick = disconnect;
  $('#btn-save-settings').onclick = saveSettings;

  window.addEventListener('online', () => { setOffline(false); if (dropbox.isConnected()) refresh({ quiet: true }); });
  window.addEventListener('offline', () => setOffline(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && dropbox.isConnected() && navigator.onLine) refresh({ quiet: true });
  });
}

// ---- 起動 ----
async function boot() {
  registerServiceWorker();
  wire();
  setOffline(!navigator.onLine);

  renderFlowLog();
  const justConnected = await handleRedirect();

  // 有効ビューを動的 import（各モジュールが registerView で自己登録）。
  let vOk = 0, vNg = [];
  for (const id of enabledViewIds()) {
    try { await import('./views/' + id + '.js'); vOk++; }
    catch (e) { vNg.push(id + ':' + (e && e.message || e)); console.error('ビュー読込失敗: ' + id, e); }
  }
  if (justConnected || vNg.length) flowLog('ビュー読込 ' + vOk + '/' + enabledViewIds().length + (vNg.length ? ' 失敗=' + vNg.join('; ') : ''));
  try {
    buildTabbar();
  } catch (e) { flowLog('タブ構築で例外: ' + (e && e.message || e)); }

  if (dropbox.isConnected()) {
    if (justConnected) flowLog('接続済み判定→ボード表示へ');
    hideConnectOverlay();
    ctx.state.connected = true;
    try { setTab(config.defaultTab); } catch (e) { flowLog('タブ表示で例外: ' + (e && e.message || e)); }
    await refresh({ quiet: !justConnected });
    startPolling();
  } else {
    if (justConnected) flowLog('⚠交換成功なのに未接続判定（refresh鍵の保持失敗）→接続画面へ');
    showConnectOverlay();
    // タブ自体は構築済みだが操作は接続後。
  }
}

document.addEventListener('DOMContentLoaded', boot);
