'use strict';

// program.js — ドメイン統治層（dropbox.js × parser.js を束ねる）
//
// UI（app.js / views）はこの層だけを呼ぶ。Dropbox の生 API・md の生パースは各層に隠蔽。
// 「正はファイル」「削除しない」「rev 競合はリトライ」の規律をここで実装する。

import * as P from './parser.js';

const MOBILE_MARK = '（📱）'; // モバイル発の追記に付す出所マーク（INBOX / 検収記録）

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function extLower(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}
function isImageName(name) {
  return IMG_EXT.has(extLower(name));
}
function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

// path の正規化（末尾スラッシュ除去）。
function join(...parts) {
  return parts
    .map((s, i) => (i === 0 ? String(s).replace(/\/+$/, '') : String(s).replace(/^\/+|\/+$/g, '')))
    .filter((s) => s !== '')
    .join('/');
}

export function createProgram(dropbox, config) {
  const root = config.programRoot.replace(/\/+$/, '');
  const cardsRoot = join(root, 'Cards');

  // ---- カード読み込み（増分キャッシュ対応で軽いポーリング） ----
  // cache: Map<cardMdPath, { rev, card }>
  async function loadCards(cache) {
    const nextCache = new Map();
    let entries;
    try {
      entries = await dropbox.listFolder(cardsRoot, { recursive: true });
    } catch (e) {
      // Cards フォルダ未作成なら空
      if (isNotFound(e)) return { cards: [], cache: nextCache, cardDirs: [] };
      throw e;
    }

    // フォルダ（C-NNN_slug）と、その中のファイルを集約する。
    const cardDirs = [];
    const filesByDir = new Map(); // dirName -> { mdRev, mdPath, images:[] }
    for (const ent of entries) {
      const rel = ent.path_display.slice(cardsRoot.length + 1); // Cards/ 以降
      const seg = rel.split('/');
      if (ent['.tag'] === 'folder' && seg.length === 1 && /^C-\d+/.test(seg[0])) {
        cardDirs.push(seg[0]);
        if (!filesByDir.has(seg[0])) filesByDir.set(seg[0], { images: [] });
        continue;
      }
      if (ent['.tag'] === 'file' && seg.length === 2 && /^C-\d+/.test(seg[0])) {
        const dir = seg[0];
        if (!filesByDir.has(dir)) filesByDir.set(dir, { images: [] });
        const rec = filesByDir.get(dir);
        if (seg[1] === 'card.md') {
          rec.mdRev = ent.rev;
          rec.mdPath = ent.path_display;
        } else if (isImageName(seg[1])) {
          rec.images.push(seg[1]);
        }
      }
    }

    const cards = [];
    for (const dir of cardDirs.sort()) {
      const rec = filesByDir.get(dir);
      if (!rec || !rec.mdPath) continue;
      const images = rec.images.slice().sort();
      const cached = cache && cache.get(rec.mdPath);
      let card;
      if (cached && cached.rev === rec.mdRev) {
        // rev 一致 → 再ダウンロードしない（通信量節約）。画像一覧のみ最新へ。
        card = { ...cached.card, dir, images };
      } else {
        const dl = await dropbox.download(rec.mdPath);
        card = P.readCardFromText(dl.text, dir, images);
      }
      nextCache.set(rec.mdPath, { rev: rec.mdRev, card });
      cards.push(card);
    }
    cards.sort((a, b) => P.compareCardId(a.id, b.id));
    return { cards, cache: nextCache, cardDirs };
  }

  // 単一カードの原寸画像を取得（バイト列）。詳細表示用。
  async function downloadImage(dir, file) {
    const p = join(cardsRoot, dir, file);
    const { bytes } = await dropbox.download(p, { binary: true });
    return bytes;
  }

  // ---- 新規カード作成 ----
  // input: { title, body, direction, type, images:[{name, bytes(Uint8Array)}] }
  async function createCard(input, currentCardDirs) {
    let dirs = currentCardDirs;
    if (!dirs) {
      const loaded = await loadCards();
      dirs = loaded.cardDirs;
    }
    const validTypes = ['reference', 'knowledge', 'consult', 'request', 'report', 'acceptance', 'decision', 'template'];
    const direction = input.direction === 'claude-to-user' ? 'claude-to-user' : 'user-to-claude';
    const type = validTypes.includes(input.type) ? input.type : 'reference';
    const title = (input.title || '').trim() || '（無題）';
    const subject = (input.subject || '').trim();
    const date = P.today();

    // ID 衝突（別端末との競合）に備え add モードで最大 3 回まで採番リトライ。
    let created = null;
    let names = dirs.slice();
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const id = P.nextCardId(names);
      const slug = P.slugify(input.title || id);
      const dirName = id + '_' + slug;
      const mdPath = join(cardsRoot, dirName, 'card.md');
      const md = P.buildNewCardMarkdown({ id, title, direction, type, subject, body: input.body, date });
      try {
        await dropbox.uploadText(mdPath, md, { '.tag': 'add' });
      } catch (e) {
        if (e && e.status === 409) { names.push(dirName); continue; } // 衝突 → 次の ID
        throw e;
      }
      // 画像アップロード（衝突時はファイル名に連番）。
      const usedNames = new Set();
      const images = Array.isArray(input.images) ? input.images : [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || !img.bytes || img.bytes.length === 0) continue;
        let ext = extLower(img.name || '');
        if (!IMG_EXT.has(ext)) ext = '.png';
        let base = P.safeFileName((img.name || '').replace(/\.[^.]*$/, ''), 'image' + (i + 1));
        let fname = base + ext;
        let n = 1;
        while (usedNames.has(fname)) { fname = base + '-' + n + ext; n++; }
        usedNames.add(fname);
        await dropbox.upload(join(cardsRoot, dirName, fname), img.bytes, { '.tag': 'add' });
      }
      created = { id, dirName };
    }
    if (!created) throw new Error('カード ID 採番に失敗しました（競合）');

    await regenerateIndex();
    return created;
  }

  // ---- 検収（OK / NG / あとで） ----
  async function acceptCard(id, action, comment) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const c = (comment || '').trim();
    if (action === 'ng' && c === '') throw new Error('NG にはコメントが必須です');

    let label, newStatus;
    if (action === 'ok') { label = 'OK'; newStatus = 'consumed'; }
    else if (action === 'ng') { label = 'NG'; newStatus = 'annotated'; }
    else if (action === 'later') { label = 'あとで'; newStatus = null; }
    else throw new Error('不明な検収操作: ' + action);

    const recLine = '- ↳ ' + P.today() + ' 検収=' + label + (c ? '（' + c + '）' : '') + MOBILE_MARK;
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      card.body = P.appendUnderHeading(card.body, '処理記録', recLine);
      if (newStatus) P.setField(card, 'status', newStatus);
      return P.serializeCard(card);
    });
    await regenerateIndex();
  }

  // ---- 状態変更・本文/記録追記（汎用・将来ビュー用） ----
  async function updateCard(id, { status, note, record }) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      if (status) P.setField(card, 'status', String(status));
      if (note) card.body = P.appendUnderHeading(card.body, '本文', String(note).replace(/[\r\n]+/g, ' '));
      if (record) {
        card.body = P.appendUnderHeading(card.body, '処理記録', '- ↳ ' + P.today() + ' ' + String(record).replace(/[\r\n]+/g, ' ') + MOBILE_MARK);
      }
      return P.serializeCard(card);
    });
    await regenerateIndex();
  }

  // ---- INBOX 追記（§1 のみ・rev 競合リトライ） ----
  async function appendInbox(textLine) {
    const clean = String(textLine || '').replace(/[\r\n]+/g, ' ').trim();
    if (clean === '') throw new Error('本文が空です');
    const entry = '- ' + P.today() + ' ' + clean + MOBILE_MARK;
    const inboxPath = join(root, 'INBOX.md');
    await dropbox.updateTextFileWithRetry(inboxPath, (text) => P.appendToInbox(text, entry), { createIfMissing: true });
    return entry;
  }

  // ---- 読み取り専用ビュー ----
  async function readText(relPath) {
    const p = join(root, relPath);
    try {
      const { text } = await dropbox.download(p);
      return text;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  function readDecisionQueue() { return readText('DECISION_QUEUE.md'); }
  function readControl() { return readText('CONTROL.md'); }

  // ---- 主題台帳（読み取り専用・サジェスト用）----
  // Cards/SUBJECTS.md の主題名一覧。ファイルが無ければ空配列（無くても動く）。
  async function readSubjects() {
    const text = await readText('Cards/SUBJECTS.md');
    return P.parseSubjects(text);
  }

  // ---- CARD_INDEX.md 再生成（ヘッダ保持・表のみ・rev 競合リトライ） ----
  async function regenerateIndex() {
    const { cards } = await loadCards();
    const indexPath = join(cardsRoot, 'CARD_INDEX.md');
    await dropbox.updateTextFileWithRetry(
      indexPath,
      (existing) => P.regenerateIndexContent(existing || '# CARD_INDEX — カード台帳\n', cards),
      { createIfMissing: true },
    );
  }

  async function findCardDir(id) {
    const { cards } = await loadCards();
    const hit = cards.find((c) => c.id === id);
    return hit ? hit.dir : null;
  }

  function imgPath(dir, file) {
    return join(cardsRoot, dir, file);
  }

  return {
    root,
    cardsRoot,
    loadCards,
    downloadImage,
    createCard,
    acceptCard,
    updateCard,
    appendInbox,
    readDecisionQueue,
    readControl,
    readSubjects,
    regenerateIndex,
    imgPath,
  };
}

function isNotFound(e) {
  return e && e.status === 409 && typeof e.is === 'function' && e.is('not_found');
}
