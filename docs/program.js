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

  // ---- 完了ボタン（1-2）: done-proposed のカードをユーザーが完了確定 → consumed + 完了確定行（v2.1） ----
  async function confirmDone(id) {
    const dir = await findCardDir(id);
    if (!dir) throw new Error('カードが見つかりません: ' + id);
    const mdPath = join(cardsRoot, dir, 'card.md');
    await dropbox.updateTextFileWithRetry(mdPath, (text) => {
      const card = P.parseCard(text);
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

  function sheetSourceById(id) { return sheetSources.find((s) => s.id === id) || null; }
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
    return { source: sourceId, file, ...P.sheetPayload(text, !!source.numbered) };
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
    await dropbox.updateTextFileWithRetry(p, (text) => P.insertSheetComment(text, blockIndex, line, !!source.numbered));
    return readSheet(sourceId, file);
  }

  // 承認（review_card があり state: reviewed のときのみ）。
  // (a) reviewカードへ OK＋consumed化（Phase1 の respondCard を再利用）。(b) シート state 行のみ approved へ。
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
    if (!reviewCard) throw new Error('review_card が設定されていません');
    if (state !== 'reviewed') throw new Error('承認できるのは state: reviewed のときのみです（現在: ' + state + '）');
    await respondCard(reviewCard, 'ok', {});                               // (a)
    await dropbox.updateTextFileWithRetry(p, (t) => P.setSheetState(t, 'approved')); // (b)
    return { ok: true, reviewCard, sheet: await readSheet(sourceId, file) };
  }

  return {
    root,
    cardsRoot,
    loadCards,
    listSheets,
    readSheet,
    addSheetComment,
    approveSheet,
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
