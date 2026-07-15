'use strict';

// parser.js — Markdown/frontmatter の純粋パーサ層（DOM・fetch・Dropbox に非依存）
//
// Mac 版 server.js のロジックと挙動互換（往復無損失・同じ ID 採番・同じ INBOX 追記・
// 同じ CARD_INDEX 再生成）。ブラウザからも Node（node --test）からも同一 ESM として利用。
// 将来 STAGE_PLAN.md / CONTROL.md の `- [ ]` 進捗を解析する進捗ビューも同じ部品で書ける。

// ---------------------------------------------------------------------------
// 表示ラベル（純粋データ・UI/索引で共用）
// ---------------------------------------------------------------------------

export const STATUS_ORDER = ['new', 'annotated', 'waiting', 'acceptance', 'consumed'];

// 分類語彙は英語表示（v1.3）。値そのものが英語のため恒等写像だが、将来の別名に備え表で持つ。
export const STATUS_LABEL = {
  new: 'new',
  annotated: 'annotated',
  waiting: 'waiting',
  acceptance: 'acceptance',
  consumed: 'consumed',
};

export const DIRECTION_LABEL = {
  'user-to-claude': 'user→AI',
  'claude-to-user': 'AI→user',
};

// type（ユーザー発 reference/knowledge/consult ＋ AI発 report/acceptance ＋ template）。
// request は廃止語＝読み込み時は consult 扱い（ファイルは書き換えない）。
export const TYPE_LABEL = {
  reference: 'reference',
  knowledge: 'knowledge',
  consult: 'consult',
  report: 'report',
  acceptance: 'acceptance',
  template: 'template',
};

// 廃止語 request → consult へ正規化（表示・タブ抽出用。card.md の値は書き換えない）。
export function normalizeType(t) {
  return t === 'request' ? 'consult' : (t || '');
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

// カード ID（"C-0003" / dir 名 "C-0003_slug"）から数値部を取り出す。C-\d+ を全許容。
export function cardIdNum(id) {
  const m = /C-(\d+)/.exec(id == null ? '' : String(id));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

// カード ID の比較（混在桁でも数値順。同値/非該当は文字列比較でフォールバック）。
export function compareCardId(a, b) {
  const na = cardIdNum(a);
  const nb = cardIdNum(b);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

// Dropbox の list_folder で得たフォルダ名配列から次の ID を決める（既存最大 +1・4桁0詰め）。
// パースは C-\d+ を全許容（3桁の旧カードと混在可）。9999 超は padStart(4) が自然に5桁へ拡張。
export function nextCardId(names) {
  let max = -1;
  for (const name of (names || [])) {
    const m = /^C-(\d+)/.exec(name);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return 'C-' + String(max + 1).padStart(4, '0');
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
