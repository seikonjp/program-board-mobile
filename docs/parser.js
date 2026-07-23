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

// slug の安全な打ち切り（SPEC_V3 §2 磨き a・2026-07-23・Mac lib/createCard.js と同一挙動）。
//   (1) 括弧安全: 切り位置が開き括弧の内側なら開き括弧の手前まで戻す（括弧の途中で切れない）。
//   (2) 語境界: 括弧問題が無ければ直近の区切り（- _ 空白）で切る（半分以上残る場合のみ）。
const SLUG_OPEN = '（(［[｛{「『【〈《〔';
const SLUG_CLOSE = '）)］]｝}」』】〉》〕';
export function safeTruncateSlug(s, max) {
  const str = String(s == null ? '' : s);
  const cap = (max == null ? 40 : max);
  if (str.length <= cap) return str;
  let cut = cap;
  let depth = 0;
  let lastOpenOutside = -1;
  for (let i = 0; i < cut; i++) {
    const ch = str[i];
    if (SLUG_OPEN.indexOf(ch) >= 0) { if (depth === 0) lastOpenOutside = i; depth++; }
    else if (SLUG_CLOSE.indexOf(ch) >= 0) { if (depth > 0) depth--; }
  }
  if (depth > 0 && lastOpenOutside >= 0) {
    cut = lastOpenOutside;
  } else {
    const seg = str.slice(0, cut);
    const bi = Math.max(seg.lastIndexOf('-'), seg.lastIndexOf('_'), seg.lastIndexOf(' '));
    if (bi >= Math.floor(cap / 2)) cut = bi;
  }
  return str.slice(0, cut).replace(/[-_\s]+$/, '');
}

export function slugify(title) {
  if (!title) return 'card';
  let s = String(title)
    .trim()
    .replace(/[\s　]+/g, '-')
    .replace(/[\/\\]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]+/g, '')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  s = safeTruncateSlug(s, 40).replace(/^[.\-]+|[.\-]+$/g, '');
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
    // status 既定値（SPEC_V3 §2 磨き b・2026-07-23）: report/review 型＝作成時から review（対応待ち）。
    'status: ' + ((type === 'report' || type === 'review') ? 'review' : 'new'),
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
      const cm = /^- \[([ xX])\]( ?)(.*)$/.exec(line); // トップレベルのチェックボックス＝CASE開始
      if (cm) {
        const label = cm[3].trim();
        starts.push({ offset, kind: 'case', level: 0, heading: label, id: sheetHeadingId(label.replace(/[*`]/g, '')), checked: cm[1].toLowerCase() === 'x' });
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
    blocks.push({ index: k, kind: s.kind, level: s.level, id: s.id, heading: s.heading, start: s.offset, end, checked: !!s.checked });
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
//   便8（§5d）: opts={ transform, docHash } を渡すと docHash 照合（fresh/stale/absent）→ fresh のみ各ケースへ差し込む。
//   docHash の計算（sha256）は program.js（async SubtleCrypto）で行い、ここへ結果だけ渡す（純関数のまま）。
export function sheetPayload(text, numbered, testStatusMap, opts) {
  const p = parseCard(text);
  // 本文が全文の何行目から始まるか（frontmatter 行数）= チェックボックスの全文行番号を出すための基準。
  const bodyStartLine = (String(text).slice(0, String(text).length - p.body.length).match(/\n/g) || []).length;
  const raw = parseSheetBlocks(p.body, numbered);
  // D-1 表示合成（§2-1）: 状態(item1)の導出源＝原典マーカー＋test_status（機能/FPU単位・省略時 null）。
  const scenarioMeta = parseScenarioMeta(text);
  // ファイル名は payload に渡らない（テキストのみ）＝frontmatter target と冒頭宣言の対象から関連単位を得る。
  const relatedUnits = extractRelatedUnits('', text).concat(scenarioMeta.target || [])
    .filter((v, i, a) => v && a.indexOf(v) === i);
  const tsEntry = testStatusFor(relatedUnits, testStatusMap || {});
  const o = opts || {};
  const transform = resolveTransform(o.transform || null, o.docHash != null ? o.docHash : null);
  const blocks = raw.map((b) => {
    const rawText = p.body.slice(b.start, b.end).replace(/\s+$/, '');
    const out = {
      index: b.index, kind: b.kind, level: b.level, id: b.id, heading: b.heading,
      raw: rawText, checked: !!b.checked,
      collapse: sheetBlockCollapses(b),
      startLine: bodyStartLine + (p.body.slice(0, b.start).match(/\n/g) || []).length,
    };
    if (b.kind === 'case') { const cf = parseCaseFields(rawText, tsEntry); out.caseFields = applyCaseTransform(cf, transform, cf.caseId); }
    return out;
  });
  const preamble = (raw.length ? p.body.slice(0, raw[0].start) : p.body).replace(/\s+$/, '');
  const meta = parseSheetMeta(text);
  return {
    meta, preamble, preambleStartLine: bodyStartLine, blocks,
    checkStats: countSheetCheckboxes(text),
    approval: sheetApprovalSummary(raw), scenarioMeta, relatedUnits,
    // 便8（§5d）: 判断対象のみ表示の材料（originSub/legacyFormat は program.js が source を知って付与）。
    transformState: transform.state,
    docSummary: (transform.state === 'absent') ? null : transform.docSummary,
    transformBlocks: (transform.state === 'fresh') ? transform.blocks : null,
  };
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

// ===========================================================================
// D-1 シナリオ Sheet 表示合成（SPEC_V3 §2・v2.11 便2）— 純粋関数（Mac server.js と挙動互換）
// 原典mdの様式・バイトは一切変更しない。表示は機械抽出＋レジストリ結合の合成のみ。
// ===========================================================================

// 状態語彙7値（§2-2）。導出源が無い項目は「不明」を正規表示（偽装しない）。
export const CASE_STATUS_VOCAB = ['実装済み', '実装可（未着手）', '追加実装が必要', '他機能の実装待ち', '実装中', 'テスト一部成功・停止中', 'デバッグ中', '不明'];

// 分類の正式語（§2-1項目0）。原典の表記ゆらぎ（境界→境界値）を正規化。最も具体的なものを優先。
export function detectCaseClassification(text) {
  const s = String(text == null ? '' : text);
  if (/優雅な失敗/.test(s)) return '優雅な失敗';
  if (/状態依存/.test(s)) return '状態依存';
  if (/境界値/.test(s) || /境界/.test(s)) return '境界値';
  if (/望まし/.test(s)) return '望ましさ観察';
  if (/正常系/.test(s)) return '正常系';
  return null;
}

// 原典ラベル → 表示項目の写像（§2-1抽出規約・前方一致）。未写像は「その他」（フラット原則）。
export function caseFieldTarget(label) {
  const L = String(label == null ? '' : label).trim();
  if (/^実装可否/.test(L)) return { item: 1, key: 'marker' };
  if (/^起きること/.test(L)) return { item: 3, key: 'content', order: 1 };
  if (/^前提/.test(L)) return { item: 3, key: 'content', order: 2 };
  if (/^操作/.test(L) || /契機/.test(L)) return { item: 3, key: 'content', order: 3 };
  if (/^観察/.test(L)) return { item: 3, key: 'content', order: 4 };
  if (/^検収/.test(L)) return { item: 2, key: 'completion' };
  if (/^実装/.test(L)) return { item: 5, key: 'impl' };
  if (/品質基準/.test(L)) return { item: 6, key: 'quality' };
  if (/^失敗/.test(L)) return { item: 7, key: 'failure' };
  if (/ギャップ/.test(L)) return { item: 8, key: 'gap' };
  if (/^対象/.test(L)) return { item: 10, key: 'target', collapse: true };
  if (/^根拠/.test(L)) return { item: 10, key: 'basis', collapse: true };
  return { item: 9.5, key: 'other', label: L };
}

// ぶら下がり行 "  - ラベル: 本文" からラベルと行内本文を分離。
export function splitCaseLabel(rest) {
  const s = String(rest == null ? '' : rest);
  const ci = s.search(/[:：]/);
  if (ci < 0) return { label: null, inline: s.trim(), hasColon: false };
  let label = s.slice(0, ci).replace(/\*\*/g, '').replace(/`/g, '');
  label = label.replace(/[（(].*$/, '').trim();
  const inline = s.slice(ci + 1).replace(/^\s+/, '');
  return { label, inline, hasColon: true };
}

// CASE見出し直下の実装可否マーカー🟢🟡🔴を抽出（§2-1）。🔴は待ち先も拾う。
export function caseImplMarker(caseRaw) {
  const lines = String(caseRaw == null ? '' : caseRaw).split('\n');
  let markerLine = null;
  for (let i = 1; i < lines.length; i++) { if (/実装可否/.test(lines[i])) { markerLine = lines[i]; break; } }
  if (!markerLine) {
    let seen = 0;
    for (let i = 1; i < lines.length && seen < 3; i++) {
      if (lines[i].trim() === '') continue;
      seen++;
      if (/[🟢🟡🔴]/u.test(lines[i])) { markerLine = lines[i]; break; }
    }
  }
  if (!markerLine) return { marker: null, detail: null };
  const m = /[🟢🟡🔴]/u.exec(markerLine);
  if (!m) return { marker: null, detail: null };
  const marker = m[0];
  let detail = null;
  if (marker === '🔴') {
    const dm = /待ち先[＝=]\s*([^）)〕】》」』\]\n・]+)/.exec(markerLine) || /🔴[^（(]*[（(]([^）)]+)[）)]/.exec(markerLine);
    if (dm) detail = dm[1].trim();
  }
  return { marker, detail };
}

// 状態語彙の導出（§2-2・便7.1で第3源=実装状態テキストを追加）。導出源の相対順は既存据え置き（挙動互換）＝
//   testStatus/マーカー（現行順）→ 実装状態テキスト（マーカーもtestStatusも無い時のみ）→ 不明。implStatus=implTextVocabの結果。
export function caseStatusVocab(marker, testStatus, markerDetail, implStatus) {
  const ts = testStatus || null;
  if (ts && ts.status) {
    const s = String(ts.status).toLowerCase();
    if (/pass|green|done|implemented|^ok$/.test(s)) return { vocab: '実装済み', source: 'test' };
    if (/partial|一部|stopped|停止/.test(s)) {
      const n = ts.passed != null ? ts.passed : '';
      const t = ts.total != null ? ts.total : '';
      const nm = (n !== '' || t !== '') ? '（' + n + '/' + t + '）' : '';
      return { vocab: 'テスト一部成功・停止中' + nm, source: 'test' };
    }
    if (/debug|デバッグ|fail|red/.test(s)) return { vocab: 'デバッグ中', source: 'test' };
    if (/progress|wip|進行|中/.test(s)) return { vocab: '実装中', source: 'test' };
  }
  if (marker === '🟢') return { vocab: '実装可（未着手）', source: 'marker' };
  if (marker === '🟡') return { vocab: '追加実装が必要', source: 'marker' };
  if (marker === '🔴') return { vocab: '他機能の実装待ち' + (markerDetail ? '（' + markerDetail + '）' : ''), source: 'marker' };
  if (implStatus && implStatus.vocab) return { vocab: implStatus.vocab, source: implStatus.source || 'impl-text' };
  return { vocab: '不明', source: 'none' };
}

// CASE内の「実装状態」テキスト宣言を抽出（便7.1・状態の第3の導出源・Mac server.js と挙動互換）。フィールド行
//   "- **実装状態**: …" に限定（「実装依存」「実装（統合欄）」は拾わない）。value=判定用トークン・paren=最初の括弧補足・raw=原文。
export function caseImplStatusText(caseRaw) {
  const lines = String(caseRaw == null ? '' : caseRaw).split('\n');
  let rest = null;
  for (let i = 1; i < lines.length; i++) {
    const m = /^\s*[-*]\s*\**\s*実装状態\**\s*[:：]\s*(.*)$/.exec(lines[i]);
    if (m) { rest = m[1]; break; }
  }
  if (rest == null) return null;
  rest = rest.trim();
  if (rest === '') return null;
  const raw = rest;
  let value;
  const bt = /^`([^`]*)`/.exec(rest);
  if (bt) value = bt[1];
  else value = rest.split(/[（(〔／]/)[0];
  value = value.replace(/\*\*/g, '').replace(/`/g, '').trim();
  let paren = null;
  const pm = /（([^）]*)）|\(([^)]*)\)|〔([^〕]*)〕/.exec(rest);
  if (pm) paren = pm[1] != null ? pm[1] : (pm[2] != null ? pm[2] : pm[3]);
  return { value, paren, raw };
}

// 依存(前提待ち)行から依存先名を best-effort 抽出（「前提＝X」/「待ち先＝X」の最初の名）。
export function implDepName(depsBucket) {
  const chunks = [];
  for (const seg of ((depsBucket && depsBucket.segments) || [])) for (const l of (seg.lines || [])) chunks.push(String(l));
  const joined = chunks.join('\n');
  const m = /前提[=＝]\s*[①-⑳]?\s*([^〔（(、・。\n＝=]+)/.exec(joined)
    || /待ち先[=＝]\s*([^）)〕】》」』\]\n・]+)/.exec(joined);
  return m ? m[1].trim() : null;
}

// 実装状態テキスト → 状態語彙（便7.1・写像4分岐＋非該当そのまま・Mac server.js と挙動互換）。dep=前提待ち有無（{name}）| null。
export function implTextVocab(implText, dep) {
  if (!implText || !implText.value) return null;
  const v = String(implText.value);
  const paren = implText.paren ? '（' + implText.paren + '）' : '';
  if (/一部未実装/.test(v)) return { vocab: '追加実装が必要' + paren, source: 'impl-text' };
  if (/実装済み/.test(v)) return { vocab: '実装済み' + paren, source: 'impl-text' };
  if (/未実装/.test(v)) {
    if (dep) return { vocab: '他機能の実装待ち' + (dep.name ? '（' + dep.name + '）' : ''), source: 'impl-text' };
    return { vocab: '実装可（未着手）', source: 'impl-text' };
  }
  return { vocab: implText.raw != null ? String(implText.raw) : v, source: 'impl-text' };
}

// 表示変換（§2-1・便7・Mac server.js と挙動互換）: 原典行の記号ノイズ（行頭bullet・原典ラベル・囲み**）を除去し、
// 内容構成（説明文→条件→観察）で並べ替えた表示ユニット列 [{kind:'para'|'bullet', text, level}] を返す。
// 文言は生成しない（除去と並べ替えのみ）。本文中の **太字**・`code` は残す。
export function caseLeadKind(sectionKey, label) {
  if (sectionKey === 'content') return (label && /起きること/.test(label)) ? 'para' : 'bullet';
  if (sectionKey === 'completion' || sectionKey === 'quality' || sectionKey === 'failure' || sectionKey === 'gap') return 'para';
  return 'bullet';
}

export function caseSegmentUnits(seg, sectionKey) {
  const lines = (seg && seg.lines) || [];
  if (!lines.length) return [];
  const units = [];
  const first = String(lines[0]);
  const firstIndent = (/^(\s*)/.exec(first))[1].length;
  const afterBullet = first.replace(/^\s*[-*]\s+/, '');
  const sp = splitCaseLabel(afterBullet);
  const leadKind = caseLeadKind(sectionKey, (seg && seg.label) || sp.label);
  const leadText = sp.inline.trim();
  if (leadText) units.push({ kind: leadKind, text: leadText, level: 0 });
  for (let i = 1; i < lines.length; i++) {
    const ln = String(lines[i]);
    if (ln.trim() === '') continue;
    const bm = /^(\s*)[-*]\s+(.*)$/.exec(ln);
    if (bm) {
      const lvl = Math.max(1, Math.round((bm[1].length - firstIndent) / 2));
      units.push({ kind: 'bullet', text: bm[2].trim(), level: lvl });
    } else if (units.length) {
      units[units.length - 1].text += ' ' + ln.trim();
    } else {
      units.push({ kind: leadKind, text: ln.trim(), level: 0 });
    }
  }
  return units;
}

export function composeCaseSectionDisplay(section) {
  const out = [];
  for (const seg of ((section && section.segments) || [])) {
    for (const u of caseSegmentUnits(seg, section.key)) out.push(u);
  }
  return out;
}

export function composeConcernsDisplay(concerns, sections) {
  const shown = new Set();
  for (const sec of (sections || [])) {
    if (sec.collapse) continue;
    for (const seg of (sec.segments || [])) for (const l of (seg.lines || [])) shown.add(String(l).trim());
  }
  const out = [];
  for (const c of (concerns || [])) {
    const t = String(c).trim();
    if (shown.has(t)) continue;
    out.push(t.replace(/^[-*]\s+/, ''));
  }
  return out;
}

// CASEブロックの合成表示データ（§2-1・記載順0〜10）。原典行を verbatim 保持（バイト非改変）。
export function parseCaseFields(caseRaw, testStatus) {
  const text = String(caseRaw == null ? '' : caseRaw);
  const lines = text.split('\n');
  const header = lines[0] || '';
  const hm = /^(\s*)- \[([ xX])\]\s?(.*)$/.exec(header);
  const checked = hm ? hm[2].toLowerCase() === 'x' : false;
  const headingText = (hm ? hm[3] : header).trim();
  const plain = headingText.replace(/\*\*/g, '').replace(/`/g, '');
  const idM = /(CASE-[0-9A-Za-z_]+)/.exec(plain);
  const caseId = idM ? idM[1] : '';
  const classification = detectCaseClassification(plain);
  const mk = caseImplMarker(text);
  const implText = caseImplStatusText(text);           // 便7.1: 状態の第3の導出源（実装状態テキスト）

  let hang = null;
  for (let i = 1; i < lines.length; i++) { const m = /^(\s+)- /.exec(lines[i]); if (m) { hang = m[1].length; break; } }
  const rawFields = [];
  let cur = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    let isTop = false;
    if (hang != null && /^\s*- /.test(line)) {
      const lead = (/^(\s*)/.exec(line))[1].length;
      if (lead === hang) isTop = true;
    }
    if (isTop) {
      if (cur) rawFields.push(cur);
      const sp = splitCaseLabel(line.slice(hang + 2));
      cur = { label: sp.label, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) rawFields.push(cur);

  const buckets = {};
  const bucket = (t) => {
    if (!buckets[t.key]) buckets[t.key] = { item: t.item, key: t.key, label: t.label || null, collapse: !!t.collapse, segments: [] };
    return buckets[t.key];
  };
  for (const f of rawFields) {
    const t = f.label ? caseFieldTarget(f.label) : { item: 9.5, key: 'other', label: f.label };
    if (t.key === 'marker') continue;
    bucket(t).segments.push({ label: f.label, order: t.order || 0, lines: f.lines });
  }
  if (buckets.content) buckets.content.segments.sort((a, b) => (a.order || 0) - (b.order || 0));
  if (buckets.impl) {
    const dl = [];
    for (const seg of buckets.impl.segments) for (const l of seg.lines) if (/前提待ち(?!でない)/.test(l)) dl.push(l);
    if (dl.length) buckets.deps = { item: 4, key: 'deps', label: null, collapse: false, segments: [{ label: null, order: 0, lines: dl }] };
  }
  // 状態(item1)の導出（便7.1）: マーカー/testStatus（既存の相対順）→ 実装状態テキスト（第3源・依存先名は上の deps から）→ 不明。
  const implStatus = implTextVocab(implText, buckets.deps ? { name: implDepName(buckets.deps) } : null);
  const status = caseStatusVocab(mk.marker, testStatus, mk.detail, implStatus);
  const concerns = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].indexOf('◆') >= 0) concerns.push(lines[i]);

  const ITEM_LABEL = {
    completion: '完成確認', content: '内容', deps: '依存', impl: '実装',
    quality: '品質基準', failure: '失敗の見どころ', gap: '現況ギャップ', other: 'その他',
    target: '対象', basis: '根拠',
  };
  const sections = Object.keys(buckets)
    .map((k) => ({ item: buckets[k].item, key: k, label: ITEM_LABEL[k] || buckets[k].label || k, collapse: buckets[k].collapse, segments: buckets[k].segments }))
    .sort((a, b) => a.item - b.item);
  for (const sec of sections) sec.display = composeCaseSectionDisplay(sec);   // 便7: 掃除済み表示ユニット
  const concernsDisplay = composeConcernsDisplay(concerns, sections);

  return { caseId, checked, headingText, headingPlain: plain, classification, marker: mk.marker, markerDetail: mk.detail, status, sections, concerns, concernsDisplay };
}

// CASEグループ（§2-3）＝原典の分類見出し（### 区切り）単位。blocks は parseSheetBlocks の出力（checked 付き）。
export function groupSheetCases(blocks) {
  const groups = [];
  let cur = null;
  const start = (b) => { cur = { heading: b ? b.heading : '（グループなし）', headingIndex: b ? b.index : -1, level: b ? b.level : 0, cases: [] }; groups.push(cur); };
  for (const b of (blocks || [])) {
    if (b.kind === 'heading') start(b);
    else if (b.kind === 'case') {
      if (!cur) start(null);
      cur.cases.push({ index: b.index, id: b.id, heading: b.heading, checked: !!b.checked });
    }
  }
  return groups.filter((g) => g.cases.length > 0).map((g) => {
    const total = g.cases.length;
    const approvedCount = g.cases.filter((c) => c.checked).length;
    return { heading: g.heading, headingIndex: g.headingIndex, level: g.level, cases: g.cases, total, approvedCount, approved: total > 0 && approvedCount === total };
  });
}

// 文書レベルの承認集計（§2-3・「全グループ承認済み」の集計表示）。
export function sheetApprovalSummary(blocks) {
  const groups = groupSheetCases(blocks);
  const groupTotal = groups.length;
  const groupApproved = groups.filter((g) => g.approved).length;
  const totalCases = groups.reduce((s, g) => s + g.total, 0);
  const approvedCases = groups.reduce((s, g) => s + g.approvedCount, 0);
  return { groups, groupTotal, groupApproved, allApproved: groupTotal > 0 && groupApproved === groupTotal, totalCases, approvedCases };
}

// シナリオ原典のメタ（§4）。frontmatter 優先・無ければ冒頭宣言 blockquote からフォールバック。両形で動く。
export function parseScenarioMeta(text) {
  const src = String(text == null ? '' : text);
  const out = { id: null, layer: null, title: null, target: [], stage: null, status: null, source: 'none' };
  const fmM = /^---\n([\s\S]*?)\n---/.exec(src);
  if (fmM) {
    const fm = fmM[1];
    const get = (k) => { const m = new RegExp('(^|\\n)\\s*' + k + '\\s*:\\s*(.+)').exec(fm); return m ? m[2].trim() : null; };
    out.id = get('id'); out.layer = get('layer'); out.title = get('title');
    out.stage = get('stage'); out.status = get('status');
    const tg = get('target');
    if (tg) {
      if (/^\[.*\]$/.test(tg)) out.target = tg.slice(1, -1).split(',').map((x) => x.replace(/['"]/g, '').trim()).filter(Boolean);
      else out.target = [tg.replace(/['"]/g, '').trim()].filter(Boolean);
    }
    if (out.id || out.layer || out.stage || out.status || out.target.length) out.source = 'frontmatter';
  }
  if (out.stage == null || out.status == null || out.target.length === 0) {
    for (const line of src.split('\n')) {
      if (!/^>/.test(line)) continue;
      if (!/対象[:：]/.test(line) || !/段階[:：]/.test(line)) continue;
      const om = /対象[:：]\s*([^／\/\n]+)/.exec(line);
      const sm = /段階[:：]\s*([^／\/\n]+)/.exec(line);
      const stm = /状態[:：]\s*([^／\/\n]+)/.exec(line);
      const clean = (v) => String(v).replace(/\*\*/g, '').replace(/[（(].*$/, '').trim();
      if (out.target.length === 0 && om) { const v = clean(om[1]); if (v) out.target = [v]; }
      if (out.stage == null && sm) out.stage = clean(sm[1]);
      if (out.status == null && stm) out.status = clean(stm[1]);
      if (out.source === 'none') out.source = 'blockquote';
      break;
    }
  }
  return out;
}

// relatedUnits に一致する test_status エントリを引く（最初の一致・無ければ null）。
export function testStatusFor(relatedUnits, testStatusMap) {
  const m = testStatusMap || {};
  for (const id of (relatedUnits || [])) { if (m[id]) return m[id]; }
  return null;
}

// ===========================================================================
// D-2動作定義・D-3完成定義テスト計画・D-4テスト報告 表示合成（SPEC_V3 §3・build 32 便3）
// 背骨（タイトル/状態/依存/実装/コメント/履歴）はD-1と共通レンダラで流用し、中核項目のみ差し替え。
// 純粋関数（Mac server.js と同名・挙動互換）。原典mdのバイトは一切変更しない。
// ===========================================================================

// テスト種類語彙（§3・凡例宣言・表示のみ）。境界難所は別フラグ。
export const TEST_KIND_VOCAB = ['全数', '煙', '回帰', '影響', '凍結'];

// --- Markdownテーブル抽出（D-3構造表・D-4リスト・定義済みテスト数の機械カウント） ---
export function splitTableRow(line) {
  let s = String(line == null ? '' : line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
export function isTableSeparator(line) {
  const s = String(line == null ? '' : line);
  if (s.indexOf('|') < 0) return false;
  const cells = splitTableRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}
export function parseMarkdownTables(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    if (i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(lines[i]);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        if (!/^\s*\|.*\|\s*$/.test(lines[j]) || isTableSeparator(lines[j])) break;
        rows.push(splitTableRow(lines[j]));
      }
      tables.push({ startLine: i, endLine: j - 1, header, rows });
      i = j - 1;
    }
  }
  return tables;
}

// --- D-2 動作定義（確認型・単位=動作）。テンプレ形/実在形の2書式に対応（§3抽出写像） ---
export const BEHAVIOR_CORE_ORDER = ['in', 'proc', 'out', 'obs', 'accept', 'cmp'];
export const BEHAVIOR_CORE_LABEL = { in: '入力', proc: '処理', out: '出力', obs: '観察点との対応', accept: '検収形態との対応', cmp: 'CMP関与' };
export function behaviorLabelKey(label) {
  const L = String(label == null ? '' : label).trim();
  if (/^入力/.test(L)) return 'in';
  if (/処理/.test(L)) return 'proc';
  if (/^出力/.test(L)) return 'out';
  if (/^観察/.test(L)) return 'obs';
  if (/^検収/.test(L)) return 'accept';
  if (/CMP/.test(L)) return 'cmp';
  return null;
}
export function parseLabeledBullets(blockLines) {
  const fields = [];
  let cur = null;
  for (const line of (blockLines || [])) {
    const m = /^(\s{0,2})-\s+(.*)$/.exec(line);
    if (m) {
      if (cur) fields.push(cur);
      const sp = splitCaseLabel(m[2]);
      cur = { label: sp.hasColon ? sp.label : null, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) fields.push(cur);
  return fields;
}
export function extractCaseRefs(headingTitle, tail) {
  const out = [];
  const push = (s) => { const v = String(s).trim(); if (v && !out.includes(v)) out.push(v); };
  const scan = (str) => { const re = /CASE-[0-9A-Za-z_]+/g; let m; while ((m = re.exec(String(str || ''))) !== null) push(m[0]); };
  const t = String(headingTitle || '');
  const arrowIdx = t.search(/←/);
  scan(arrowIdx >= 0 ? t.slice(arrowIdx) : t);
  const cm = /covers\s*[:：]\s*\[([^\]]*)\]/.exec(String(tail || ''));
  if (cm) scan(cm[1]);
  return out;
}
export function parseBehaviorDoc(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const h = /^###\s+(.*)$/.exec(L);
    if (h && (/←\s*SC-F/.test(h[1]) || /CASE-\d/.test(h[1]))) { starts.push({ line: i, title: h[1].trim(), tail: '' }); continue; }
    const b = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(L);
    if (b) {
      const name = b[1].trim();
      const tail = b[2] || '';
      if (/^(BD-|OP-)/.test(name) || /covers\s*[:：]/.test(tail)) starts.push({ line: i, title: name, tail });
    }
  }
  if (!starts.length) return { behaviors: [] };
  const behaviors = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const endLine = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const blockLines = [];
    for (let j = s.line + 1; j < endLine; j++) {
      if (/^#{1,6}\s/.test(lines[j])) break;
      if (/^\*\*(BD-|OP-)/.test(lines[j])) break;
      blockLines.push(lines[j]);
    }
    const caseRefs = extractCaseRefs(s.title, s.tail).map((c) => ({ case: c }));
    const idM = /^(BD-[A-Z0-9_-]+|OP-[A-Z0-9_-]+)/.exec(s.title);
    const id = idM ? idM[1] : (caseRefs[0] ? caseRefs[0].case : (s.title.split(/\s+/)[0] || ''));
    let name = s.title;
    if (idM) name = s.title.slice(idM[1].length).trim();
    else if (name.search(/←/) >= 0) name = name.slice(0, name.search(/←/)).trim();
    const fields = parseLabeledBullets(blockLines);
    const core = {};
    const others = [];
    for (const f of fields) {
      const key = f.label ? behaviorLabelKey(f.label) : null;
      const text0 = f.lines.join('\n').replace(/^\s{0,2}-\s+/, '').replace(/\s+$/, '');
      if (key) { if (!core[key]) core[key] = text0; }
      else if (f.label) others.push({ label: f.label, text: text0 });
    }
    const sections = [];
    for (const key of BEHAVIOR_CORE_ORDER) if (core[key] != null) sections.push({ key, core: true, label: BEHAVIOR_CORE_LABEL[key], text: core[key] });
    for (const o of others) sections.push({ key: 'other', core: false, label: o.label, text: o.text });
    behaviors.push({ id, name, caseRefs, sections });
  }
  return { behaviors };
}

// --- D-3 テスト計画: 構造抽出＋計画数⇄定義済みテスト数の機械一致 ---
export function parseTestPlan(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (/テスト計画/.test(lines[i])) { startIdx = i; break; } }
  if (startIdx < 0) return { present: false };
  const block = [];
  const startHeadM = /^(#{1,6})\s/.exec(lines[startIdx]);
  for (let j = startIdx + 1; j < lines.length && block.length < 60; j++) {
    const hm = /^(#{1,6})\s/.exec(lines[j]);
    if (hm) { if (!startHeadM || hm[1].length <= startHeadM[1].length) break; }
    block.push(lines[j]);
  }
  const blockText = block.join('\n');
  const fields = parseLabeledBullets(block);
  const byLabel = (re) => {
    for (const f of fields) if (f.label && re.test(f.label)) {
      const joined = f.lines.join(' ');
      const ci = joined.search(/[:：]/);
      return (ci >= 0 ? joined.slice(ci + 1) : joined.replace(/^\s*-\s+/, '')).trim();
    }
    return null;
  };
  const totalLine = byLabel(/^全数/);
  const doLine = byLabel(/^実施/);
  let planCount = null, planExpr = null;
  if (totalLine) {
    planExpr = totalLine;
    const nums = []; const re = /[＝=]\s*([0-9]+)/g; let m;
    while ((m = re.exec(totalLine)) !== null) nums.push(parseInt(m[1], 10));
    if (nums.length) planCount = nums[nums.length - 1];
  }
  const mode = doLine ? (/全数/.test(doLine) ? '全数' : (/抽出/.test(doLine) ? '抽出' : null)) : null;
  let declaredDefined = null;
  if (byLabel(/設定照合/)) { const dm = /定義済み[^0-9]*([0-9]+)|([0-9]+)\s*(?:件|本|個)/.exec(byLabel(/設定照合/)); if (dm) declaredDefined = parseInt(dm[1] || dm[2], 10); }
  const countedDefined = countDefinedTests(src);
  const definedCount = declaredDefined != null ? declaredDefined : countedDefined;
  const definedSource = declaredDefined != null ? 'declared' : (countedDefined != null ? 'counted' : null);
  let consistency = null;
  if (planCount != null && definedCount != null) consistency = { ok: planCount === definedCount, plan: planCount, defined: definedCount, diff: definedCount - planCount };
  return {
    present: true, planExpr, planCount, mode,
    reason: mode === '抽出' ? byLabel(/^理由/) : null,
    method: mode === '抽出' ? byLabel(/^方法/) : null,
    discovery: mode === '抽出' ? byLabel(/失敗発見力/) : null,
    axisRef: byLabel(/要素の照合/), sampleRef: byLabel(/^標本/),
    definedCount, definedSource, consistency, blockText,
  };
}
export function countDefinedTests(text) {
  const tables = parseMarkdownTables(text);
  let total = 0, found = false;
  for (const t of tables) {
    const h0 = String((t.header || [])[0] || '');
    const isTestTable = /TESTID/i.test(h0) || /テスト\s*ID/.test(h0) || /テストケース/.test(h0);
    if (!isTestTable) continue;
    found = true;
    for (const r of t.rows) {
      const c0 = String((r || [])[0] || '');
      if (c0 === '') continue;
      if (/`/.test(c0) || /[A-Z]{2,}[#\-]|CASE-|D-\d/.test(c0)) total++;
    }
  }
  return found ? total : null;
}

// --- D-4 テスト報告（確認型・リスト形式）。実在0本＝fixture固定の器。 ---
export const REPORT_COLS = [
  { key: 'scenario', re: /シナリオ/ }, { key: 'completion', re: /完成定義/ },
  { key: 'testcase', re: /テストケース/ }, { key: 'testId', re: /テスト\s*ID|TESTID/i },
  { key: 'artifact', re: /提出物/ }, { key: 'kind', re: /種類/ },
  { key: 'result', re: /結果/ }, { key: 'verdict', re: /照合/ },
];
export function reportResultKind(result) {
  const s = String(result == null ? '' : result);
  if (/失敗|不合格|fail|red|赤|×|✗|✕|NG/i.test(s)) return 'fail';
  if (/成功|合格|pass|green|緑|○|◯|✓|OK/i.test(s)) return 'pass';
  return 'other';
}
export function reportExecuted(result) {
  const s = String(result == null ? '' : result).trim();
  return s !== '' && !/^(—|-|未実行|未|—+|n\/a|na)$/i.test(s);
}
export function parseTestReport(text) {
  const tables = parseMarkdownTables(text);
  let target = null, colMap = null;
  for (const t of tables) {
    const map = {};
    (t.header || []).forEach((h, idx) => { for (const c of REPORT_COLS) if (map[c.key] == null && c.re.test(String(h))) map[c.key] = idx; });
    const primary = ['scenario', 'completion', 'testcase', 'testId', 'artifact'].filter((k) => map[k] != null).length;
    if (primary >= 3) { target = t; colMap = map; break; }
  }
  if (!target) return { present: false, rows: [], groups: [], summary: { planned: 0, executed: 0, passed: 0, failed: 0 } };
  const cell = (r, key) => (colMap[key] != null ? String((r || [])[colMap[key]] || '').trim() : '');
  const rows = target.rows.map((r) => {
    const result = cell(r, 'result');
    const scenario = cell(r, 'scenario'); const testcase = cell(r, 'testcase'); const testId = cell(r, 'testId');
    const caseM = /CASE-[0-9A-Za-z_]+/.exec(scenario + ' ' + testcase + ' ' + testId);
    return {
      scenario, completion: cell(r, 'completion'), testcase, testId,
      artifact: cell(r, 'artifact'), kind: cell(r, 'kind'), result, verdict: cell(r, 'verdict'),
      resultKind: reportResultKind(result), executed: reportExecuted(result),
      caseId: caseM ? caseM[0] : (scenario || testcase || '（未分類）'),
    };
  });
  const gmap = new Map();
  for (const row of rows) { const k = row.caseId; if (!gmap.has(k)) gmap.set(k, []); gmap.get(k).push(row); }
  const tally = (list) => ({
    planned: list.length,
    executed: list.filter((x) => x.executed).length,
    passed: list.filter((x) => x.resultKind === 'pass').length,
    failed: list.filter((x) => x.resultKind === 'fail').length,
  });
  const groups = [...gmap.entries()].map(([caseId, list]) => Object.assign({ caseId, rows: list }, tally(list)));
  return { present: true, columns: Object.keys(colMap), rows, groups, summary: tally(rows) };
}

// ===========================================================================
// 状態表現基盤（SPEC_V3 §1-1・§1-2・v2.10 / build 30）— 純粋関数（Mac server.js と同名・挙動互換）
// ===========================================================================

// 状態アイコン（凡例宣言語彙・§1-1a）。凡例に無い記号は画面に出さない。
export const DOC_STATE_ICON = { new: '🆕', reviewing: '◐', done: '✓', reapprove: '↺' };

// 決定的hash（FNV-1a 32bit hex）。Mac(Node)/モバイル(browser) で同一結果（charCodeAt=UTF-16単位・Math.imul）。
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 文書状態導出（§1-1a）。開封・読了の記録はクライアント localStorage（正本へ書かない）。
export function deriveDocState(entry, record, opts) {
  const e = entry || {};
  const kind = e.kind || 'general';
  const rec = record || null;
  const cur = e.currentHash;
  const opened = !!(rec && rec.seenHash != null && rec.seenHash === cur);
  const newDays = (opts && opts.newBadgeDays != null) ? opts.newBadgeDays : 7;
  if (kind === 'approval') {
    const total = e.checkboxTotal || 0;
    const checked = e.checkboxChecked || 0;
    const allChecked = total > 0 && checked === total;
    const everDone = !!(rec && rec.doneHash != null);
    if (everDone) {
      if (rec.doneHash !== cur) return 'reapprove';
      return allChecked ? 'done' : 'reapprove';
    }
    if (allChecked) return 'done';
    return opened ? 'reviewing' : 'new';
  }
  if (kind === 'confirm') {
    const everDone = !!(rec && rec.doneHash != null);
    if (everDone) return rec.doneHash === cur ? 'done' : 'reapprove';
    return opened ? 'reviewing' : 'new';
  }
  const days = e.updatedDaysAgo;
  return (typeof days === 'number' && days <= newDays) ? 'new' : null;
}

// 開封/読了の共有ストア（便6・§5b-1）: PC⇄モバイル同期。値={seenHash,doneHash,ts}・文書ごと最終更新（ts）優先。
// マージは純関数（Mac/モバイル同名・挙動互換）。ts が大きい方（同値は incoming）を採用。
export function mergeViewStateRecord(store, key, rec) {
  const s = (store && typeof store === 'object') ? store : {};
  if (!key || !rec) return { ...s };
  const cur = s[key];
  if (!cur || (Number(rec.ts) || 0) >= (Number(cur.ts) || 0)) return { ...s, [key]: rec };
  return { ...s };
}
export function mergeViewStateStores(base, incoming) {
  const out = { ...((base && typeof base === 'object') ? base : {}) };
  const inc = (incoming && typeof incoming === 'object') ? incoming : {};
  for (const k of Object.keys(inc)) {
    const cur = out[k];
    const it = inc[k];
    if (!cur || (Number(it && it.ts) || 0) >= (Number(cur.ts) || 0)) out[k] = it;
  }
  return out;
}

// 統合インボックス 種別チップ（便6・§5b-2）。承認/確認=Sheet種別、裁定=decisionカード、検収=report/reviewカード。
export const INBOX_TYPE_CHIPS = [
  { id: 'all', label: 'すべて' },
  { id: 'approval', label: '承認' },
  { id: 'confirm', label: '確認' },
  { id: 'decision', label: '裁定' },
  { id: 'inspection', label: '検収' },
];
export function inboxRowType(row) {
  if (!row) return 'other';
  if (row.kind === 'sheet') {
    const dk = row.ref && row.ref.docKind;
    return dk === 'approval' ? 'approval' : (dk === 'confirm' ? 'confirm' : 'other');
  }
  const t = normalizeType(row.ref && row.ref.type);
  if (t === 'decision') return 'decision';
  if (t === 'report' || t === 'review') return 'inspection';
  return 'other';
}
export function filterInboxRowsByType(rows, typeId) {
  if (!typeId || typeId === 'all') return rows || [];
  return (rows || []).filter((r) => inboxRowType(r) === typeId);
}
// サブタグチップ（便6・§5b-2）: すべて＋各サブカテゴリ（平易名）。
export function subtagChips(tag) {
  const chips = [{ id: 'all', label: 'すべて' }];
  ((tag && tag.subcategories) || []).forEach((sc) => chips.push({ id: sc.id, label: sc.label }));
  return chips;
}

// 要旨キャッシュ照合（§1-1b）。summariesMap: {key:{hash,summary}}。key=原典の相対パス。
export function summaryFor(key, currentHash, summariesMap) {
  const m = summariesMap || {};
  const entry = m[key];
  if (!entry || entry.summary == null) return { summary: null, stale: false, present: false };
  return { summary: String(entry.summary), stale: entry.hash !== currentHash, present: true };
}

// ===========================================================================
// 便8（§5d）変換キャッシュの表示層 — 純関数（Mac server.js と同名・挙動互換・アプリは生成しない）
// docHash(sha256) の計算は program.js（SubtleCrypto・async）が担い、照合そのものは純関数で分離。
// ===========================================================================

// 画面出力の md記号ゼロを保証（§5d-5）。renderInlineMd の可視テキストと一致する純関数（Mac と同名）。
export function stripInlineMdNoise(text) {
  return String(text == null ? '' : text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '');
}

// 変換文の前処理（§5d-3 受け側保険）: 行頭bullet・原典ラベル語を剥がす（インライン**/`は保持）。
const TRANSFORM_LABEL_RE = /^\s*(内容|完成確認|依存|実装|品質基準|失敗の見どころ|状態|由来|受入の種|対象|完成条件|前提|起きること|観察)\s*[:：]\s*/;
export function scrubTransformText(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/^\s*[-*+]\s+/, '');
  s = s.replace(TRANSFORM_LABEL_RE, '');
  return s;
}

// docHash 照合（§5d-2）。absent（無/非オブジェクト）／stale（docHash欠落 or 不一致）／fresh（一致）。
export function resolveTransform(transformJson, currentDocHash) {
  if (!transformJson || typeof transformJson !== 'object') {
    return { state: 'absent', docSummary: null, generated: null, cases: {}, blocks: {} };
  }
  const docHash = transformJson.docHash != null ? String(transformJson.docHash) : null;
  const fresh = docHash != null && currentDocHash != null && docHash === String(currentDocHash);
  return {
    state: fresh ? 'fresh' : 'stale',
    docSummary: transformJson.docSummary != null ? String(transformJson.docSummary) : null,
    generated: transformJson.generated != null ? String(transformJson.generated) : null,
    cases: (transformJson.cases && typeof transformJson.cases === 'object') ? transformJson.cases : {},
    blocks: (transformJson.blocks && typeof transformJson.blocks === 'object') ? transformJson.blocks : {},
  };
}

const TRANSFORM_SECTION_META = {
  completion: { item: 2, key: 'completion', label: '完成確認' },
  content:    { item: 3, key: 'content',    label: '内容' },
  deps:       { item: 4, key: 'deps',       label: '依存' },
  impl:       { item: 5, key: 'impl',       label: '実装' },
  quality:    { item: 6, key: 'quality',    label: '品質基準' },
  failure:    { item: 7, key: 'failure',    label: '失敗の見どころ' },
};

// fresh のとき、1ケースの変換文を caseFields へ差し込む（§5d-2・Mac applyCaseTransform と挙動互換）。純関数。
export function applyCaseTransform(caseFields, resolved, caseId) {
  if (!caseFields || !resolved || resolved.state !== 'fresh') return caseFields;
  const entry = resolved.cases && resolved.cases[caseId];
  const f = entry && entry.fields;
  if (!f || typeof f !== 'object') return caseFields;
  const secByKey = {};
  (caseFields.sections || []).forEach((s) => { secByKey[s.key] = s; });
  const setDisplay = (key, units) => {
    if (!units.length) return;
    if (secByKey[key]) { secByKey[key].display = units; secByKey[key].fromTransform = true; }
    else {
      const meta = TRANSFORM_SECTION_META[key];
      const sec = { item: meta.item, key, label: meta.label, collapse: false, segments: [], display: units, fromTransform: true };
      caseFields.sections.push(sec);
      secByKey[key] = sec;
    }
  };
  const para = (t) => ({ kind: 'para', text: scrubTransformText(String(t)), level: 0 });
  const bullet = (t) => ({ kind: 'bullet', text: scrubTransformText(String(t)), level: 1 });
  if (f.status_note != null) caseFields.statusNote = scrubTransformText(String(f.status_note));
  const contentUnits = [];
  if (f.content != null) contentUnits.push(para(f.content));
  (Array.isArray(f.conditions) ? f.conditions : []).forEach((c) => contentUnits.push(bullet(c)));
  (Array.isArray(f.observations) ? f.observations : []).forEach((c) => contentUnits.push(bullet(c)));
  setDisplay('content', contentUnits);
  if (f.completion != null) setDisplay('completion', [para(f.completion)]);
  if (f.deps != null) setDisplay('deps', [para(f.deps)]);
  if (f.impl != null) setDisplay('impl', [para(f.impl)]);
  if (f.quality != null) setDisplay('quality', [para(f.quality)]);
  if (f.failure != null) setDisplay('failure', [para(f.failure)]);
  caseFields.sections.sort((a, b) => a.item - b.item);
  return caseFields;
}

// 関連単位の機械抽出（§1-2b）。ファイル名（SC-[JFC]_接頭辞を剥いだ本体）＋frontmatter target から。
export function extractRelatedUnits(fileName, text) {
  const ids = [];
  const push = (v) => { const s = String(v || '').trim(); if (s && !ids.includes(s)) ids.push(s); };
  const base = String(fileName || '').replace(/^.*\//, '').replace(/\.md$/i, '');
  const stripped = base.replace(/^SC-[JFC]_?/, '');
  if (stripped) push(stripped);
  const src = String(text || '');
  const fmM = /^---\n([\s\S]*?)\n---/.exec(src);
  if (fmM) {
    const t = /(^|\n)\s*target\s*:\s*(.+)/.exec(fmM[1]);
    if (t) {
      let raw = t[2].trim();
      if (/^\[.*\]$/.test(raw)) raw.slice(1, -1).split(',').forEach((x) => push(x.replace(/['"]/g, '').trim()));
      else push(raw.replace(/['"]/g, '').split(/\s+/)[0]);
    }
  }
  return ids;
}

// 解除インパクト概算（§1-2b・フロンティア逆引きの再利用）。relatedIds を deps に持つ作業単位の総数。
export function unlockImpact(relatedIds, reverseClosureMap) {
  const map = reverseClosureMap || {};
  const set = new Set();
  for (const id of (relatedIds || [])) {
    const arr = map[id];
    if (Array.isArray(arr)) for (const d of arr) set.add(d);
  }
  return set.size;
}

// 統合インボックス対象カード（§1-2c）。AI発（claude-to-user）でユーザーアクションが要る状態。
export const INBOX_CARD_STATUSES = ['new', 'annotated', 'review', 'done-proposed'];
export function cardNeedsUserAction(card) {
  if (!card) return false;
  if (card.direction !== 'claude-to-user') return false;
  return INBOX_CARD_STATUSES.includes(card.status);
}

// 統合インボックス合成（§1-2c）。未処理Sheet（unresolved=true）＋要ユーザーアクションカードを一列に統合し
// 解除インパクト降順（同率は更新日降順）。空ソースでも壊れない。
export function buildInbox(sheetItems, cards) {
  const rows = [];
  for (const s of (sheetItems || [])) {
    if (!s || !s.unresolved) continue;
    rows.push({ kind: 'sheet', source: s.source, file: s.file, title: s.title || s.file, subKind: s.docKind || null, impact: s.impact || 0, updated: s.updated || '', ref: s });
  }
  for (const c of (cards || [])) {
    if (!cardNeedsUserAction(c)) continue;
    rows.push({ kind: 'card', id: c.id, title: c.title || c.id, status: c.status, type: c.type || null, impact: c.impact || 0, updated: c.updated || c.created || '', ref: c });
  }
  rows.sort((a, b) => {
    if ((b.impact || 0) !== (a.impact || 0)) return (b.impact || 0) - (a.impact || 0);
    return String(b.updated || '').localeCompare(String(a.updated || ''));
  });
  return rows;
}

// エントリ単位の docKind（scenario ソースは SC-J=display[承認対象外]・SC-F/C=approval を per-file 判定・§1-2a）。
export function entryDocKind(subcatKind, fileName) {
  const base = String(fileName || '').replace(/^.*\//, '');
  if (/^SC-J/.test(base)) return 'display';
  return subcatKind || 'confirm';
}

// エントリの共通列（§1-2b）を本文テキストから機械導出（純関数・Dropbox取得は呼び出し側）。
//   meta: { source, file, sub, subcatKind, flow, mtimeMs }。summaries/reverseClosureMap は任意。
export function enrichSheetEntryFromText(text, meta, summaries, reverseClosureMap, nowMs) {
  const m = meta || {};
  const cs = countSheetCheckboxes(text || '');
  const currentHash = hashText(text || '');
  const docKind = entryDocKind(m.subcatKind, m.file);
  const key = (m.sub ? m.sub + '/' : '') + (m.file || '');
  const sm = summaryFor(key, currentHash, summaries);
  const relatedUnits = extractRelatedUnits(m.file, text || '');
  const impact = unlockImpact(relatedUnits, reverseClosureMap);
  const heading = ((/^#\s+(.*)$/m.exec(text || '') || [])[1] || '').trim();
  const allChecked = cs.total > 0 && cs.unchecked === 0;
  const unresolved = docKind === 'approval' ? !allChecked : (docKind === 'display' ? false : true);
  const now = (nowMs != null) ? nowMs : Date.now();
  const updatedDaysAgo = m.mtimeMs ? Math.max(0, Math.floor((now - m.mtimeMs) / 86400000)) : null;
  let updated = '';
  if (m.mtimeMs) { const d = new Date(m.mtimeMs); const p = (n) => String(n).padStart(2, '0'); updated = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  // CASEグループ承認集計（§2-3・2層一覧用）＋シナリオメタ（§4）。
  let approval = { groups: [], allApproved: false };
  try { approval = sheetApprovalSummary(parseSheetBlocks(parseCard(text || '').body, m.numbered)); } catch { /* 空でも壊れない */ }
  const groupSummaries = approval.groups.map((g) => ({ heading: g.heading, headingIndex: g.headingIndex, total: g.total, approvedCount: g.approvedCount, approved: g.approved }));
  const scenarioMeta = parseScenarioMeta(text || '');
  // RDSナビ（§4・便4）: rds ソースのみ 💬未対応数を機械count（他ソースは null＝非表示）。
  let rdsUnaddressed = null;
  if (m.source === 'rds') { try { rdsUnaddressed = parseRdsComments(text || '').unaddressedCount; } catch { rdsUnaddressed = null; } }
  return {
    source: m.source, file: m.file, path: key,
    title: heading || m.file, heading,
    docKind, flow: m.flow || null,
    checkboxTotal: cs.total, checkboxChecked: cs.checked,
    currentHash, updatedDaysAgo, updated,
    summary: sm.summary, summaryPresent: sm.present, stale: sm.stale,
    relatedUnits, impact, unresolved,
    groups: groupSummaries, docApproved: approval.allApproved,
    stage: scenarioMeta.stage || null, statusDecl: scenarioMeta.status || null, layer: scenarioMeta.layer || null,
    rdsUnaddressed,
  };
}

// RDSナビ（§4・便4）— 純関数（server と同名・挙動互換）。原典は一切変更しない（読み取り表示のみ）。
// 💬未対応＝「💬マーカーの後にユーザー記入内容があり、かつ その💬から次の💬（または次の `## ` 見出し境界／EOF）
// までに ↳応答が無い」もの。空の💬スロット（記入内容なし）＝記入待ちは未対応に数えない（偽装しない）。
//   戻り: { total, unaddressedCount, unaddressed:[{ line, blockIndex, reqId, heading, snippet }] }
export function parseRdsComments(text) {
  const body = parseCard(String(text == null ? '' : text)).body;
  const lines = body.split('\n');
  const blocks = parseSheetBlocks(body, true);
  const lineOffset = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) { lineOffset.push(off); off += lines[i].length + 1; }
  const blockOf = (lineIdx) => {
    const o = lineOffset[lineIdx];
    for (let k = blocks.length - 1; k >= 0; k--) { if (o >= blocks[k].start) return blocks[k].index; }
    return -1;
  };
  let heading = null, reqId = null, pending = null, total = 0;
  const unaddressed = [];
  const finalize = () => { if (pending) { unaddressed.push(pending); pending = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = /^##\s+(.*)$/.exec(line);
    if (hm) { finalize(); heading = hm[1].trim(); const rm = /REQ-[A-Za-z0-9_-]+/.exec(heading); reqId = rm ? rm[0] : null; continue; }
    const ci = line.indexOf('💬');
    if (ci >= 0) {
      finalize();
      let after = line.slice(ci + '💬'.length);
      const note = /^\s*[（(][^）)]*[）)]/.exec(after);
      if (note) after = after.slice(note[0].length);
      const content = after.replace(/^[:：\s]+/, '').trim();
      if (content !== '') { total++; pending = { line: i, blockIndex: blockOf(i), reqId, heading, snippet: content.length > 80 ? content.slice(0, 80) + '…' : content }; }
      else pending = null;
      continue;
    }
    if (/^\s*↳/.test(line)) { pending = null; continue; }
  }
  finalize();
  return { total, unaddressedCount: unaddressed.length, unaddressed };
}

// ===========================================================================
// 進捗タブ（便5・build 34・SPEC_V3 §5・PROGRESS_TAB_UI_DRAFT）純関数群
// Mac server.js と同名・挙動互換。機能＞実装単位＞CASEグループの3層を
// IMPL_REGISTRY.requestedBy → SC-F CASE 結合で構築。状態5色は導出できる源からのみ導出。
// スコープ境界: 依存精密版・解除インパクト精密版・フロンティア算出・GO判定は本便で作らない
//   （◆辺スキーマ後）。出発可(ready)は生成器の derived.frontier を「読む」だけ。
// ===========================================================================

export const BOARD_STATE_ORDER = ['done', 'running', 'stopped', 'waiting', 'unappr', 'unknown'];
export const BOARD_STATE_META = {
  done:    { name: '実装済み',       color: 'green' },
  running: { name: '実装中',         color: 'blue' },
  stopped: { name: '停止',           color: 'red' },
  waiting: { name: '出発待ち',       color: 'yellow' },
  unappr:  { name: '未実装（未承認）', color: 'gray' },
  unknown: { name: '不明',           color: 'unknown' },
};

export function parseCaseNums(str) {
  const s = String(str == null ? '' : str);
  const nums = new Set();
  const re = /CASE-\s*0*(\d+)((?:\s*[/／]\s*0*\d+)*)(?:\s*[〜～\-–—]\s*(?:CASE-\s*)?0*(\d+))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const a = parseInt(m[1], 10); nums.add(a);
    if (m[2]) for (const p of (m[2].match(/\d+/g) || [])) nums.add(parseInt(p, 10));
    if (m[3] != null) { const b = parseInt(m[3], 10); if (b >= a && b - a < 200) { for (let n = a; n <= b; n++) nums.add(n); } else nums.add(b); }
  }
  return [...nums].sort((x, y) => x - y);
}
export function parseRequestedByEntry(entry) {
  const s = String(entry == null ? '' : entry);
  const m = /SC-F_([A-Z0-9_]+)/.exec(s);
  const scenario = m ? m[1] : null;
  return { scenario, cases: scenario ? parseCaseNums(s) : [] };
}
export function unitScenarioRefs(unit) {
  return ((unit && unit.requestedBy) || []).map(parseRequestedByEntry).filter((r) => r.scenario);
}
export function parseImplRegistry(text) {
  let data = null;
  try { data = JSON.parse(String(text == null ? '' : text)); } catch { return { ok: false, units: [], frontier: [], byState: {}, byKind: {}, meta: {} }; }
  const units = Array.isArray(data && data.units) ? data.units : [];
  let frontier = [];
  try { frontier = (data.derived.frontier.units || []).map((u) => u.id).filter(Boolean); } catch { frontier = []; }
  const byState = {}, byKind = {};
  for (const u of units) { byState[u.state] = (byState[u.state] || 0) + 1; byKind[u.kind] = (byKind[u.kind] || 0) + 1; }
  return { ok: units.length > 0, units, frontier, byState, byKind, meta: (data && data.meta) || {} };
}
export function buildScenarioFeature(code, text) {
  const p = parseCard(String(text == null ? '' : text));
  const meta = parseScenarioMeta(String(text == null ? '' : text));
  const blocks = parseSheetBlocks(p.body, false);
  const groups = [];
  let cur = null;
  const caseByNum = new Map();
  for (const b of blocks) {
    if (b.kind === 'heading') {
      cur = { id: code + '::' + b.index, heading: b.heading, classification: detectCaseClassification(b.heading), cases: [] };
    } else if (b.kind === 'case') {
      const cm = /CASE-0*(\d+)/.exec(b.heading || '');
      if (!cm) continue;
      const num = parseInt(cm[1], 10);
      if (!cur) cur = { id: code + '::top', heading: '（グループなし）', classification: null, cases: [] };
      const raw = p.body.slice(b.start, b.end);
      const mk = caseImplMarker(raw);
      const cls = cur.classification || detectCaseClassification(b.heading);
      const c = { num, caseId: 'CASE-' + cm[1], checked: !!b.checked, marker: mk.marker, classification: cls, groupId: cur.id, groupHeading: cur.heading };
      cur.cases.push(c);
      caseByNum.set(num, c);
      if (groups.indexOf(cur) < 0) groups.push(cur);
    }
  }
  return { code, name: meta.title || code, groups: groups.filter((g) => g.cases.length > 0), caseByNum, source: text != null };
}
export function caseImplState(coverUnits) {
  if (!coverUnits || !coverUnits.length) return 'none';
  const st = coverUnits.map((u) => u.state);
  if (st.every((s) => s === '完了')) return 'done';
  if (st.some((s) => s === '進行中' || s === '完了')) return 'progress';
  if (st.some((s) => s === '待ち' || s === '未着手')) return 'pending';
  return 'unknown';
}
export function deriveUnitColor(regState, scenN, scenM, laneActive, testColor) {
  if (testColor === 'red') return 'stopped';
  if (regState === '完了') return 'done';
  if (regState === '進行中' || laneActive) return 'running';
  if (scenM > 0 && scenN === 0) return 'unappr';
  if (regState === '待ち' || regState === '未着手') return 'waiting';
  return 'unknown';
}
export function deriveGroupColor(scenN, scenM, implDone, total, unitState, laneActive, testRed) {
  if (testRed) return 'stopped';
  if (total > 0 && implDone === total) return 'done';
  if (unitState === '完了') return 'done';
  if (unitState === '進行中' || laneActive) return 'running';
  if (scenM > 0 && scenN === 0) return 'unappr';
  if (scenN > 0 || unitState === '待ち' || unitState === '未着手') return 'waiting';
  return 'unknown';
}
export function caseSetMetrics(cases, coverage, code) {
  let scenN = 0, implDone = 0;
  const total = (cases || []).length;
  for (const c of (cases || [])) {
    if (c.checked) scenN++;
    const cov = coverage.get(code + '#' + c.num) || [];
    if (caseImplState(cov) === 'done') implDone++;
  }
  return { scenN, scenM: total, implDone, implTotal: total };
}
export function stateMiniExplain(colorKey, ctx) {
  const c = ctx || {};
  const why = [], next = [];
  const gold = c.golden && c.golden !== 'なし' ? '（GOLDEN被覆あり）' : '';
  if (colorKey === 'done') { why.push('実装単位=完了' + gold); }
  else if (colorKey === 'running') { why.push('実装単位=進行中（作業中）'); next.push('テスト緑で実装済みへ'); }
  else if (colorKey === 'stopped') { why.push('テストが赤（停止）'); next.push('テスト緑で回復'); }
  else if (colorKey === 'waiting') {
    if (c.scenM > 0) why.push('シナリオ承認 ' + (c.scenN || 0) + '/' + c.scenM + '・実装証跡なし（' + (c.state || '') + '）');
    else why.push('実装未着手（' + (c.state || '') + '）');
    next.push(c.ready ? '出発可（依存充足）→ 実装着手で実装中へ' : '実装着手で実装中へ');
  } else if (colorKey === 'unappr') { why.push('シナリオ未承認（承認 ' + (c.scenN || 0) + '/' + (c.scenM || 0) + '）＝走行資格なし'); next.push('残りCASEの承認で走行資格が付く'); }
  else { why.push('導出源が揃わない（' + (c.state || '') + '）'); }
  const depLines = ((c.deps) || []).filter((d) => d.state !== '完了').map((d) => '[依存] ' + d.id + (d.name ? '（' + String(d.name).slice(0, 24) + '）' : '') + ' → ' + (d.state || '—') + '解消待ち');
  return { why: why.join('・'), next: next.join('・'), depLines };
}
export function buildProgressBoard(inp) {
  const reg = parseImplRegistry(inp && inp.registryText);
  const scenarios = (inp && inp.scenarios) || [];
  const completionByFeature = (inp && inp.completionByFeature) || {};
  const testStatusMap = (inp && inp.testStatusMap) || {};
  const frontierSet = new Set(reg.frontier);
  const feats = new Map();
  for (const sc of scenarios) feats.set(sc.code, buildScenarioFeature(sc.code, sc.text));
  const unitById = new Map(reg.units.map((u) => [u.id, u]));

  const coverage = new Map();
  for (const u of reg.units) for (const r of unitScenarioRefs(u)) {
    const f = feats.get(r.scenario); if (!f) continue;
    for (const n of r.cases) {
      if (!f.caseByNum.has(n)) continue;
      const k = r.scenario + '#' + n;
      if (!coverage.has(k)) coverage.set(k, []);
      if (!coverage.get(k).includes(u)) coverage.get(k).push(u);
    }
  }

  const SYN = { __CMP: 'CMP・共通処理部品', __FW: '横断基盤・FW', __OTHER: 'その他' };
  const unitsByFeature = new Map();
  for (const u of reg.units) {
    const refs = unitScenarioRefs(u);
    let code = refs.length && feats.has(refs[0].scenario) ? refs[0].scenario : null;
    if (!code) code = (u.kind === 'CMP') ? '__CMP' : (u.kind === 'FW' ? '__FW' : '__OTHER');
    if (!unitsByFeature.has(code)) unitsByFeature.set(code, []);
    unitsByFeature.get(code).push(u);
  }

  const dist = {}; BOARD_STATE_ORDER.forEach((k) => (dist[k] = 0));
  const featureRows = [];
  const workItems = [];
  const orderedCodes = [...feats.keys()].concat(['__CMP', '__FW', '__OTHER'].filter((c) => unitsByFeature.has(c)));
  for (const code of orderedCodes) {
    const f = feats.get(code);
    const units = unitsByFeature.get(code) || [];
    const compl = completionByFeature[code] || null;
    const unitRows = [];
    for (const u of units) {
      const refs = unitScenarioRefs(u);
      let scenN = 0, scenM = 0, implDone = 0, implTotal = 0;
      const uGroups = [];
      if (f) {
        const myRef = refs.find((r) => r.scenario === code);
        const myNums = myRef ? myRef.cases : [];
        const byGroup = new Map();
        for (const n of myNums) { const cc = f.caseByNum.get(n); if (!cc) continue; if (!byGroup.has(cc.groupId)) byGroup.set(cc.groupId, []); byGroup.get(cc.groupId).push(cc); }
        for (const g of f.groups) {
          const cs = byGroup.get(g.id); if (!cs) continue;
          const mtr = caseSetMetrics(cs, coverage, code);
          const gColor = deriveGroupColor(mtr.scenN, mtr.scenM, mtr.implDone, mtr.implTotal, u.state, false, false);
          scenN += mtr.scenN; scenM += mtr.scenM; implDone += mtr.implDone; implTotal += mtr.implTotal;
          uGroups.push({ id: g.id, heading: g.heading, classification: g.classification, scenN: mtr.scenN, scenM: mtr.scenM, implDone: mtr.implDone, implTotal: mtr.implTotal, color: gColor,
            cases: cs.map((cc) => ({ caseId: cc.caseId, checked: cc.checked, marker: cc.marker, implState: caseImplState(coverage.get(code + '#' + cc.num) || []) })) });
        }
      }
      const tsEntry = testStatusFor([u.id], testStatusMap);
      const testColor = tsEntry ? testColorFor(testStatusMap, { joinKey: u.id, name: u.name }) : null;
      const color = deriveUnitColor(u.state, scenN, scenM, false, testColor);
      dist[color] = (dist[color] || 0) + 1;
      const depDetails = (u.deps || []).map((d) => { const du = unitById.get(d); return { id: d, name: du ? du.name : null, state: du ? du.state : null }; });
      const mini = stateMiniExplain(color, { scenN, scenM, state: u.state, ready: frontierSet.has(u.id), golden: u.golden, deps: depDetails });
      unitRows.push({ id: u.id, name: u.name, kind: u.kind, state: u.state, stage: u.stage, color, scenN, scenM, implDone, implTotal,
        ready: frontierSet.has(u.id), deps: depDetails, dependents: u.dependents || [], golden: u.golden || null, evidence: u.evidence || null, notes: u.notes || null,
        completion: compl, groups: uGroups, mini });
      const groupsForWork = uGroups.length ? uGroups : [{ id: u.id + '::self', heading: u.name, scenN, scenM, implDone, implTotal, color }];
      for (const g of groupsForWork) {
        let marker;
        if (g.implTotal > 0 && g.implDone === g.implTotal) marker = 'done';
        else if (u.state === '完了') marker = 'done';
        else if (u.state === '進行中') marker = 'running';
        else if (frontierSet.has(u.id)) marker = 'ready';
        else if (u.state === '待ち' || u.state === '未着手') marker = 'blocked';
        else marker = 'todo';
        const blockReason = (marker === 'blocked') ? (depDetails.filter((d) => d.state !== '完了').map((d) => d.id).join('・') || (u.state + '待ち')) : null;
        workItems.push({ groupId: g.id, featureCode: code, featureName: f ? f.name : SYN[code], unitId: u.id, unitName: u.name, heading: g.heading, marker, color: g.color, ready: frontierSet.has(u.id), blockReason });
      }
    }
    let fm = { scenN: 0, scenM: 0, implDone: 0, implTotal: 0 };
    if (f) fm = caseSetMetrics([...f.caseByNum.values()], coverage, code);
    const fColor = f ? deriveGroupColor(fm.scenN, fm.scenM, fm.implDone, fm.implTotal, null, false, false) : 'unknown';
    featureRows.push({ code, name: f ? f.name : SYN[code], synthetic: !f, units: unitRows, scenN: fm.scenN, scenM: fm.scenM, implDone: fm.implDone, implTotal: fm.implTotal, color: fColor, completion: compl });
  }

  const RANK = { done: 0, running: 1, ready: 2, todo: 3, blocked: 4 };
  const stableIdx = new Map(workItems.map((w, i) => [w, i]));
  workItems.sort((a, b) => ((RANK[a.marker] == null ? 9 : RANK[a.marker]) - (RANK[b.marker] == null ? 9 : RANK[b.marker])) || (stableIdx.get(a) - stableIdx.get(b)));
  workItems.forEach((w, i) => { w.order = i + 1; });

  return {
    ok: reg.ok, features: featureRows, workItems, dist,
    counts: { units: reg.units.length, features: featureRows.length, groups: workItems.length, byKind: reg.byKind, byState: reg.byState },
    frontier: reg.frontier, meta: reg.meta,
  };
}
