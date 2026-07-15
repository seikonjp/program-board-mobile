'use strict';

// dropbox.js — Dropbox API v2 のゲートウェイ層（唯一の外部通信点）
//
// - OAuth2 PKCE（公開クライアント・client secret なし）／refresh token 対応
// - トークンは localStorage のみ（外部送信なし）。通信先は Dropbox API だけ
// - 削除 API は一切実装しない（状態変更のみ）
// - fetch は注入可能（既定 globalThis.fetch）＝ node --test で fetch モック可能
//
// ブラウザ・Node（Web Crypto / fetch を持つ Node 22+）の双方で動く ESM。

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const RPC_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

const TOKENS_KEY = 'pbm_tokens';
const PKCE_KEY = 'pbm_pkce';

// ---------------------------------------------------------------------------
// PKCE ヘルパ（Web Crypto）
// ---------------------------------------------------------------------------

function base64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoaSafe(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function btoaSafe(s) {
  if (typeof btoa === 'function') return btoa(s);
  // Node フォールバック
  return Buffer.from(s, 'binary').toString('base64');
}

export function generateCodeVerifier() {
  const bytes = new Uint8Array(64);
  (globalThis.crypto || {}).getRandomValues(bytes);
  return base64url(bytes);
}

export async function codeChallengeFromVerifier(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

export function randomState() {
  const bytes = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues(bytes);
  return base64url(bytes);
}

// Dropbox-API-Arg は HTTP ヘッダ ＝ 非 ASCII（日本語フォルダ名等）を \uXXXX へエスケープする。
export function apiArg(obj) {
  return JSON.stringify(obj).replace(/[-￿]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---------------------------------------------------------------------------
// トークン保管（localStorage のみ）
// ---------------------------------------------------------------------------

export function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearTokens() {
  localStorage.removeItem(TOKENS_KEY);
}

// PKCE 一時値（verifier / state）は認可リダイレクトをまたぐため localStorage に一時保持。
export function stashPkce(v) {
  const raw = JSON.stringify(v);
  try { localStorage.setItem(PKCE_KEY, raw); } catch { /* private等 */ }
  try { sessionStorage.setItem(PKCE_KEY, raw); } catch { /* private等 */ }
}
export function takePkce() {
  const raw = localStorage.getItem(PKCE_KEY) || sessionStorage.getItem(PKCE_KEY);
  try { localStorage.removeItem(PKCE_KEY); } catch { /* noop */ }
  try { sessionStorage.removeItem(PKCE_KEY); } catch { /* noop */ }
  try { return JSON.parse(raw || 'null'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// OAuth2 PKCE フロー
// ---------------------------------------------------------------------------

// 認可 URL を組み立てる（呼び出し側で verifier/state を stash 済みの前提）。
export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline', // refresh token を得る
    state,
  });
  return AUTHORIZE_URL + '?' + q.toString();
}

export async function exchangeCodeForTokens({ clientId, code, verifier, redirectUri, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new DropboxError('token 交換に失敗', res.status, json);
  return normalizeTokenResponse(json);
}

export async function refreshTokens({ clientId, refreshToken, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new DropboxError('token 更新に失敗', res.status, json);
  // refresh レスポンスに refresh_token は通常含まれない → 既存を維持
  const t = normalizeTokenResponse(json);
  if (!t.refresh_token) t.refresh_token = refreshToken;
  return t;
}

function normalizeTokenResponse(json) {
  const expiresInMs = (json.expires_in ? json.expires_in : 14400) * 1000;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    expires_at: Date.now() + expiresInMs - 60000, // 1 分の安全マージン
    account_id: json.account_id || null,
    scope: json.scope || null,
  };
}

// ---------------------------------------------------------------------------
// エラー型
// ---------------------------------------------------------------------------

export class DropboxError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'DropboxError';
    this.status = status;
    this.detail = detail;
  }
  // Dropbox の error_summary が示すタグを判定するヘルパ。
  is(tagFragment) {
    const summary = this.detail && (this.detail.error_summary || (this.detail.error && this.detail.error['.tag']));
    return typeof summary === 'string' && summary.includes(tagFragment);
  }
}

// ---------------------------------------------------------------------------
// Dropbox クライアント
// ---------------------------------------------------------------------------

export function createDropboxClient({ clientId, fetchImpl, tokens, onTokensChanged }) {
  const f = fetchImpl || globalThis.fetch;
  let tok = tokens || null;

  function setTokens(next) {
    tok = next;
    if (onTokensChanged) onTokensChanged(next);
  }

  function isConnected() {
    return !!(tok && tok.refresh_token);
  }

  async function ensureAccessToken() {
    if (!tok || !tok.refresh_token) throw new DropboxError('未接続です', 401, null);
    if (tok.access_token && tok.expires_at && Date.now() < tok.expires_at) {
      return tok.access_token;
    }
    const next = await refreshTokens({ clientId, refreshToken: tok.refresh_token, fetchImpl: f });
    setTokens(next);
    return next.access_token;
  }

  // RPC 系（application/json）。
  async function rpc(endpoint, argObj, { retryAuth = true } = {}) {
    const token = await ensureAccessToken();
    const res = await f(RPC_BASE + endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: argObj === null ? 'null' : JSON.stringify(argObj),
    });
    if (res.status === 401 && retryAuth) {
      forceExpire();
      return rpc(endpoint, argObj, { retryAuth: false });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const summary = json && typeof json === 'object' && json.error_summary ? json.error_summary : '';
      throw new DropboxError('RPC 失敗: ' + endpoint + (summary ? '（' + summary + '）' : '') + '［HTTP ' + res.status + '］', res.status, json);
    }
    return json;
  }

  function forceExpire() {
    if (tok) tok = { ...tok, access_token: null, expires_at: 0 };
  }

  // download（content 系）→ { text|bytes, rev }。
  async function download(dpath, { binary = false, retryAuth = true } = {}) {
    const token = await ensureAccessToken();
    const res = await f(CONTENT_BASE + '/files/download', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Dropbox-API-Arg': apiArg({ path: dpath }),
      },
    });
    if (res.status === 401 && retryAuth) {
      forceExpire();
      return download(dpath, { binary, retryAuth: false });
    }
    if (!res.ok) {
      let detail = null;
      try { detail = JSON.parse(await res.text()); } catch { /* noop */ }
      throw new DropboxError('download 失敗: ' + dpath, res.status, detail);
    }
    const metaHeader = res.headers.get('Dropbox-API-Result') || res.headers.get('dropbox-api-result');
    let rev = null;
    try { rev = metaHeader ? JSON.parse(metaHeader).rev : null; } catch { rev = null; }
    if (binary) {
      const buf = await res.arrayBuffer();
      return { bytes: new Uint8Array(buf), rev };
    }
    return { text: await res.text(), rev };
  }

  // upload（content 系）。mode 例: {'.tag':'add', autorename:false} / {'.tag':'update', update:rev}。
  async function upload(dpath, body, mode, { retryAuth = true } = {}) {
    const token = await ensureAccessToken();
    const arg = {
      path: dpath,
      mode: mode || { '.tag': 'add' },
      autorename: false,
      mute: true,
      strict_conflict: false,
    };
    const res = await f(CONTENT_BASE + '/files/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Dropbox-API-Arg': apiArg(arg),
        'Content-Type': 'application/octet-stream',
      },
      body,
    });
    if (res.status === 401 && retryAuth) {
      forceExpire();
      return upload(dpath, body, mode, { retryAuth: false });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new DropboxError('upload 失敗: ' + dpath, res.status, json);
    return json;
  }

  function uploadText(dpath, textContent, mode, opts) {
    const body = new TextEncoder().encode(textContent);
    return upload(dpath, body, mode, opts);
  }

  // list_folder（ページング込みで全件返す）。
  async function listFolder(dpath, { recursive = false } = {}) {
    const first = await rpc('/files/list_folder', { path: dpath, recursive, include_media_info: false });
    let entries = first.entries || [];
    let cursor = first.cursor;
    let hasMore = first.has_more;
    while (hasMore) {
      const cont = await rpc('/files/list_folder/continue', { cursor });
      entries = entries.concat(cont.entries || []);
      cursor = cont.cursor;
      hasMore = cont.has_more;
    }
    return entries;
  }

  // rev 指定 update の 409 競合リトライ:
  //   download → transform(text) → update(mode: update rev) を upload。
  //   409（path/conflict）なら再 download して transform を再適用（最大 maxRetries 回）。
  //   §2/§3 等 transform が触れない部分は最新版に対して再適用されるため保全される。
  async function updateTextFileWithRetry(dpath, transform, { maxRetries = 3, createIfMissing = false } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let current = '';
      let rev = null;
      let existed = true;
      try {
        const dl = await download(dpath);
        current = dl.text;
        rev = dl.rev;
      } catch (e) {
        const notFound = e instanceof DropboxError && (e.status === 409 || e.status === 404) &&
          (e.is('not_found') || e.status === 404);
        if (createIfMissing && notFound) {
          existed = false;
        } else {
          throw e;
        }
      }
      const next = transform(current);
      const mode = existed && rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
      try {
        return await uploadText(dpath, next, mode);
      } catch (e) {
        if (e instanceof DropboxError && e.status === 409) {
          lastErr = e; // 競合 → 再取得して再適用
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new DropboxError('更新に失敗（リトライ上限）: ' + dpath, 409, null);
  }

  return {
    isConnected,
    getTokens: () => tok,
    setTokens,
    ensureAccessToken,
    rpc,
    download,
    upload,
    uploadText,
    listFolder,
    updateTextFileWithRetry,
  };
}
