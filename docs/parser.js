'use strict';

// parser.js — Markdown/frontmatter の純粋パーサ層（DOM・fetch・Dropbox に非依存）
//
// Mac 版 server.js のロジックと挙動互換（往復無損失・同じ ID 採番・同じ INBOX 追記・
// 同じ CARD_INDEX 再生成）。ブラウザからも Node（node --test）からも同一 ESM として利用。
// 将来 STAGE_PLAN.md / CONTROL.md の `- [ ]` 進捗を解析する進捗ビューも同じ部品で書ける。

// ---------------------------------------------------------------------------
// 表示ラベル（純粋データ・UI/索引で共用）
// ---------------------------------------------------------------------------

export const STATUS_ORDER = ['new', 'annotated', 'waiting', 'carried', 'kept', 'awaiting-impl', 'review', 'responded', 'done-proposed', 'consumed'];

// 状態(status)は表示のみ日本語化（v1.6・語彙は 2026-07-17 整理版＝正=カード凡例 C-U0000）。
// ファイル内部の値は英語のまま（frontmatter は不変）。
// UI のタイル/詳細 chip は type 考慮の statusLabel()、CARD_INDEX の状態列は素の STATUS_LABEL を使う。
export const STATUS_LABEL = {
  new: '新規',
  annotated: '確認済み',    // 旧「注釈済み」
  waiting: '保留',          // 旧「浮上待ち」
  review: '対応待ち',       // 旧「検収待ち」
  responded: 'AI対応中',    // 旧「応答済み」・decision の選択済み（統括の伝播待ち）
  'done-proposed': '完了提案', // 完了提案（v2.1・ユーザーの完了確定待ち）
  consumed: '完了',         // 旧「消化」
  carried: '申し送り',      // CARRYOVER へ寝かせた（ROLES §1-1b・2026-07-17新設・保留グループ）
  kept: '参考',            // AI が「残す・追加対応なし」と判定した処遇（v2.8.1・2026-07-17・保留グループ・型と処遇の分離＝凡例 C-U0000）
  'awaiting-impl': '実装待ち', // 反映承認済み・実装作業起票済み・順番/依存/容量で着手待ち（v2.9・2026-07-17・保留グループ・→マーカー）
};

// Board の列は種類(type)別（v1.6）。この6種・この順（タブ名と同形の英語見出し）。
export const BOARD_COLUMN_ORDER = ['reference', 'knowledge', 'consult', 'decision', 'report', 'review'];
export const BOARD_COLUMN_LABEL = {
  reference: 'Reference',
  knowledge: 'Knowledge',
  consult: 'Consult',
  decision: 'Decision',
  report: 'Report',
  review: 'Acceptance',
};

export const DIRECTION_LABEL = {
  'user-to-claude': 'user→AI',
  'claude-to-user': 'AI→user',
};

// type（ユーザー発 reference/knowledge/consult ＋ AI発 report/review/decision ＋ template）。
// decision は AI 発の裁定依頼（v1.5・作成フォームには出さない）。
// request は廃止語＝読み込み時は consult 扱い（ファイルは書き換えない）。
export const TYPE_LABEL = {
  reference: 'reference',
  knowledge: 'knowledge',
  consult: 'consult',
  report: 'report',
  review: 'review',
  decision: 'decision',
  template: 'template',
};

// 廃止語 request → consult へ正規化（表示・タブ抽出用。card.md の値は書き換えない）。
export function normalizeType(t) {
  return t === 'request' ? 'consult' : (t || '');
}

// ---------------------------------------------------------------------------
// カード詳細の操作系（v1.7）: direction 別の操作モード・コメント行の生成
// ---------------------------------------------------------------------------

// カード詳細画面に出す操作の種類を direction から決める（v1.7）。一覧タイルには出さない。
//   'edit'   = ユーザー発（user-to-claude）: 編集＋コメント追記（即動作）＋削除
//   'respond' = AI発（claude-to-user）: OK/NG/あとで・選択肢（decision）・コメント（応答をファイルへ・v2.1）
//   'none'   = 方向不明: 操作を出さない
export function cardOperationMode(direction) {
  if (direction === 'user-to-claude') return 'edit';
  if (direction === 'claude-to-user') return 'respond';
  return 'none';
}

// 処理記録へ追記するコメント行を生成（v1.7）。出所マーク mark は 📱（モバイル）/ 💻（Mac）。
//   例: - ↳ 2026-07-15 コメント（あなた・📱）: 内容
export function buildCommentLine(date, text, mark) {
  return '- ↳ ' + date + ' コメント（あなた・' + mark + '）: ' + text;
}

// 本文/タイトル編集の処理記録行を生成（v1.8）。mark は 📱（モバイル）/ 💻（Mac）。
export function buildEditLine(date, mark) {
  return '- ↳ ' + date + ' 本文/タイトル編集（あなた・' + mark + '）';
}

// 応答行の日時スタンプ（YYYY-MM-DD HH:MM・端末ローカル時刻）（v2.1）。
export function nowStamp(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) +
    ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
}

// AI発カードへの応答行を生成（統括AIがparseする固定書式・Mac版と同一・v2.1）。mark=📱（モバイル）/💻（Mac）。
//   kind: 'ok' | 'ng' | 'later' | 'choice' | 'comment'
export function buildResponseLine(datetime, mark, kind, opts) {
  const o = opts || {};
  const head = '- 応答（あなた・' + mark + ' ' + datetime + '）: ';
  const comment = o.comment == null ? '' : String(o.comment);
  if (kind === 'ok') return head + 'OK';
  if (kind === 'ng') return head + 'NG — ' + comment;
  if (kind === 'later') return head + 'あとで';
  if (kind === 'choice') {
    const choice = o.choice == null ? '' : String(o.choice);
    return head + '選択=' + choice + (comment ? ' — ' + comment : '');
  }
  if (kind === 'comment') return head + 'コメント — ' + comment;
  throw new Error('unknown response kind: ' + kind);
}

// 完了確定行を生成（1-2・done-proposed のカードをユーザーが完了確定した記録・v2.1）。
export function buildDoneConfirmLine(datetime, mark) {
  return '- 完了確定（あなた・' + mark + ' ' + datetime + '）';
}

// decision カード本文から選択肢の頭文字（[A-Z]=）を順序保持・重複排除で抽出（v2.1）。
// 例: 「選択肢: A=〜／B=〜／C=〜」から ['A','B','C']。抽出できなければ空配列。
export function extractChoices(body) {
  if (!body) return [];
  const out = [];
  const seen = new Set();
  const re = /(?:^|[^A-Za-z0-9])([A-Z])\s*=/g;
  let m;
  while ((m = re.exec(String(body))) !== null) {
    const c = m[1];
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}

// 応答コメント欄の先頭「選択=X」プレフィックスを分離（純粋関数・v2.7・C-U0004・Mac版 server.js と同一）。
//   「選択=A コメント」→ { choice:'A', comment:'コメント' } ／「選択=A」→ { choice:'A', comment:'' }
//   プレフィックス無し → { choice:'', comment:<全文trim> }。全角＝も許容。choice は先頭空白までのトークン。
export function parseChoicePrefix(text) {
  const s = text == null ? '' : String(text);
  const m = /^\s*選択[=＝](\S+)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return { choice: '', comment: s.trim() };
  return { choice: m[1], comment: (m[2] || '').trim() };
}

// 選択肢ボタン切替: 先頭の「選択=X」だけ差し替え、ユーザーが追記したコメントは保持（純粋関数）。
export function setChoicePrefix(text, choice) {
  const { comment } = parseChoicePrefix(text);
  return '選択=' + choice + ' ' + comment;
}

// カンマ/空白区切りのテキスト or 配列を target 配列へ正規化（v2.1）。
export function parseTargetInput(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (v == null) return [];
  return String(v).split(/[,、\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// target 欄（frontmatter）を設定（v2.1）。空配列かつ欄が元々無い場合は書かない（後方互換）。
export function setTargetField(card, arr) {
  const has = card.raw.target !== undefined;
  if ((!arr || arr.length === 0) && !has) return false;
  setField(card, 'target', serializeTags(arr || []));
  return true;
}

// type の英語表示ラベル（正規化込み）。
export function typeLabel(t) {
  const n = normalizeType(t);
  return TYPE_LABEL[n] || n;
}

// type 別タブ（reference/knowledge/consult）へ出すカードを抽出。request は consult 扱い。
export function cardsForType(cards, type) {
  return (cards || []).filter((c) => normalizeType(c.type) === type);
}

// Board の列を種類(type)別にグルーピング（v1.6）。6列この順・request は consult 列へ合流・
// 6種以外（template 等）はどの列にも入らない。各カードのタイルには日本語状態 chip を出す。
export function boardColumns(cards) {
  return BOARD_COLUMN_ORDER.map((type) => ({
    type,
    label: BOARD_COLUMN_LABEL[type],
    cards: cardsForType(cards, type),
  }));
}

// status の表示ラベル（純粋関数・v2.8.1・2026-07-17）。内部値→表示語彙＝純 status 写像。
// 「参考」は status=kept（型と処遇の分離・凡例 C-U0000 準拠）。v2.8 の型由来（reference/knowledge）導出は撤去。
// これで UI タイル/詳細も CARD_INDEX 状態列も同一写像（type 非依存）。type 引数は呼び出し互換のため残置（未使用）。
export function statusLabel(status, type) {
  return STATUS_LABEL[status] || (status ? status : '—');
}

// 処遇マーカー（純粋関数・v2.8.1・title 末尾右／status から自動導出＝別フィールドにしない）。
//   '✓hollow' = 完了提案(done-proposed・中空✓)／'✓filled' = 完了(consumed・塗り✓)
//   '→'       = 保留グループ（waiting/carried/kept・純 status 基準・v2.8 の型由来導出は撤去）
//   null      = 対応中グループ（new/annotated/review/responded）。type 引数は呼び出し互換のため残置（未使用）。
export function treatmentMarker(status, type) {
  if (status === 'done-proposed') return '✓hollow';
  if (status === 'consumed') return '✓filled';
  if (status === 'waiting' || status === 'carried' || status === 'kept' || status === 'awaiting-impl') return '→';
  return null;
}

// 既定一覧に出すカード（純粋関数・2026-07-17）。アーカイブと完了(consumed)を除外＝Board・種類別タブの既定一覧。
export function listableCards(cards) {
  return (cards || []).filter((c) => !c.archived && c.status !== 'consumed');
}
// 完了ビュー用（2026-07-17）: 完了(consumed) ＋ アーカイブ済み。既定一覧から外れた分をここで一望する。
export function completedCards(cards) {
  return (cards || []).filter((c) => c.status === 'consumed' || c.archived);
}

// ---------------------------------------------------------------------------
// カード（card.md）のパース／シリアライズ（frontmatter 往復無損失）
// ---------------------------------------------------------------------------

// frontmatter を「順序付きの生の値」で保持し、変更しない限り byte 一致で再構築する。
export function parseCard(text) {
  if (!text.startsWith('---\n')) {
    return { order: [], raw: {}, entries: [], fm: {}, body: text, hasFrontmatter: false };
  }
  const closeIdx = text.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    return { order: [], raw: {}, entries: [], fm: {}, body: text, hasFrontmatter: false };
  }
  const fmContent = text.slice(4, closeIdx);
  const body = text.slice(closeIdx + '\n---\n'.length);

  const order = [];
  const raw = {};
  const entries = []; // 非 key:value 行を含む生保持
  for (const line of fmContent.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep === -1) {
      const bare = line.endsWith(':') ? line.slice(0, -1) : null;
      if (bare !== null && /^[A-Za-z0-9_-]+$/.test(bare)) {
        order.push(bare);
        raw[bare] = '';
        entries.push({ type: 'kv', key: bare, empty: true });
      } else {
        entries.push({ type: 'literal', line });
      }
      continue;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    order.push(key);
    raw[key] = value;
    entries.push({ type: 'kv', key });
  }

  const fm = {
    id: raw.id !== undefined ? raw.id : '',
    title: raw.title !== undefined ? raw.title : '',
    direction: raw.direction !== undefined ? raw.direction : '',
    type: raw.type !== undefined ? raw.type : '',
    subject: parseQuoted(raw.subject),
    tags: parseTags(raw.tags),
    surface: parseQuoted(raw.surface),
    status: raw.status !== undefined ? raw.status : '',
    created: raw.created !== undefined ? raw.created : '',
    target: parseTags(raw.target), // 対象付け（機能/FPU/CMP/単位ID・欄が無ければ[]・v2.1）
  };

  return { order, raw, entries, fm, body, hasFrontmatter: true };
}

export function serializeCard(card) {
  if (!card.hasFrontmatter) return card.body;
  const lines = [];
  for (const e of card.entries) {
    if (e.type === 'literal') {
      lines.push(e.line);
    } else if (e.empty && card.raw[e.key] === '') {
      lines.push(e.key + ':');
    } else {
      lines.push(e.key + ': ' + card.raw[e.key]);
    }
  }
  return '---\n' + lines.join('\n') + '\n---\n' + card.body;
}

export function parseTags(rawVal) {
  if (rawVal === undefined || rawVal === null) return [];
  const v = rawVal.trim();
  if (v === '' || v === '[]') return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1)
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  return [stripQuotes(v)];
}

export function parseQuoted(rawVal) {
  if (rawVal === undefined || rawVal === null) return '';
  return stripQuotes(rawVal.trim());
}

export function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function serializeTags(arr) {
  if (!arr || arr.length === 0) return '[]';
  return '[' + arr.join(', ') + ']';
}

export function serializeSurface(s) {
  return '"' + (s || '') + '"';
}

// frontmatter の 1 キーを更新（順序・他行を保持）。
export function setField(card, key, rawValue) {
  if (card.raw[key] === undefined) {
    card.order.push(key);
    card.entries.push({ type: 'kv', key });
  } else {
    for (const e of card.entries) {
      if (e.type === 'kv' && e.key === key) delete e.empty;
    }
  }
  card.raw[key] = rawValue;
}

// ---------------------------------------------------------------------------
// 本文セクション操作
// ---------------------------------------------------------------------------

export function parseSections(body) {
  const sections = {};
  const re = /^## (.+)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    heads.push({ title: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    let content = body.slice(heads[i].contentStart, end);
    const dIdx = content.indexOf('\n---');
    if (dIdx !== -1) content = content.slice(0, dIdx);
    sections[heads[i].title] = content.replace(/^\n+/, '').replace(/\s+$/, '');
  }
  return sections;
}

// 指定見出しの節末尾に 1 行追記（他セクション不変）。
export function appendUnderHeading(body, heading, line) {
  const marker = '## ' + heading;
  const hIdx = body.indexOf(marker);
  if (hIdx === -1) {
    const sep = body.endsWith('\n') ? '' : '\n';
    return body + sep + '\n' + marker + '\n\n' + line + '\n';
  }
  const after = hIdx + marker.length;
  const rest = body.slice(after);
  let boundary = rest.length;
  const nextH = rest.indexOf('\n## ');
  if (nextH !== -1) boundary = Math.min(boundary, nextH);
  const nextDelim = rest.indexOf('\n---');
  if (nextDelim !== -1) boundary = Math.min(boundary, nextDelim);
  const sectionContent = rest.slice(0, boundary).replace(/\s+$/, '');
  const tail = rest.slice(boundary);
  const newSection = sectionContent + '\n' + line + '\n';
  return body.slice(0, after) + newSection + tail;
}

// 指定見出しの節内容を丸ごと置換（他セクションは byte 不変・v1.8）。
// 見出しが無ければ末尾へ新設（appendUnderHeading と同じフォールバック）。本文編集で使う。
export function replaceUnderHeading(body, heading, newContent) {
  const marker = '## ' + heading;
  const content = String(newContent == null ? '' : newContent).replace(/\s+$/, '');
  const hIdx = body.indexOf(marker);
  if (hIdx === -1) {
    const sep = body.endsWith('\n') ? '' : '\n';
    return body + sep + '\n' + marker + '\n\n' + (content ? content + '\n' : '') + '\n';
  }
  const after = hIdx + marker.length;
  const rest = body.slice(after);
  let boundary = rest.length;
  const nextH = rest.indexOf('\n## ');
  if (nextH !== -1) boundary = Math.min(boundary, nextH);
  const nextDelim = rest.indexOf('\n---');
  if (nextDelim !== -1) boundary = Math.min(boundary, nextDelim);
  const tail = rest.slice(boundary);
  const newSection = '\n\n' + (content ? content + '\n' : '');
  return body.slice(0, after) + newSection + tail;
}

// SUBJECTS.md（主題台帳）から主題名一覧を抽出（`- 主題名 — 説明` の箇条書き）。
// ファイルが無い・書式が違っても壊れない（該当行が無ければ空配列）。読み取り専用。
export function parseSubjects(text) {
  const out = [];
  if (!text) return out;
  const re = /^\s*[-*]\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = m[1];
    // 「主題名 — 説明」を em ダッシュ（前後空白付き）で分割。無ければ行全体を主題名とみなす。
    const dashIdx = line.indexOf(' — ');
    const name = (dashIdx !== -1 ? line.slice(0, dashIdx) : line).trim();
    if (name) out.push(name);
  }
  return out;
}

// チェックリスト `- [ ]` / `- [x]` の抽出（将来の進捗ビュー用）。
export function parseChecklist(text) {
  const items = [];
  const re = /^(\s*)- \[([ xX])\]\s+(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    items.push({ indent: m[1].length, done: m[2].toLowerCase() === 'x', text: m[3].trim() });
  }
  return items;
}

// ---------------------------------------------------------------------------
// INBOX 追記（§1 のみに影響）
// ---------------------------------------------------------------------------

export function appendToInbox(text, entry) {
  const lines = text.split('\n');
  const s1 = lines.findIndex((l) => /^## §1/.test(l));
  if (s1 === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    return text + sep + entry + '\n';
  }
  let s2 = -1;
  for (let i = s1 + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { s2 = i; break; }
  }
  if (s2 === -1) s2 = lines.length;

  let placeholderIdx = -1;
  for (let i = s1 + 1; i < s2; i++) {
    if (lines[i].trim() === '（未処理の新規エントリなし）') { placeholderIdx = i; break; }
  }
  if (placeholderIdx !== -1) {
    lines[placeholderIdx] = entry;
  } else {
    let insertAt = s2;
    while (insertAt - 1 > s1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ID 採番・slug 化・日付
// ---------------------------------------------------------------------------

// カード ID（"C-A0003" / dir 名 "C-A0003_slug"）から数値部を取り出す。C-[UA]?\d+ を全許容（v1.9・方向字U/A対応）。
export function cardIdNum(id) {
  const m = /C-[UA]?(\d+)/.exec(id == null ? '' : String(id));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

// カード ID の比較（混在桁でも数値順。同値/非該当は文字列比較でフォールバック）。
export function compareCardId(a, b) {
  const na = cardIdNum(a);
  const nb = cardIdNum(b);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

// Dropbox の list_folder で得たフォルダ名配列から次の ID を決める（Mac版と同一仕様・v1.9）。
// アプリからの新規作成＝ユーザー発＝U系連番。A系（AI発）フォルダはU採番に影響しない。
// U系（新形式 C-U0003_slug）＋字なし旧形式（保険・C-0003_slug 等）をU系連番の計上対象とする。
// 9999 超は padStart(4) が自然に5桁へ拡張。
export function nextCardId(names) {
  let max = -1;
  for (const name of (names || [])) {
    const mu = /^C-U(\d+)/.exec(name);
    const legacy = /^C-(\d+)[_$]/.exec(name);
    let n = null;
    if (mu) n = parseInt(mu[1], 10);
    else if (legacy) n = parseInt(legacy[1], 10);
    if (n !== null && n > max) max = n;
  }
  return 'C-U' + String(max + 1).padStart(4, '0');
}

export function slugify(title) {
  if (!title) return 'card';
  const s = String(title)
    .trim()
    .replace(/[\s　]+/g, '-')
    .replace(/[\/\\]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]+/g, '')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 40);
  return s.length > 0 ? s : 'card';
}

export function safeFileName(name, fallback) {
  let s = String(name || '')
    .replace(/[\/\\]+/g, '_')
    .replace(/[<>:"|?*\x00-\x1f]+/g, '')
    .replace(/^\.+/, '');
  s = s.trim();
  return s.length > 0 ? s : fallback;
}

export function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Memo（Program/Memos/・1メモ=1ファイル・プレーンテキストのみ）（v1.8）
// ---------------------------------------------------------------------------

// メモの時刻スタンプ（YYYYMMDD-HHMMSS）。ファイル名は memoFileName で 'M-' + stamp + '.md'。
export function memoStamp(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) +
    '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}
export function memoFileName(d) {
  return 'M-' + memoStamp(d) + '.md';
}

// テキストの先頭非空行（メモ一覧の表示用・カードタイルの抜粋にも流用可）。
export function firstLine(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length ? lines[0] : '';
}

// ---------------------------------------------------------------------------
// カード新規 Markdown 生成
// ---------------------------------------------------------------------------

export function buildNewCardMarkdown({ id, title, direction, type, subject, body, date }) {
  const subj = (subject || '').replace(/[\r\n]+/g, ' ').trim();
  const fm = [
    '---',
    'id: ' + id,
    'title: ' + (title || '').replace(/[\r\n]+/g, ' '),
    'direction: ' + direction,
    'type: ' + type,
    'subject: ' + (subj ? subj : '""'),
    'tags: []',
    'surface: ""',
    'status: new',
    'created: ' + date,
    '---',
  ].join('\n');
  const bodyText = (body || '').replace(/\s+$/, '');
  const md =
    fm + '\n\n' +
    '## 本文\n\n' + (bodyText ? bodyText + '\n' : '') + '\n' +
    '## 注釈（私が記入）\n\n\n' +
    '## 処理記録\n\n' +
    '- ↳ ' + date + ' 作成\n';
  return md;
}

// ---------------------------------------------------------------------------
// カードオブジェクト（UI 用）を md テキスト + 画像名から組み立て
// ---------------------------------------------------------------------------

export function readCardFromText(text, dir, imageNames) {
  const parsed = parseCard(text);
  const sections = parseSections(parsed.body);
  return {
    id: parsed.fm.id,
    dir,
    title: parsed.fm.title,
    direction: parsed.fm.direction,
    type: parsed.fm.type,
    subject: parsed.fm.subject,
    tags: parsed.fm.tags,
    surface: parsed.fm.surface,
    status: parsed.fm.status,
    created: parsed.fm.created,
    target: parsed.fm.target, // 対象付け（v2.1）
    images: imageNames || [],
    sections: {
      body: sections['本文'] || '',
      note: sections['注釈（私が記入）'] || '',
      record: sections['処理記録'] || '',
    },
  };
}

// ---------------------------------------------------------------------------
// CARD_INDEX.md 再生成（ヘッダ保持・表のみ差し替え）
// ---------------------------------------------------------------------------

function cell(v) {
  const s = (v === undefined || v === null || v === '') ? '' : String(v);
  const cleaned = s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
  return cleaned === '' ? '—' : cleaned;
}

export function buildIndexTable(cards) {
  const head = '| ID | 名称 | 方向 | 種別 | 主題 | タグ | 浮上条件 | 状態 | 更新 |';
  const sep = '|----|------|------|------|------|------|----------|------|------|';
  const rows = cards.map((c) => {
    const dir = DIRECTION_LABEL[c.direction] || (c.direction ? c.direction : '—');
    const type = c.type ? typeLabel(c.type) : '—';
    const tags = (c.tags && c.tags.length) ? c.tags.join('・') : '—';
    const status = STATUS_LABEL[c.status] || (c.status ? c.status : '—');
    return `| ${cell(c.id)} | ${cell(c.title)} | ${dir} | ${cell(type)} | ${cell(c.subject)} | ${cell(tags)} | ${cell(c.surface)} | ${status} | ${cell(c.created)} |`;
  });
  return [head, sep, ...rows].join('\n');
}

export function regenerateIndexContent(existing, cards) {
  const lines = existing.split('\n');
  const tableStart = lines.findIndex((l) => /^\s*\|/.test(l));
  let header;
  if (tableStart === -1) {
    header = existing.replace(/\s+$/, '');
  } else {
    header = lines.slice(0, tableStart).join('\n').replace(/\s+$/, '');
  }
  return header + '\n\n' + buildIndexTable(cards) + '\n';
}

// ---------------------------------------------------------------------------
// Sheets（v2.2・シナリオ/完成定義/RDS の項目レンダリング＋💬コメント＋承認）
// Mac 版 server.js と挙動互換（同じブロック分割・同じ💬挿入・同じ state 書き換え）。
// frontmatter 往復・byte 不変は parseCard/serializeCard/setField を再利用。
// ---------------------------------------------------------------------------

// 見出しテキストの先頭トークン（表示アンカー用のID）。
export function sheetHeadingId(heading) {
  return String(heading == null ? '' : heading).trim().split(/\s+/)[0] || '';
}

// シート本文を項目ブロックへ分割（v2.2・v2.6でCASE分割追加）。
// ブロック開始 =
//   (1) 見出し行（`#`〜`######`）= kind:'heading'
//   (2) トップレベル（インデントなし）のチェックボックス行 `- [ ]`/`- [x]` = kind:'case'（2026-07-17）
//       → 1見出しに複数 CASE が並ぶ様式でも CASE 1件=1欄に分割され、各 CASE に独自の💬欄が付く。
//       ぶら下がり（インデント付き）のチェックボックスは分割しない（サブ項目の内側に留める）。
//   (3) numbered=true では列0の番号項目（`N. `）= kind:'item'
// 返す各ブロック: { index, kind:'heading'|'case'|'item', level, id, heading, start, end }（start/end は body 内オフセット）。
export function parseSheetBlocks(body, numbered) {
  const text = String(body == null ? '' : body);
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = /^(#{1,6}) (.*)$/.exec(line);
    if (hm) {
      const heading = hm[2].trim();
      starts.push({ offset, kind: 'heading', level: hm[1].length, heading, id: sheetHeadingId(heading) });
    } else {
      const cm = /^- \[[ xX]\]( ?)(.*)$/.exec(line); // トップレベルのチェックボックス＝CASE開始
      if (cm) {
        const label = cm[2].trim();
        starts.push({ offset, kind: 'case', level: 0, heading: label, id: sheetHeadingId(label.replace(/[*`]/g, '')) });
      } else if (numbered) {
        const nm = /^(\d+)\. /.exec(line);
        if (nm) starts.push({ offset, kind: 'item', level: 0, heading: line.trim(), id: nm[1] });
      }
    }
    offset += line.length + 1; // +1 = '\n'
  }
  const blocks = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1].offset : text.length;
    blocks.push({ index: k, kind: s.kind, level: s.level, id: s.id, heading: s.heading, start: s.offset, end });
  }
  return blocks;
}

// 「批評」を含む見出しのブロックは折りたたみ表示対象（解釈＝合理的規約・報告に明記）。
export function sheetBlockCollapses(block) {
  return !!block && block.kind === 'heading' && /批評/.test(block.heading || '');
}

// 項目直下コメント行（v2.2）。書式 = 💬（📱|💻 YYYY-MM-DD HH:MM）: 本文（RDSの💬慣行と互換）。
export function buildSheetCommentLine(datetime, mark, text) {
  return '💬（' + mark + ' ' + datetime + '）: ' + String(text == null ? '' : text).replace(/[\r\n]+/g, ' ');
}

// 指定ブロックの直下（次ブロックの直前・末尾空行の前）へ1行挿入。他部分は byte 不変。
export function insertSheetCommentInBody(body, blockIndex, line, numbered) {
  const text = String(body == null ? '' : body);
  const blocks = parseSheetBlocks(text, numbered);
  const b = blocks[blockIndex];
  if (!b) throw new Error('ブロックが見つかりません: ' + blockIndex);
  const segment = text.slice(b.start, b.end);
  const trimmed = segment.replace(/\s+$/, '');
  const tail = segment.slice(trimmed.length); // 末尾空行（次ブロックとの区切り）は保持
  return text.slice(0, b.start) + trimmed + '\n' + line + tail + text.slice(b.end);
}

// シート全体（frontmatter往復＋本文）へコメント挿入（v2.2）。
export function insertSheetComment(text, blockIndex, line, numbered) {
  const p = parseCard(text);
  p.body = insertSheetCommentInBody(p.body, blockIndex, line, numbered);
  return serializeCard(p);
}

// シートの frontmatter メタ（state / review_card / 有無）。無ければ null（frontmatterなし＝承認UIを出さない）。
export function parseSheetMeta(text) {
  const p = parseCard(text);
  return {
    hasFrontmatter: p.hasFrontmatter,
    state: p.raw.state !== undefined ? p.raw.state : null,
    reviewCard: p.raw.review_card !== undefined ? p.raw.review_card : null,
  };
}

// frontmatter の state 行のみ書き換え（他は byte 不変・v2.2）。
export function setSheetState(text, newState) {
  const p = parseCard(text);
  setField(p, 'state', String(newState));
  return serializeCard(p);
}

// ---------------------------------------------------------------------------
// 項目チェックボックス（§2-4・2026-07-17）。本文中の Markdown チェックボックス
// （`- [ ]` / `- [x]` / `- [X]`・インデント可）を全ソース一律に走査するだけ（意味は解釈しない）。
// 行番号はファイル全体（frontmatter 含む）の 0 始まり＝トグル書き戻しの錨。Mac 版 server.js と挙動互換。
// ---------------------------------------------------------------------------

// m[1]=インデント, m[2]=チェック文字, m[3]=直後の空白, m[4]=ラベル。
const SHEET_CHECKBOX_RE = /^(\s*)- \[([ xX])\]( ?)(.*)$/;

// ファイル全文からチェックボックス行を走査（表示＋トグル用）。line = 全文での 0 始まり行番号。
export function scanSheetCheckboxes(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SHEET_CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    out.push({ line: i, indent: m[1].length, checked: m[2].toLowerCase() === 'x', char: m[2], text: m[4], content: lines[i] });
  }
  return out;
}

// チェックボックスの総数・チェック済/未チェック（承認ゲート用）。チェック0個なら total=0。
export function countSheetCheckboxes(text) {
  const c = scanSheetCheckboxes(text);
  const checked = c.filter((x) => x.checked).length;
  return { total: c.length, checked, unchecked: c.length - checked };
}

// 該当行のチェック文字 1 字のみをトグル（' '↔'x'・大文字 X もトグルで ' ' へ）。他は全て byte 不変。
// lineIndex/expectedLine は読み込み時の錨。行が期待内容でなければ拒否（再読込を促す）。
export function toggleCheckboxLine(text, lineIndex, expectedLine) {
  const lines = String(text == null ? '' : text).split('\n');
  if (!(lineIndex >= 0 && lineIndex < lines.length)) {
    throw new Error('対象行が範囲外です（再読込してください）');
  }
  const line = lines[lineIndex];
  if (expectedLine != null && line !== String(expectedLine)) {
    throw new Error('対象行が変化しています（再読込してください）');
  }
  const m = SHEET_CHECKBOX_RE.exec(line);
  if (!m) throw new Error('チェックボックス行ではありません（再読込してください）');
  const pos = m[1].length + 3; // インデント + '- [' の 3 文字ぶん = 角括弧内の 1 字
  const next = line[pos] === ' ' ? 'x' : ' ';
  lines[lineIndex] = line.slice(0, pos) + next + line.slice(pos + 1);
  return lines.join('\n');
}

// 承認後の変更検知（§2-4 C）。アプリの書き込みで本文が変わったとき、state: approved なら
// reviewed へ戻す（「承認済みのまま中身が変わる」防止）。approved 以外は byte 不変で返す。
export function revertApprovedToReviewed(text) {
  const meta = parseSheetMeta(text);
  if (meta.hasFrontmatter && meta.state != null && String(meta.state).trim() === 'approved') {
    return setSheetState(text, 'reviewed');
  }
  return text;
}

// 開いたシートの表示ペイロード（frontmatterメタ＋序文＋項目ブロック・raw付き）。Mac版 sheetItemPayload と同形。
export function sheetPayload(text, numbered) {
  const p = parseCard(text);
  // 本文が全文の何行目から始まるか（frontmatter 行数）= チェックボックスの全文行番号を出すための基準。
  const bodyStartLine = (String(text).slice(0, String(text).length - p.body.length).match(/\n/g) || []).length;
  const raw = parseSheetBlocks(p.body, numbered);
  const blocks = raw.map((b) => ({
    index: b.index, kind: b.kind, level: b.level, id: b.id, heading: b.heading,
    raw: p.body.slice(b.start, b.end).replace(/\s+$/, ''),
    collapse: sheetBlockCollapses(b),
    startLine: bodyStartLine + (p.body.slice(0, b.start).match(/\n/g) || []).length,
  }));
  const preamble = (raw.length ? p.body.slice(0, raw[0].start) : p.body).replace(/\s+$/, '');
  return { meta: parseSheetMeta(text), preamble, preambleStartLine: bodyStartLine, blocks, checkStats: countSheetCheckboxes(text) };
}

// ---------------------------------------------------------------------------
// Sessions（起動チケット・v2.4・Phase4）——Mac版 server.js と挙動互換の純パーサ。
// モバイルは表示のみ（▶起動は非活性=「Macで起動」）。frontmatter は簡易 YAML（key: value）。
// ---------------------------------------------------------------------------

// briefing.md のパース（frontmatter またはなし）。target は [a,b] リスト、他はスカラ文字列。
export function parseTicket(text) {
  const src = String(text == null ? '' : text);
  if (!src.startsWith('---\n')) return { hasFrontmatter: false, fm: {}, body: src };
  const close = src.indexOf('\n---\n', 4);
  if (close === -1) return { hasFrontmatter: false, fm: {}, body: src };
  const fmText = src.slice(4, close);
  const body = src.slice(close + '\n---\n'.length);
  const fm = {};
  for (const line of fmText.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    fm[key] = line.slice(sep + 1).trim();
  }
  return { hasFrontmatter: true, fm, body };
}

export function ticketHeading(body) {
  const m = /^#\s+(.*)$/m.exec(String(body || ''));
  return m ? m[1].trim() : '';
}
export function ticketIdFromString(s) {
  const m = /\bS-\d+\b/.exec(String(s || ''));
  return m ? m[0] : '';
}
// frontmatter が無い手動チケットの冒頭 blockquote（`role: **…**`）から role を推定。
export function roleFromBody(body) {
  const m = /role\s*[:：]\s*\*{0,2}\s*([^／|*\n]+?)\s*\*{0,2}\s*(?:[／|]|$)/m.exec(String(body || ''));
  return m ? m[1].trim() : '';
}

// チケットの表示メタ（dirName はフォルダ名・例 'S-0001_slug'）。起動はモバイル非対応=launchable なし。
export function ticketMeta(dirName, text) {
  const parsed = parseTicket(text);
  const fm = parsed.fm;
  const heading = ticketHeading(parsed.body);
  const id = (fm.id && fm.id.trim()) || ticketIdFromString(heading) || ticketIdFromString(dirName);
  let title = fm.title ? fm.title.trim() : '';
  if (!title && heading) title = heading.includes('—') ? heading.slice(heading.indexOf('—') + 1).trim() : heading;
  if (!title) { const us = dirName.indexOf('_'); title = us === -1 ? dirName : dirName.slice(us + 1); }
  return {
    id, dir: dirName, title,
    role: fm.role || (parsed.hasFrontmatter ? '' : roleFromBody(parsed.body)),
    target: parseTags(fm.target),
    model: fm.model || '',
    permissionMode: fm.permission_mode || '',
    remoteControlName: fm.remote_control_name || '',
    cwd: fm.cwd || '',
    confirmMode: fm.confirm_mode || '',
    status: fm.status || '',
    hasFrontmatter: parsed.hasFrontmatter,
  };
}

// ---------------------------------------------------------------------------
// Views データアダプタ層（v2.3・3-1/3-2）——Mac版 server.js と挙動互換の純パーサ群。
// 「取得→正規化レコード列」を型ごとに分離。ソース差し替え（census→FEATURE_LIST）は
// config+アダプタ1個の追加で済む。DOM・Dropbox 非依存（fixture 文字列でテスト）。
// ---------------------------------------------------------------------------

const CENSUS_CODE_RE = /（([A-Z][A-Z0-9_]*)）/g;
const CENSUS_TAG_RE = /\[(実装|一部|未実装|将来想定|不明)\/([^/\[\]]+)\/([^\[\]]+?)\]/;
const CENSUS_TAG_CANDIDATE_RE = /\[(実装|一部|未実装|将来想定|不明)([^\[\]]*)\]/;

// FEATURE_FPU_CENSUS.md（チェックリスト版）→ 正規化レコード列。§1/§2 のみ収集。崩れ行は skip。
export function parseCensus(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const records = [];
  let skipped = 0;
  let collecting = false;
  let category = null;
  let parentFpu = null;
  for (const line of lines) {
    const sec = /^##\s+§\s*(\d)/.exec(line);
    if (sec) { collecting = (sec[1] === '1' || sec[1] === '2'); continue; }
    const cat = /^###\s+([A-Za-z]{2,3})(?:[\s（(]|$)/.exec(line);
    if (/^###\s+/.test(line)) { category = cat ? cat[1] : null; parentFpu = null; continue; }
    if (!collecting) continue;
    const cm = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!cm) continue;
    const indent = cm[1].length;
    const done = cm[2].toLowerCase() === 'x';
    let rest = cm[3].trim();
    if (rest === '') { skipped++; continue; }

    let state = null, form = null, stage = null, hasTag = false;
    const full = CENSUS_TAG_RE.exec(rest);
    if (full) {
      state = full[1]; form = full[2].trim(); stage = full[3].trim(); hasTag = true;
      rest = (rest.slice(0, full.index) + ' ' + rest.slice(full.index + full[0].length)).trim();
    } else if (CENSUS_TAG_CANDIDATE_RE.test(rest)) {
      skipped++; continue;
    }

    let fpu = null;
    CENSUS_CODE_RE.lastIndex = 0;
    let m;
    while ((m = CENSUS_CODE_RE.exec(rest)) !== null) fpu = m[1];
    let namePart = rest.replace(CENSUS_CODE_RE, ' ');
    const dash = namePart.indexOf(' — ');
    let name = namePart, desc = '';
    if (dash !== -1) { name = namePart.slice(0, dash); desc = namePart.slice(dash + 3).trim(); }
    name = name.replace(/\*\*/g, '').replace(/◇/g, '').replace(/\s+/g, ' ').trim();
    if (name === '') { skipped++; continue; }

    const level = indent === 0 ? 'feature' : 'fpu';
    if (level === 'feature' && fpu) parentFpu = fpu;
    const joinKey = fpu || (level === 'fpu' ? parentFpu : null);
    records.push({ done, level, name, desc, fpu, joinKey, state, form, stage, hasTag, category });
  }
  return { records, skipped };
}

// TASK_LEDGER.md → タスク行の配列（IDなし自由文）。
export function parseTaskLedger(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const entries = [];
  let section = null;
  for (const line of lines) {
    const hm = /^##\s+(.+)$/.exec(line);
    if (hm) { section = hm[1].trim(); continue; }
    const bm = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (!bm) continue;
    entries.push({ text: bm[1].trim(), section });
  }
  return { entries };
}

// LANES_BOARD → レーン欄（### 見出し）の {id, heading, text}。
export function parseLanes(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const lanes = [];
  let cur = null;
  let inLaneSection = false;
  for (const line of lines) {
    if (/^##\s+1\.\s*レーン欄/.test(line)) { inLaneSection = true; continue; }
    if (/^##\s+/.test(line) && !/^##\s+1\./.test(line)) { inLaneSection = false; cur = null; continue; }
    const hm = /^###\s+(.+)$/.exec(line);
    if (hm && inLaneSection) {
      const heading = hm[1].trim();
      cur = { id: heading.split(/[（(]/)[0].trim(), heading, text: '' };
      lanes.push(cur);
      continue;
    }
    if (cur) cur.text += line + '\n';
  }
  return { lanes };
}

// test_status.json → {機能ID:'green'|'red'}。未存在（null）→ null＝無表示。壊れJSON→null。
export function parseTestStatus(jsonText) {
  if (jsonText == null) return null;
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const norm = (v) => {
    if (v === true) return 'green';
    if (v === false) return 'red';
    const s = String(v == null ? '' : v).toLowerCase();
    if (['green', 'pass', 'passed', 'ok', '緑', '○'].includes(s)) return 'green';
    if (['red', 'fail', 'failed', 'ng', '赤', '×'].includes(s)) return 'red';
    return null;
  };
  const src = obj.features && typeof obj.features === 'object' ? obj.features : obj;
  const map = {};
  for (const [k, v] of Object.entries(src)) {
    const val = (v && typeof v === 'object') ? (v.status != null ? v.status : (v.color != null ? v.color : v.result)) : v;
    const c = norm(val);
    if (c) map[k] = c;
  }
  return map;
}

export function countTasksFor(entries, joinKey, name) {
  const list = entries || [];
  return list.filter((e) => {
    const t = e.text || '';
    if (joinKey && joinKey.length >= 2 && t.includes(joinKey)) return true;
    if (name && name.length >= 3 && t.includes(name)) return true;
    return false;
  }).length;
}

export function laneActiveFor(lanes, rec) {
  const list = lanes || [];
  const key = rec && rec.joinKey;
  const name = rec && rec.name;
  return list.some((l) => {
    const hay = (l.heading || '') + '\n' + (l.text || '');
    if (key && key.length >= 2 && hay.includes(key)) return true;
    if (name && name.length >= 3 && hay.includes(name)) return true;
    return false;
  });
}

export function testColorFor(map, rec) {
  if (!map) return null;
  if (rec.joinKey && map[rec.joinKey]) return map[rec.joinKey];
  if (rec.name && map[rec.name]) return map[rec.name];
  return null;
}

// 進捗の合成レコード列（3-2）。機能ID・段階・状態・タスク数・稼働印・テスト色。
export function buildProgressRows(censusRes, ledgerRes, lanesRes, testStatusMap) {
  const records = (censusRes && censusRes.records) || [];
  const entries = (ledgerRes && ledgerRes.entries) || [];
  const lanes = (lanesRes && lanesRes.lanes) || [];
  return records.map((r) => ({
    id: r.joinKey || r.fpu || r.name,
    name: r.name,
    level: r.level,
    category: r.category,
    stage: r.stage,
    state: r.state,
    form: r.form,
    hasTag: r.hasTag,
    taskCount: countTasksFor(entries, r.joinKey, r.name),
    laneActive: laneActiveFor(lanes, r),
    testColor: testColorFor(testStatusMap, r),
  }));
}

// ===========================================================================
// 進捗軸（work unit）層（v2.9・3-2改定・2026-07-17）——Mac版 server.js と挙動互換。
// 全源（census=feature/fpu・COM_TARGETS=com・PROGRESS_AXIS §6=data/infra/…）を
// 「作業単位」共通スキーマ（id/kind/title/stage/status/blocked_reason/deps/source）へ結合。
// ===========================================================================

// 統一状態語彙6値（PROGRESS_AXIS §2）。
export const UNIFIED_STATUS = ['未着手', '待ち', '進行中', '完了', '対象外', '不明'];
const STATUS_ABSORB = {
  '実装': '完了', '一部': '進行中', '未実装': '未着手', '線外': '対象外', '将来想定': '対象外', '不明': '不明',
  '現役': '進行中', '完了': '完了', '休眠': '未着手', '資料庫': '対象外', '退役': '対象外',
  '未着手': '未着手', '待ち': '待ち', '進行中': '進行中', '対象外': '対象外',
};

// 生statusを統一6値へ正規化。写像不能値→「不明」＋生値 sub（§2）。
export function normalizeWorkStatus(raw) {
  const r = String(raw == null ? '' : raw).trim();
  if (STATUS_ABSORB[r]) return { status: STATUS_ABSORB[r], sub: null };
  return { status: '不明', sub: r || null };
}

// deps セル → トークン配列（WU-*/Q-*/S0〜S6・"—"=空）。
export function parseDeps(cell) {
  const s = String(cell == null ? '' : cell).trim();
  if (s === '' || s === '—' || s === '-' || s === '−') return [];
  return s.split(/[,、]/).map((t) => t.trim()).filter((t) => t && t !== '—' && t !== '-' && t !== '−');
}

// PROGRESS_AXIS.md §6 の md 表 → work unit 配列（8列）。未存在・§6無し・空表でも壊れない。
export function parseProgressAxis(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const units = [];
  let skipped = 0;
  let inSix = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) { inSix = /^##\s+§\s*6\b/.test(line); continue; }
    if (!inSix) continue;
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (cells[0].toLowerCase() === 'id') continue;
    if (cells.length < 8) { skipped++; continue; }
    const id = cells[0];
    if (!id) { skipped++; continue; }
    const br = cells[5];
    const norm = normalizeWorkStatus(cells[4]);
    units.push({
      id, kind: cells[1], title: cells[2], stage: cells[3],
      status: norm.status, statusRaw: cells[4], statusSub: norm.sub,
      blocked_reason: (br === '—' || br === '-' || br === '−' || br === '') ? null : br,
      deps: parseDeps(cells[6]), source: cells[7] || '本台帳',
    });
  }
  return { units, skipped };
}

// COM_FUNCTION_TARGETS.md → com レコード列（`## G\d+` グループ内のみ・崩れ行 skip）。
const COM_LINE_RE = /^\s*-\s+\[[ xX]\]\s+(.+?)（([^）]*)）\s*\[([^\]]*)\]\s*\[([^\]]*)\]/;
export function parseComTargets(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const records = [];
  let skipped = 0;
  let group = null;
  for (const line of lines) {
    const gm = /^##\s+(G\d+)\b\s*(.*)$/.exec(line);
    if (/^##\s+/.test(line)) { group = gm ? (gm[1] + (gm[2] ? ' ' + gm[2].trim() : '')) : null; continue; }
    if (!group) continue;
    if (!/^\s*-\s+\[[ xX]\]/.test(line)) continue;
    const m = COM_LINE_RE.exec(line);
    if (!m) { skipped++; continue; }
    const rawName = m[1].trim();
    const jp = m[2].trim();
    const tags = m[3].trim();
    const slots = m[4].split('/').map((s) => s.trim());
    if (slots.length !== 4) { skipped++; continue; }
    const cat = /^(G\d+)/.exec(group);
    records.push({ id: rawName, jp, tags, slots, title: rawName + '（' + jp + '）', group, category: cat ? cat[1] : null });
  }
  return { records, skipped };
}

// com の [AG/MG/AE/ME] → 統一status＋stage（全済→完了/一部済→進行中/済ゼロ→未着手・stage=残り最早段階）。
export function deriveComStatus(slots) {
  const NA = new Set(['-', '−', '']);
  const applicable = (slots || []).filter((s) => !NA.has(s));
  if (applicable.length === 0) return { status: '対象外', stage: '—', sub: null };
  const isStage = (s) => /^S[0-6]$/.test(s);
  const unknown = applicable.filter((s) => s !== '済' && !isStage(s));
  const stages = applicable.filter(isStage).map((s) => Number(s.slice(1)));
  const earliest = stages.length ? 'S' + Math.min(...stages) : '不明';
  if (unknown.length) return { status: '不明', stage: stages.length ? earliest : '不明', sub: unknown.join(',') };
  const done = applicable.filter((s) => s === '済').length;
  if (done === applicable.length) return { status: '完了', stage: '済', sub: null };
  if (done === 0) return { status: '未着手', stage: earliest, sub: null };
  return { status: '進行中', stage: earliest, sub: null };
}

// CARRYOVER.md §台帳 → CO 行（tokens=宛先ID+内容の大文字IDトークン）。
const CO_TOKEN_RE = /WU-[A-Z]+-\d+|[A-Z][A-Z0-9_]{2,}/g;
export function parseCarryover(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const rows = [];
  for (const line of lines) {
    if (!/^\s*\|\s*CO-\d+/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const hay = (cells[2] || '') + ' ' + (cells[4] || '');
    const tokens = hay.match(CO_TOKEN_RE) || [];
    rows.push({ id: cells[0], kind: cells[1], target: cells[2], content: cells[4], tokens: [...new Set(tokens)] });
  }
  return { rows };
}

// 該当 work unit の CARRYOVER 件数（IDトークンと unit.id の完全一致）。
export function carryoverCountFor(coRows, unit) {
  const id = unit && unit.id;
  if (!id || !coRows) return 0;
  return coRows.filter((co) => co.tokens.includes(id)).length;
}

// 全源 → 作業単位共通スキーマへ結合（overlays 付与）。
export function buildWorkUnits(censusRes, comRes, axisRes, ledgerRes, lanesRes, testStatusMap, coRes) {
  const entries = (ledgerRes && ledgerRes.entries) || [];
  const lanes = (lanesRes && lanesRes.lanes) || [];
  const coRows = (coRes && coRes.rows) || [];
  const units = [];
  for (const r of ((censusRes && censusRes.records) || [])) {
    if (!r.hasTag) continue;
    const id = r.joinKey || r.fpu || r.name;
    const norm = normalizeWorkStatus(r.state);
    units.push({
      id, kind: r.level, title: r.name, stage: r.stage,
      status: norm.status, statusRaw: r.state, statusSub: norm.sub,
      blocked_reason: null, deps: [], source: 'census',
      category: r.category, form: r.form, level: r.level,
    });
  }
  for (const r of ((comRes && comRes.records) || [])) {
    const d = deriveComStatus(r.slots);
    units.push({
      id: r.id, kind: 'com', title: r.title, stage: d.stage,
      status: d.status, statusRaw: r.slots.join('/'), statusSub: d.sub,
      blocked_reason: null, deps: [], source: 'COM_TARGETS',
      category: r.category, form: r.tags, level: 'com',
    });
  }
  for (const u of ((axisRes && axisRes.units) || [])) {
    units.push({
      id: u.id, kind: u.kind, title: u.title, stage: u.stage,
      status: u.status, statusRaw: u.statusRaw, statusSub: u.statusSub,
      blocked_reason: u.blocked_reason, deps: u.deps.slice(), source: u.source,
      category: null, form: null, level: u.kind,
    });
  }
  for (const u of units) {
    u.taskCount = countTasksFor(entries, u.id, u.title);
    u.laneActive = laneActiveFor(lanes, { joinKey: u.id, name: u.title });
    u.testColor = testColorFor(testStatusMap, { joinKey: u.id, name: u.title });
    u.carryoverCount = carryoverCountFor(coRows, u);
  }
  return units;
}

// ---- フロンティア（依存の可視化）純関数 ----

export function depState(dep, byId) {
  if (byId.has(dep)) {
    const u = byId.get(dep);
    return { dep, kind: 'unit', resolved: u.status === '完了', status: u.status };
  }
  if (/^Q-/.test(dep)) return { dep, kind: 'decision', resolved: false, status: null };
  if (/^S[0-6]$/.test(dep)) return { dep, kind: 'stage', resolved: false, status: null };
  return { dep, kind: 'external', resolved: false, status: null };
}

export function unmetDeps(unit, byId) {
  return (unit.deps || []).map((d) => depState(d, byId)).filter((x) => !x.resolved);
}

export function buildReverseIndex(units) {
  const idx = new Map();
  for (const u of units) {
    for (const d of (u.deps || [])) {
      if (!idx.has(d)) idx.set(d, []);
      idx.get(d).push(u.id);
    }
  }
  return idx;
}

// node に推移的に依存する全 unit.id 集合（循環でも無限ループしない）。
export function reverseClosure(nodeId, units, reverseIndex) {
  const idx = reverseIndex || buildReverseIndex(units);
  const result = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop();
    for (const dependent of (idx.get(cur) || [])) {
      if (!result.has(dependent)) { result.add(dependent); stack.push(dependent); }
    }
  }
  return result;
}

export function buildReverseClosureMap(units) {
  const idx = buildReverseIndex(units);
  const nodes = new Set();
  for (const u of units) { nodes.add(u.id); for (const d of (u.deps || [])) nodes.add(d); }
  const map = {};
  for (const n of nodes) {
    const set = reverseClosure(n, units, idx);
    if (set.size) map[n] = [...set];
  }
  return map;
}

export function externalNodes(units) {
  const ids = new Set(units.map((u) => u.id));
  const seen = new Map();
  for (const u of units) {
    for (const d of (u.deps || [])) {
      if (ids.has(d) || seen.has(d)) continue;
      const kind = /^Q-/.test(d) ? 'decision' : (/^S[0-6]$/.test(d) ? 'stage' : 'external');
      seen.set(d, kind);
    }
  }
  return [...seen.entries()].map(([id, kind]) => ({ id, kind }));
}

// 進捗ペイロード（全源結合・Mac progressPayload と同形）。
export function buildProgressPayload(sources) {
  const census = parseCensus(sources.censusText);
  const com = parseComTargets(sources.comText);
  const axis = parseProgressAxis(sources.axisText);
  const ledger = parseTaskLedger(sources.ledgerText);
  const lanes = parseLanes(sources.lanesText);
  const testMap = parseTestStatus(sources.testText);
  const co = parseCarryover(sources.coText);
  const units = buildWorkUnits(census, com, axis, ledger, lanes, testMap, co);
  const byKind = {};
  for (const u of units) byKind[u.kind] = (byKind[u.kind] || 0) + 1;
  return {
    units,
    reverseClosure: buildReverseClosureMap(units),
    externalNodes: externalNodes(units),
    counts: { total: units.length, byKind },
    skipped: { census: census.skipped, com: com.skipped, axis: axis.skipped },
    coRows: co.rows.length,
    sources: {
      census: sources.censusText != null,
      comTargets: sources.comText != null,
      progressAxis: sources.axisText != null,
      taskLedger: sources.ledgerText != null,
      lanes: sources.lanesText != null,
      testStatus: testMap != null,
      carryover: sources.coText != null,
    },
  };
}

// ライブラリmd項目の見出しブロック（目次/コメント用・parseSheetBlocks を level>=1 で再利用）。
export function libraryMdBlocks(text) {
  return parseSheetBlocks(text, false)
    .filter((b) => b.kind === 'heading')
    .map((b) => ({ index: b.index, level: b.level, id: b.id, heading: b.heading }));
}
