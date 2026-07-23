'use strict';

// program.js — ドメイン統治層（dropbox.js × parser.js を束ねる）
//
// UI（app.js / views）はこの層だけを呼ぶ。Dropbox の生 API・md の生パースは各層に隠蔽。
// 「正はファイル」「削除しない」「rev 競合はリトライ」の規律をここで実装する。

import * as P from './parser.js';
import { sheetArchplanRoot } from './config.js';

const MOBILE_MARK = '（📱）'; // モバイル発の追記に付す出所マーク（INBOX 等）
const RESP_MARK = '📱';      // 応答行/完了確定行に埋め込む出所マーク（v2.1）
const TRASH_DIR = '_trash'; // 削除カードの退避先（Cards/_trash/・物理削除しない=復元可能）
const ARCHIVE_DIR = '_archive'; // アーカイブ済みカード（Cards/_archive/・検索のみヒット・v2.1）
const MEMOS_DIR = 'Memos';  // メモ格納（Program/Memos/・1メモ=1ファイル・v1.8）
const MEMO_DONE = '_done';  // カード化済みメモの退避先（Memos/_done/）
const MEMO_TRASH = '_trash'; // 削除メモの退避先（Memos/_trash/・物理削除しない）

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
  const memosRoot = join(root, MEMOS_DIR);
  let memoCacheMap = new Map(); // path -> { rev, memo }（rev 一致なら再 download しない）

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
    // アーカイブ（_archive/C-xxxx_slug/…）は別集約。dir 名は "_archive/C-xxxx_slug"（検索のみヒット・v2.1）。
    const archivedDirs = [];
    const archivedFilesByDir = new Map();
    for (const ent of entries) {
      const rel = ent.path_display.slice(cardsRoot.length + 1); // Cards/ 以降
      const seg = rel.split('/');
      // _trash 配下は台帳・全タブ・Board・検索から一元除外（走査の入口・v1.7）。
      if (seg[0] === TRASH_DIR) continue;
      // _archive 配下は検索のみヒット（一覧/Board/tray/CARD_INDEX からは除外）・v2.1。
      if (seg[0] === ARCHIVE_DIR) {
        if (ent['.tag'] === 'folder' && seg.length === 2 && /^C-[UA]?\d+/.test(seg[1])) {
          const key = ARCHIVE_DIR + '/' + seg[1];
          if (!archivedFilesByDir.has(key)) { archivedFilesByDir.set(key, { images: [] }); archivedDirs.push(key); }
        } else if (ent['.tag'] === 'file' && seg.length === 3 && /^C-[UA]?\d+/.test(seg[1])) {
          const key = ARCHIVE_DIR + '/' + seg[1];
          if (!archivedFilesByDir.has(key)) { archivedFilesByDir.set(key, { images: [] }); archivedDirs.push(key); }
          const rec = archivedFilesByDir.get(key);
          if (seg[2] === 'card.md') { rec.mdRev = ent.rev; rec.mdPath = ent.path_display; }
          else if (isImageName(seg[2])) rec.images.push(seg[2]);
        }
        continue;
      }
      if (ent['.tag'] === 'folder' && seg.length === 1 && /^C-[UA]?\d+/.test(seg[0])) {
        cardDirs.push(seg[0]);
        if (!filesByDir.has(seg[0])) filesByDir.set(seg[0], { images: [] });
        continue;
      }
      if (ent['.tag'] === 'file' && seg.length === 2 && /^C-[UA]?\d+/.test(seg[0])) {
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

    const buildCards = async (dirs, byDir, archived) => {
      const out = [];
      for (const dir of dirs.slice().sort()) {
        const rec = byDir.get(dir);
        if (!rec || !rec.mdPath) continue;
        const images = rec.images.slice().sort();
        const cached = cache && cache.get(rec.mdPath);
        let card;
        if (cached && cached.rev === rec.mdRev) {
          card = { ...cached.card, dir, images };
        } else {
          const dl = await dropbox.download(rec.mdPath);
          card = P.readCardFromText(dl.text, dir, images);
        }
        if (archived) card.archived = true;
        nextCache.set(rec.mdPath, { rev: rec.mdRev, card });
        out.push(card);
      }
      return out;
    };

    const cards = (await buildCards(cardDirs, filesByDir, false))
      .concat(await buildCards(archivedDirs, archivedFilesByDir, true));
    cards.sort((a, b) => P.compareCardId(a.id, b.id));
    return { cards, cache: nextCache, cardDirs };
  }

  // 単一カードの原寸画像を取得（バイト列）。詳細表示用。
  async function downloadImage(dir, file) {
    const p = join(cardsRoot, dir, file);
    const { bytes } = await dropbox.download(p, { binary: true });
    return bytes;
  }

  // 実フォルダ名のみ軽量走査（採番直前再走査用・非recursive・SPEC_V3 §1-3a モバイル方針）。
  async function listCardDirNames() {
    let entries;
    try { entries = await dropbox.listFolder(cardsRoot, { recursive: false }); }
    catch (e) { if (isNotFound(e)) return []; throw e; }
    const out = [];
    for (const ent of entries) {
      if (ent['.tag'] !== 'folder') continue;
      const name = ent.path_display.slice(cardsRoot.length + 1);
      if (name === TRASH_DIR || name === ARCHIVE_DIR) continue;
      if (/^C-[UA]?\d+/.test(name)) out.push(name);
    }
    return out;
  }

  // ---- 新規カード作成 ----
  // input: { title, body, direction, type, images:[{name, bytes(Uint8Array)}] }
  async function createCard(input, currentCardDirs) {
    let dirs = currentCardDirs;
    if (!dirs) {
      const loaded = await loadCards();
      dirs = loaded.cardDirs;
    }
    const validTypes = ['reference', 'knowledge', 'consult', 'request', 'report', 'review', 'decision', 'template'];
    const direction = input.direction === 'claude-to-user' ? 'claude-to-user' : 'user-to-claude';
    const type = validTypes.includes(input.type) ? input.type : 'reference';
    const title = (input.title || '').trim() || '（無題）';
    const subject = (input.subject || '').trim();
    const date = P.today();

    // 採番の直前に実フォルダを再走査（別端末との競合をできるだけ避ける）。取得失敗時は手持ちで続行。
    let names = dirs.slice();
    try { const fresh = await listCardDirNames(); if (fresh && fresh.length) names = fresh; }
    catch { /* ネットワーク不調時は currentCardDirs で続行 */ }

    // ID 衝突（別端末との競合）に備え add モードで最大 3 回まで採番リトライ（衝突時は再走査分を加味）。
    let created = null;
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

  // ---- AI発カードへの応答（1-1・統括AIがparseする固定書式へ1行追記・v2.1） ----
  // kind: ok/ng/later/choice/comment。statusの機械更新はここだけ（アプリが行う唯一の状態変更）。
  async function respondCard(id, kind, opts) {
    const o = opts || {};
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const comment = String(o.comment == null ? '' : o.comment).replace(/[\r\n]+/g, ' ').trim();
    const choice = String(o.choice == null ? '' : o.choice).replace(/[\r\n]+/g, ' ').trim();
    if (kind === 'ng' && comment === '') throw new Error('NG には一言（コメント）が必須です');
    if (kind === 'comment' && comment === '') throw new Error('コメントが空です');
    if (kind === 'choice' && choice === '') throw new Error('選択肢が空です');

    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      const dt = P.nowStamp();
      const status = card.raw.status;
      const lines = [];
      let newStatus = null;
      if (kind === 'ok') {
        lines.push(P.buildResponseLine(dt, RESP_MARK, 'ok'));
        if (comment) lines.push(P.buildResponseLine(dt, RESP_MARK, 'comment', { comment }));
        if (status === 'review') newStatus = 'consumed'; // OKクリックが完了を兼ねる
      } else if (kind === 'ng') {
        lines.push(P.buildResponseLine(dt, RESP_MARK, 'ng', { comment })); // status は review のまま
      } else if (kind === 'later') {
        lines.push(P.buildResponseLine(dt, RESP_MARK, 'later')); // status は review のまま
      } else if (kind === 'choice') {
        lines.push(P.buildResponseLine(dt, RESP_MARK, 'choice', { choice, comment }));
        newStatus = 'responded'; // decision の選択＝応答済み（統括の伝播待ち）
      } else if (kind === 'comment') {
        lines.push(P.buildResponseLine(dt, RESP_MARK, 'comment', { comment })); // status 変更なし
      } else {
        throw new Error('不明なrespond kind: ' + kind);
      }
      for (const l of lines) card.body = P.appendUnderHeading(card.body, '処理記録', l);
      if (newStatus) P.setField(card, 'status', newStatus);
      return P.serializeCard(card);
    });
    await regenerateIndex();
  }

  // ---- 完了ボタン（1-2）: done-proposed／carried のカードをユーザーが完了確定 → consumed + 完了確定行 ----
  // carried は CARRYOVER に内容保全済み＝閉じてよい状態（2026-07-17・S-0006吸収）。
  // データ層の検証: 対象は done-proposed か carried のみ（他 status は完了ボタン非表示のため到達しない）。
  async function confirmDone(id) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      const st = card.raw && card.raw.status;
      if (st !== 'done-proposed' && st !== 'carried') {
        throw new Error('完了確定できるのは 完了提案(done-proposed) か 申し送り(carried) のカードのみです（現在: ' + (st || '—') + '）');
      }
      card.body = P.appendUnderHeading(card.body, '処理記録', P.buildDoneConfirmLine(P.nowStamp(), RESP_MARK));
      P.setField(card, 'status', 'consumed');
      return P.serializeCard(card);
    });
    await regenerateIndex();
  }

  // ---- target 欄の後付け編集（1-3・ユーザー発/AI発どちらでも・v2.1） ----
  async function setTarget(id, target) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const arr = P.parseTargetInput(target);
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      P.setTargetField(card, arr);
      return P.serializeCard(card);
    });
    await regenerateIndex(); // target は CARD_INDEX には出ないが、他端末との整合のため再生成
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

  // Cards 配下に収まっているか（.. を含まない・cardsRoot 直下配下）検査（移動先ガード用・v1.7）。
  function assertUnderCards(p) {
    if (p.split('/').some((s) => s === '..')) throw new Error('不正なパス（.. を含む）: ' + p);
    if (p !== cardsRoot && !p.startsWith(cardsRoot + '/')) throw new Error('Cards 範囲外のパス: ' + p);
  }

  // ---- カード削除（Cards/_trash/ へ移動・物理削除しない=復元可能・v1.7） ----
  async function deleteCard(id) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const from = join(cardsRoot, dir);
    const to = join(cardsRoot, TRASH_DIR, dir);
    assertUnderCards(from); // 移動元・移動先とも Cards 内に限定（パスガード）
    assertUnderCards(to);
    await dropbox.move(from, to); // move のみ（削除 API は使わない）
    await regenerateIndex();      // _trash は走査除外のため台帳から自然に消える
    return { movedTo: to };
  }

  // ---- コメント追記（処理記録へ・即動作・rev 競合リトライ・v1.7） ----
  async function addComment(id, text) {
    const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (clean === '') throw new Error('コメントが空です');
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const line = P.buildCommentLine(P.today(), clean, '📱');
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (t) => {
      const card = P.parseCard(t);
      card.body = P.appendUnderHeading(card.body, '処理記録', line);
      return P.serializeCard(card);
    });
    // 処理記録は CARD_INDEX の列に影響しないため index 再生成は不要。
  }

  // ---- タイトル・本文の編集（ユーザー発・rev 競合リトライ・v1.8） ----
  // frontmatter title と「## 本文」節のみ書き換え（注釈・処理記録の既存分・他フィールドは byte 不変）。
  // フォルダ名（slug）はリネームしない（ID が同一性の正）。CARD_INDEX は新タイトルで再生成。
  async function editCard(id, { title, body } = {}) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const newTitle = String(title == null ? '' : title).replace(/[\r\n]+/g, ' ').trim();
    const newBody = body == null ? '' : String(body);
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
      if (newTitle) P.setField(card, 'title', newTitle);
      card.body = P.replaceUnderHeading(card.body, '本文', newBody);
      card.body = P.appendUnderHeading(card.body, '処理記録', P.buildEditLine(P.today(), '📱'));
      return P.serializeCard(card);
    });
    await regenerateIndex(); // タイトルは CARD_INDEX の名称列に影響するため再生成
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

  // ---- Memo（Program/Memos/・1メモ=1ファイル・プレーンテキストのみ・画像なし）（v1.8） ----
  function memoNameGuard(name) {
    if (typeof name !== 'string' || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 ||
        name.includes('..') || !/^M-.+\.md$/.test(name)) {
      throw new Error('不正なメモ名: ' + name);
    }
    return name;
  }
  function assertUnderMemos(p) {
    if (p.split('/').some((s) => s === '..')) throw new Error('不正なパス（.. を含む）: ' + p);
    if (p !== memosRoot && !p.startsWith(memosRoot + '/')) throw new Error('Memos 範囲外のパス: ' + p);
  }

  // Memos/ 直下のメモを新しい順で返す（_done/_trash はフォルダのため file 走査から自然に除外）。
  async function loadMemos() {
    const next = new Map();
    let entries;
    try {
      entries = await dropbox.listFolder(memosRoot, { recursive: false });
    } catch (e) {
      if (isNotFound(e)) { memoCacheMap = next; return []; } // 未作成なら空
      throw e;
    }
    const files = entries.filter((e) => e['.tag'] === 'file' && /^M-.+\.md$/.test(basename(e.path_display)));
    const memos = [];
    for (const ent of files) {
      const name = basename(ent.path_display);
      const cached = memoCacheMap.get(ent.path_display);
      let memo;
      if (cached && cached.rev === ent.rev) {
        memo = cached.memo; // rev 一致 → 再 download しない
      } else {
        const { text } = await dropbox.download(ent.path_display);
        memo = { name, id: name.replace(/\.md$/, ''), text, firstLine: P.firstLine(text) };
      }
      next.set(ent.path_display, { rev: ent.rev, memo });
      memos.push(memo);
    }
    memoCacheMap = next;
    memos.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // 名前=時刻順の降順＝新しい順
    return memos;
  }

  // 新規メモ作成（add モード・同一秒衝突は連番退避で採番リトライ）。
  async function createMemo(text) {
    const clean = String(text == null ? '' : text);
    if (clean.trim() === '') throw new Error('メモが空です');
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const base = P.memoFileName().replace(/\.md$/, '');
      const name = (attempt === 0 ? base : base + '-' + (attempt + 1)) + '.md';
      const p = join(memosRoot, name);
      try {
        await dropbox.uploadText(p, clean, { '.tag': 'add' });
        created = { name, id: name.replace(/\.md$/, ''), text: clean, firstLine: P.firstLine(clean) };
      } catch (e) {
        if (e && e.status === 409) continue; // 衝突 → 次の名前
        throw e;
      }
    }
    if (!created) throw new Error('メモ作成に失敗しました（競合）');
    return created;
  }

  // メモ内容の更新（丸ごと上書き・rev 競合リトライ）。
  async function updateMemo(name, text) {
    memoNameGuard(name);
    const clean = String(text == null ? '' : text);
    const p = join(memosRoot, name);
    await dropbox.updateTextFileWithRetry(p, () => clean);
  }

  // メモを _done/ または _trash/ へフォルダ移動（削除 API は使わない・移動のみ・物理削除しない）。
  async function moveMemoTo(name, dest) {
    memoNameGuard(name);
    const from = join(memosRoot, name);
    const to = join(memosRoot, dest, name);
    assertUnderMemos(from);
    assertUnderMemos(to);
    await dropbox.move(from, to); // 衝突時は Dropbox 側で退避名（autorename）
  }
  function doneMemo(name) { return moveMemoTo(name, MEMO_DONE); }
  function trashMemo(name) { return moveMemoTo(name, MEMO_TRASH); }

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
    const listed = cards.filter((c) => !c.archived); // アーカイブは台帳に載せない（検索のみ・v2.1）
    const indexPath = join(cardsRoot, 'CARD_INDEX.md');
    await dropbox.updateTextFileWithRetry(
      indexPath,
      (existing) => P.regenerateIndexContent(existing || '# CARD_INDEX — カード台帳\n', listed),
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

  // ---- Sheets（v2.2・シナリオ/完成定義/RDS の項目レンダリング＋💬コメント＋承認） ----
  // ベースルート = programRoot の親（'/ArchPlan/Program' → '/ArchPlan'）＋ソース別サブパス。
  const archplanRoot = sheetArchplanRoot(root);
  const sheetSources = config.sheetSources || [];
  // 便3: D-2/D-4（behaviors/testreport）も開ける／💬／トグルできるよう全ソースで解決（board一覧と同じ拡張ソース）。
  const allSheetSources = sheetSources.concat(config.sheetBoardSources || []);

  function sheetSourceById(id) { return allSheetSources.find((s) => s.id === id) || null; }
  function sheetBase(source) { return join(archplanRoot, source.sub); }
  function sheetFileAllowed(source, name) {
    const ok = source.match ? new RegExp(source.match).test(name) : true;
    const ng = source.exclude ? new RegExp(source.exclude).test(name) : false;
    return ok && !ng;
  }
  // ソース内相対パス file のガード（.. や空要素を拒否・match/exclude 再検証＝任意パス拒否）。
  function sheetAssertFile(source, file) {
    const f = String(file || '');
    if (f === '' || f.split('/').some((s) => s === '..' || s === '')) throw new Error('不正なファイルパス: ' + file);
    if (!sheetFileAllowed(source, basename(f))) throw new Error('対象外のファイル: ' + file);
  }

  // 全ソースの一覧（一覧はファイル名のみ＝本文は開いた時に取得・通信量配慮）。未存在ディレクトリは空一覧で無事故。
  async function listSheets() {
    const out = [];
    for (const source of sheetSources) {
      const base = sheetBase(source);
      let entries = [];
      try {
        entries = await dropbox.listFolder(base, { recursive: !!source.recurse });
      } catch (e) {
        if (!isNotFound(e)) throw e; // 未存在なら空一覧
        entries = [];
      }
      const files = [];
      for (const ent of entries) {
        if (ent['.tag'] !== 'file') continue;
        const rel = ent.path_display.slice(base.length + 1);
        if (!sheetFileAllowed(source, basename(rel))) continue;
        files.push(rel);
      }
      files.sort();
      out.push({ id: source.id, label: source.label, files: files.map((f) => ({ file: f })) });
    }
    return out;
  }

  // 開いたシートを取得（本文DL→frontmatterメタ＋序文＋項目ブロック）。
  async function readSheet(sourceId, file) {
    const source = sheetSourceById(sourceId);
    if (!source) throw new Error('不明なソース: ' + sourceId);
    sheetAssertFile(source, file);
    const { text } = await dropbox.download(join(sheetBase(source), file));
    const payload = { source: sourceId, file, ...P.sheetPayload(text, !!source.numbered) };
    // 便3（§3）: D-2/D-3/D-4 の中核データを添付（背骨=汎用ブロックはそのまま・中核のみ差し替え）。
    if (sourceId === 'behaviors') payload.behaviors = P.parseBehaviorDoc(text).behaviors;
    if (sourceId === 'completion') payload.testPlan = P.parseTestPlan(text);
    if (sourceId === 'testreport') payload.report = P.parseTestReport(text);
    return payload;
  }

  // 項目直下へ💬コメント追記（updateTextFileWithRetry＝rev 楽観ロック・他部分は byte 不変）。
  async function addSheetComment(sourceId, file, blockIndex, comment) {
    const source = sheetSourceById(sourceId);
    if (!source) throw new Error('不明なソース: ' + sourceId);
    sheetAssertFile(source, file);
    const clean = String(comment == null ? '' : comment).replace(/[\r\n]+/g, ' ').trim();
    if (clean === '') throw new Error('コメントが空です');
    const line = P.buildSheetCommentLine(P.nowStamp(), '📱', clean);
    const p = join(sheetBase(source), file);
    // §2-4 C: approved のシートに書き込むと本文が変わる → 同じ書き込みで state を reviewed へ戻す。
    await dropbox.updateTextFileWithRetry(p, (text) =>
      P.revertApprovedToReviewed(P.insertSheetComment(text, blockIndex, line, !!source.numbered)));
    return readSheet(sourceId, file);
  }

  // 項目チェックボックスのトグル書き戻し（§2-4 A）。該当行の 1 字のみ置換（他は byte 不変・rev 楽観ロック）。
  // approved のシートは同じ書き込みで state を reviewed へ戻す（C）。行不一致は transform が throw（再読込を促す）。
  async function toggleSheetCheckbox(sourceId, file, lineIndex, expectedLine) {
    const source = sheetSourceById(sourceId);
    if (!source) throw new Error('不明なソース: ' + sourceId);
    sheetAssertFile(source, file);
    const p = join(sheetBase(source), file);
    await dropbox.updateTextFileWithRetry(p, (text) =>
      P.revertApprovedToReviewed(P.toggleCheckboxLine(text, lineIndex, expectedLine)));
    return readSheet(sourceId, file);
  }

  // 承認（state: reviewed かつ 全チェック済のとき。review_card は任意化・2026-07-17）。
  // (a) review_card があれば reviewカードへ OK＋consumed化（Phase1 の respondCard を再利用）。無ければスキップ。(b) シート state 行のみ approved へ。
  async function approveSheet(sourceId, file) {
    const source = sheetSourceById(sourceId);
    if (!source) throw new Error('不明なソース: ' + sourceId);
    sheetAssertFile(source, file);
    const p = join(sheetBase(source), file);
    const { text } = await dropbox.download(p);
    const meta = P.parseSheetMeta(text);
    if (!meta.hasFrontmatter || meta.state == null) throw new Error('このシートは承認対象外です（frontmatterなし）');
    const state = String(meta.state).trim();
    const reviewCard = meta.reviewCard ? String(meta.reviewCard).trim() : '';
    if (state !== 'reviewed') throw new Error('承認できるのは state: reviewed のときのみです（現在: ' + state + '）');
    // §2-4 B: 全チェックボックスが [x] であること（UI だけに頼らずデータ層でも二重検証）。チェック0個は従来どおり承認可。
    const cs = P.countSheetCheckboxes(text);
    if (cs.unchecked > 0) throw new Error('未チェックの項目が ' + cs.unchecked + ' 件あります（全て [x] で承認できます）');
    if (reviewCard) await respondCard(reviewCard, 'ok', {});                // (a) 任意化＝無ければスキップ
    await dropbox.updateTextFileWithRetry(p, (t) => P.setSheetState(t, 'approved')); // (b)
    return { ok: true, reviewCard, sheet: await readSheet(sourceId, file) };
  }

  // ---- Views（進捗＋ライブラリ・v2.3・3-1〜3-4） ----
  // ベースルート＝Sheets と同じ archplanRoot（programRoot の親）。読み取り専用。
  const progressSources = config.progressSources || {};
  const librarySources = config.librarySources || [];

  // archplanRoot 相対の sub を読む（未存在は null で無事故）。
  async function readViewText(sub) {
    if (!sub) return null;
    try {
      const { text } = await dropbox.download(join(archplanRoot, sub));
      return text;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  // 進捗ペイロード（全源結合・work unit 一望・v2.9・3-2改定・開いた時のみ取得＝通信量配慮）。
  async function loadProgress() {
    const [censusText, comText, axisText, ledgerText, lanesText, testText, coText] = await Promise.all([
      readViewText(progressSources.census && progressSources.census.sub),
      readViewText(progressSources.comTargets && progressSources.comTargets.sub),
      readViewText(progressSources.progressAxis && progressSources.progressAxis.sub),
      readViewText(progressSources.taskLedger && progressSources.taskLedger.sub),
      readViewText(progressSources.lanes && progressSources.lanes.sub),
      readViewText(progressSources.testStatus && progressSources.testStatus.sub),
      readViewText(progressSources.carryover && progressSources.carryover.sub),
    ]);
    return P.buildProgressPayload({ censusText, comText, axisText, ledgerText, lanesText, testText, coText });
  }

  // 進捗タブ（便5・build 34）: IMPL_REGISTRY → 参照 SC-F のみ読む（需要駆動）＋完成定義照合。読み取り専用。
  const progressBoardCfg = config.progressBoard || {};
  async function loadProgressBoard() {
    const registryText = await readViewText(progressBoardCfg.registrySub);
    const reg = P.parseImplRegistry(registryText);
    // requestedBy から参照 SC-F コードを集める（需要駆動）。
    const codes = new Set();
    for (const u of reg.units) for (const r of P.unitScenarioRefs(u)) if (r.scenario) codes.add(r.scenario);
    const codeArr = [...codes];
    const scenTexts = await Promise.all(codeArr.map((code) => readViewText((progressBoardCfg.scenarioDir || '') + '/' + (progressBoardCfg.scenarioPrefix || 'SC-F_') + code + '.md')));
    const scenarios = codeArr.map((code, i) => ({ code, text: scenTexts[i] }));
    // 完成定義（D-3）承認: ファイル存在＋全チェック[x]（実データは総数0＝approved:false・正直）。
    const completionByFeature = {};
    const complEntries = Object.entries(progressBoardCfg.completionMap || {});
    for (const [code, files] of complEntries) {
      const texts = await Promise.all(files.map((rel) => readViewText((progressBoardCfg.completionBase || '') + '/' + rel)));
      let present = false, total = 0, checked = 0, file = null;
      texts.forEach((t, i) => { if (t != null) { present = true; if (!file) file = files[i]; const cs = P.countSheetCheckboxes(t); total += cs.total; checked += cs.checked; } });
      completionByFeature[code] = { present, total, checked, approved: present && total > 0 && checked === total, file };
    }
    const testText = await readViewText((config.progressSources && config.progressSources.testStatus && config.progressSources.testStatus.sub) || null);
    const testStatusMap = P.parseTestStatus(testText) || {};
    const board = P.buildProgressBoard({ registryText, scenarios, completionByFeature, testStatusMap });
    return {
      ...board,
      sources: {
        registry: registryText != null,
        registryOk: reg.ok,
        scenarios: scenarios.filter((s) => s.text != null).length,
        scenariosReferenced: scenarios.length,
        testStatus: registryText != null && Object.keys(testStatusMap || {}).length > 0,
      },
      completionByFeature,
    };
  }

  function librarySourceById(id) { return librarySources.find((s) => s.id === id) || null; }

  // ライブラリ軸一覧（get_metadata で存在確認＝大きいファイルは落とさない・v2.3）。
  async function listLibrary() {
    const out = [];
    for (const s of librarySources) {
      let available = false;
      if (s.sub) {
        try { await dropbox.getMetadata(join(archplanRoot, s.sub)); available = true; }
        catch (e) { if (!isNotFound(e)) throw e; available = false; }
      }
      out.push({ id: s.id, label: s.label, type: s.type, available });
    }
    return out;
  }

  // ライブラリ項目（開いた時のみ取得）。md=見出しブロック＋raw／json=raw+整形。未存在→available:false。
  async function readLibraryItem(id) {
    const src = librarySourceById(id);
    if (!src) throw new Error('不明な軸: ' + id);
    const text = src.sub ? await readViewText(src.sub) : null;
    if (text == null) return { id: src.id, label: src.label, type: src.type, available: false };
    if (src.type === 'json') {
      let pretty = text, parsedOk = false;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); parsedOk = true; } catch { /* 生 */ }
      return { id: src.id, label: src.label, type: 'json', available: true, text, pretty, parsedOk };
    }
    return { id: src.id, label: src.label, type: 'md', available: true, text, blocks: P.libraryMdBlocks(text) };
  }

  // View行コメント → consultカード自動生成（3-4・正本には一切書き込まない＝Cards生成のみ）。
  async function createViewCommentCard({ itemId, itemLabel, comment, quote } = {}) {
    const c = String(comment == null ? '' : comment).trim();
    if (c === '') throw new Error('コメントが空です');
    const id = String(itemId == null ? '' : itemId).trim();
    const label = String(itemLabel == null ? '' : itemLabel).trim();
    const q = String(quote == null ? '' : quote).trim();
    const title = 'コメント: ' + (label || id || '（View項目）');
    const body = q ? c + '\n\n> ' + q.replace(/\r?\n/g, '\n> ') : c;
    const created = await createCard({ title, body, direction: 'user-to-claude', type: 'consult' });
    if (id) await setTarget(created.id, id); // target=当該項目ID（採番後に付与・CARD_INDEX再生成込み）
    return created;
  }

  // ---- Sessions（起動チケット・v2.4・Phase4） ----
  // Program/Sessions/S-*/briefing.md を一覧・詳細表示（読み取り専用）。▶起動はモバイル非対応。
  const sessionsRoot = join(root, config.sessionsSub || 'Sessions');

  // S-*/briefing.md の dir→path マップ（未存在は空）。
  async function sessionBriefingMap() {
    let entries = [];
    try { entries = await dropbox.listFolder(sessionsRoot, { recursive: true }); }
    catch (e) { if (!isNotFound(e)) throw e; return new Map(); }
    const map = new Map();
    for (const ent of entries) {
      if (ent['.tag'] !== 'file') continue;
      const rel = ent.path_display.slice(sessionsRoot.length + 1);
      const seg = rel.split('/');
      if (seg.length === 2 && seg[1] === 'briefing.md' && /^S-\d+/.test(seg[0])) map.set(seg[0], ent.path_display);
    }
    return map;
  }

  // 一覧（各 briefing を DL してメタ抽出＝件数少・通信量許容）。dir 昇順。
  async function listSessions() {
    const map = await sessionBriefingMap();
    const dirs = [...map.keys()].sort();
    const out = [];
    for (const dir of dirs) {
      const { text } = await dropbox.download(map.get(dir));
      out.push(P.ticketMeta(dir, text));
    }
    return out;
  }

  // 詳細（本文つき）。id はフォルダ名 prefix か frontmatter/見出しの S-番号で照合。
  async function readSession(id) {
    const map = await sessionBriefingMap();
    const wanted = String(id || '').trim();
    let dir = null;
    for (const d of map.keys()) {
      if (d === wanted || d.startsWith(wanted + '_') || P.ticketIdFromString(d) === wanted) { dir = d; break; }
    }
    if (!dir) {
      for (const d of map.keys()) {
        const { text } = await dropbox.download(map.get(d));
        if (P.ticketMeta(d, text).id === wanted) { dir = d; break; }
      }
    }
    if (!dir) throw new Error('チケットが見つかりません: ' + id);
    const { text } = await dropbox.download(map.get(dir));
    return { ...P.ticketMeta(dir, text), body: P.parseTicket(text).body };
  }

  // ---- Sheetボード（便1 / build 30・§1-2）: 3画面タグ＋共通列（要旨/stale・関連単位・解除インパクト概算） ----
  // board 用の全ソース（既存3＋D-2/D-4）。既存 sheetSources は不変更。
  const allBoardSources = sheetSources.concat(config.sheetBoardSources || []);
  function boardSourceById(id) { return allBoardSources.find((s) => s.id === id) || null; }

  // summaries.json（AI補助キャッシュ・器のみ・§1-1b）。未存在→{}（無事故）。
  async function loadSummaries() {
    if (!config.summariesSub) return {};
    try { const { text } = await dropbox.download(join(archplanRoot, config.summariesSub)); return JSON.parse(text) || {}; }
    catch { return {}; }
  }

  // 開封/読了の共有ストア（便6・§5b-1）: PC⇄モバイル同期。Program/data/view_state.json。未存在→{}（無事故）。
  async function loadViewState() {
    if (!config.viewStateSub) return {};
    try { const { text } = await dropbox.download(join(archplanRoot, config.viewStateSub)); return JSON.parse(text) || {}; }
    catch { return {}; }
  }
  // 1文書ぶんの記録を最終更新優先でマージして書く（未存在なら作成・競合はリトライで再マージ）。
  //   ユーザーアクション由来（開封・読了）のみ。正本文書には書かない。
  async function saveViewStateRecord(key, rec) {
    if (!config.viewStateSub || !key || !rec) return null;
    const dpath = join(archplanRoot, config.viewStateSub);
    return dropbox.updateTextFileWithRetry(dpath, (current) => {
      let store = {};
      try { store = JSON.parse(current) || {}; } catch { store = {}; }
      return JSON.stringify(P.mergeViewStateRecord(store, key, rec), null, 2) + '\n';
    }, { createIfMissing: true });
  }

  // 1ソースのファイル一覧＋更新時刻（server_modified）。未存在は空一覧で無事故。
  async function listFilesForSource(source) {
    const base = sheetBase(source);
    let entries = [];
    try { entries = await dropbox.listFolder(base, { recursive: !!source.recurse }); }
    catch (e) { if (!isNotFound(e)) throw e; entries = []; }
    const files = [];
    for (const ent of entries) {
      if (ent['.tag'] !== 'file') continue;
      const rel = ent.path_display.slice(base.length + 1);
      if (!sheetFileAllowed(source, basename(rel))) continue;
      files.push({ file: rel, mtimeMs: ent.server_modified ? Date.parse(ent.server_modified) : 0 });
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    return files;
  }

  // 3画面タグの enriched ボード。Sheetsタブ表示時に取得（本文DLを伴う＝ユーザー操作契機）。空ソースでも壊れない。
  async function loadSheetBoard() {
    const summaries = await loadSummaries();
    let reverseClosureMap = {};
    try { const prog = await loadProgress(); reverseClosureMap = (prog && prog.reverseClosure) || {}; } catch { reverseClosureMap = {}; }
    const now = Date.now();
    const tags = [];
    for (const tag of (config.sheetTags || [])) {
      const subcategories = [];
      for (const sc of (tag.subcategories || [])) {
        // 設計基盤 B-1〜B-6（§4・便4）: source 無し＝枠のみ（pending＝準備中表示）。ファイルDLは行わない。
        const src = sc.source ? boardSourceById(sc.source) : null;
        const entries = [];
        if (src) {
          const files = await listFilesForSource(src);
          for (const f of files) {
            let text = '';
            try { const dl = await dropbox.download(join(sheetBase(src), f.file)); text = dl.text; } catch { text = ''; }
            entries.push(P.enrichSheetEntryFromText(text,
              { source: src.id, file: f.file, sub: src.sub, subcatKind: sc.kind, flow: sc.flow, numbered: src.numbered, mtimeMs: f.mtimeMs },
              summaries, reverseClosureMap, now));
          }
        }
        subcategories.push({ id: sc.id, label: sc.label, flow: sc.flow || null, kind: sc.kind || null, source: sc.source || null, pending: !!sc.pending, entries });
      }
      tags.push({ id: tag.id, label: tag.label, pending: !!tag.pending, subcategories });
    }
    return { tags, impactApprox: true };
  }

  // ---- RDSナビ（§4・便4）: 未対応💬の一覧＋機械count（該当箇所ジャンプ用）。原典は読み取りのみ。 ----
  async function loadRdsComments(file) {
    const source = sheetSourceById('rds');
    if (!source) throw new Error('RDSソースがありません');
    sheetAssertFile(source, file);
    const { text } = await dropbox.download(join(sheetBase(source), file));
    return Object.assign({ file }, P.parseRdsComments(text));
  }

  // ---- Library原典（Sheetの原典層・§4・便4）: 初期スコープ=Sheet原典のみ（対応表11行）。 ----
  // 状態＝「変更から一定期間の新着アイコンのみ」（承認ライフサイクルなし・mtime基準の一般文書扱い）。
  const libraryNewBadgeDays = config.libraryNewBadgeDays != null ? config.libraryNewBadgeDays : 7;
  const libraryOriginTags = config.libraryOriginTags || [];

  function originEntryState(mtimeMs, now) {
    const updatedDaysAgo = mtimeMs ? Math.max(0, Math.floor((now - mtimeMs) / 86400000)) : null;
    let updated = '';
    if (mtimeMs) { const d = new Date(mtimeMs); const p = (n) => String(n).padStart(2, '0'); updated = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    const state = P.deriveDocState({ kind: 'general', updatedDaysAgo }, null, { newBadgeDays: libraryNewBadgeDays });
    return { updatedDaysAgo, updated, state: state || null };
  }

  // 原典1件の解決（dir=配下の該当ファイル列挙／file=存在確認／unknown=原典未特定）。未存在は available:false（正直表示）。
  async function resolveOrigin(origin, now) {
    const o = origin || {};
    if (o.kind === 'unknown' || !o.sub) return { label: o.label, kind: o.kind || 'unknown', available: false, reason: '未整備（原典未特定）', entries: [] };
    const base = join(archplanRoot, o.sub);
    if (o.kind === 'file') {
      let mtimeMs = 0;
      try { const md = await dropbox.getMetadata(base); mtimeMs = md.server_modified ? Date.parse(md.server_modified) : 0; }
      catch (e) { if (!isNotFound(e)) throw e; return { label: o.label, kind: 'file', sub: o.sub, available: false, reason: '未整備（原典未特定）', entries: [] }; }
      return { label: o.label, kind: 'file', sub: o.sub, available: true, entries: [Object.assign({ file: o.sub, name: basename(o.sub), dir: o.sub.replace(/\/[^/]*$/, '') }, originEntryState(mtimeMs, now))] };
    }
    // dir
    const matchRe = o.match ? new RegExp(o.match) : null;
    const excludeRe = o.exclude ? new RegExp(o.exclude) : null;
    let list = [];
    try { list = await dropbox.listFolder(base, { recursive: true }); }
    catch (e) { if (!isNotFound(e)) throw e; return { label: o.label, kind: 'dir', sub: o.sub, available: false, reason: '未整備（原典未特定）', entries: [] }; }
    const entries = [];
    for (const ent of list) {
      if (ent['.tag'] !== 'file') continue;
      const rel = ent.path_display.slice(base.length + 1);
      const name = basename(rel);
      if (matchRe && !matchRe.test(name)) continue;
      if (excludeRe && excludeRe.test(name)) continue;
      if (/^_/.test(name)) continue;
      const mtimeMs = ent.server_modified ? Date.parse(ent.server_modified) : 0;
      entries.push(Object.assign({ file: o.sub + '/' + rel, name, dir: (o.sub + '/' + rel).replace(/\/[^/]*$/, '') }, originEntryState(mtimeMs, now)));
    }
    entries.sort((a, b) => a.file.localeCompare(b.file));
    if (!entries.length) return { label: o.label, kind: 'dir', sub: o.sub, available: false, reason: '未整備（原典未特定）', entries: [] };
    return { label: o.label, kind: 'dir', sub: o.sub, available: true, entries };
  }

  // Library原典ボード（3画面タグ×サブカテゴリ×原典）。Library原典タブ表示時に取得。
  async function loadLibraryOrigins() {
    const now = Date.now();
    const tags = [];
    for (const tag of libraryOriginTags) {
      const subcategories = [];
      for (const sc of (tag.subcategories || [])) {
        const origins = [];
        for (const o of (sc.origins || [])) origins.push(await resolveOrigin(o, now));
        subcategories.push({ id: sc.id, label: sc.label, origins });
      }
      tags.push({ id: tag.id, label: tag.label, subcategories });
    }
    return { tags, newBadgeDays: libraryNewBadgeDays, originsOnly: true };
  }

  // 設定済み原典（file/dir）のホワイトリスト判定（任意パス読取り拒否）。
  function originAllows(relPath) {
    const rel = String(relPath || '').replace(/^\/+/, '');
    if (rel === '' || rel.split('/').some((s) => s === '..' || s === '')) return false;
    for (const tag of libraryOriginTags) {
      for (const sc of (tag.subcategories || [])) {
        for (const o of (sc.origins || [])) {
          if (!o.sub) continue;
          if (o.kind === 'file') { if (rel === o.sub) return true; }
          else if (o.kind === 'dir') { if (rel.startsWith(o.sub + '/') && (!o.match || new RegExp(o.match).test(basename(rel)))) return true; }
        }
      }
    }
    return false;
  }

  // 原典1件の読み取り（ホワイトリスト内のみ・md=見出しブロック＋raw／json=raw+整形）。読み取り表示のみ・書き込みなし。
  async function readOriginFile(sub) {
    if (!originAllows(sub)) throw new Error('対象外の原典パスです: ' + sub);
    const { text } = await dropbox.download(join(archplanRoot, sub));
    if (/\.json$/i.test(sub)) {
      let pretty = text, parsedOk = false;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); parsedOk = true; } catch { /* 生 */ }
      return { file: sub, name: basename(sub), type: 'json', text, pretty, parsedOk };
    }
    return { file: sub, name: basename(sub), type: 'md', text, blocks: P.libraryMdBlocks(text) };
  }

  return {
    root,
    cardsRoot,
    loadCards,
    loadSheetBoard,
    loadSummaries,
    loadViewState,
    saveViewStateRecord,
    listSessions,
    readSession,
    listSheets,
    readSheet,
    addSheetComment,
    approveSheet,
    toggleSheetCheckbox,
    loadProgress,
    loadProgressBoard,
    listLibrary,
    readLibraryItem,
    // 便4（§4）: RDSナビ・Library原典
    loadRdsComments,
    loadLibraryOrigins,
    readOriginFile,
    createViewCommentCard,
    downloadImage,
    createCard,
    respondCard,
    confirmDone,
    setTarget,
    updateCard,
    deleteCard,
    addComment,
    editCard,
    appendInbox,
    loadMemos,
    createMemo,
    updateMemo,
    doneMemo,
    trashMemo,
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
