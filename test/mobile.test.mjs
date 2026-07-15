'use strict';

// node --test 用スモークテスト（4件）。ブラウザ用 ESM をそのまま Node で検証する。
// Dropbox 通信層は fetch モックで単体テスト（実ネットワークアクセスなし）。

import test from 'node:test';
import assert from 'node:assert';

import * as P from '../docs/parser.js';
import { createDropboxClient, apiArg } from '../docs/dropbox.js';

// C-000 相当の書式見本 fixture（実ファイルは読まない・往復無損失の検証用）。
const CARD_FIXTURE =
`---
id: C-000
title: 書式見本（テンプレート）
direction: user-to-claude
type: template
tags: []
surface: ""
status: consumed
created: 2026-07-15
---

## 本文

（あなたが書くのはここだけで十分: 「このような屋根のグラフィックが理想」＋画像。画像ファイルはこのフォルダに同居させる）

## 注釈（私が記入）

（画像の内容をテキスト化・関連する機能/コム/段階・完成定義への織り込み候補）

## 処理記録

- ↳ 2026-07-15 テンプレートとして作成（消化扱い）

---
（凡例）direction: user-to-claude／claude-to-user
type: reference（参考）／request（要望）／report（完成・動作報告）／acceptance（検収依頼=OK/NG/あとで）
status: new／annotated／waiting（浮上待ち）／consumed（消化）
surface: 浮上条件（例: "グラフィック整備着手時"・"roofModelProcess着手時"）
`;

// ---------------------------------------------------------------------------
// ① parser 往復無損失（parse → serialize が byte 一致）
// ---------------------------------------------------------------------------
test('① card frontmatter round-trip is byte-identical (C-000 相当 fixture)', () => {
  const parsed = P.parseCard(CARD_FIXTURE);
  const back = P.serializeCard(parsed);
  assert.strictEqual(back, CARD_FIXTURE, 'card.md は byte 単位で往復無損失であること');

  // フィールドが正しく型解釈されている
  assert.strictEqual(parsed.fm.id, 'C-000');
  assert.strictEqual(parsed.fm.type, 'template');
  assert.deepStrictEqual(parsed.fm.tags, []);
  assert.strictEqual(parsed.fm.surface, '');
  assert.strictEqual(parsed.fm.status, 'consumed');

  // セクション抽出（本文/注釈/処理記録）
  const sections = P.parseSections(parsed.body);
  assert.ok(sections['本文'].includes('屋根のグラフィック'));
  assert.ok(sections['処理記録'].includes('テンプレートとして作成'));

  // 状態変更後も他フィールドは不変で再構築される
  P.setField(parsed, 'status', 'acceptance');
  const changed = P.serializeCard(parsed);
  assert.ok(changed.includes('status: acceptance'));
  assert.ok(changed.includes('id: C-000') && changed.includes('created: 2026-07-15'));
});

// ---------------------------------------------------------------------------
// ② ID 採番（既存最大 +1・3桁0詰め）
// ---------------------------------------------------------------------------
test('② nextCardId increments max and zero-pads (list_folder 名から)', () => {
  assert.strictEqual(P.nextCardId([]), 'C-000');
  assert.strictEqual(P.nextCardId(['C-000_TEMPLATE']), 'C-001');
  assert.strictEqual(
    P.nextCardId(['C-000_TEMPLATE', 'C-003_something', 'C-001_a', 'CARD_INDEX.md', 'not-a-card']),
    'C-004',
  );
  // 3桁を超えても連番は保つ
  assert.strictEqual(P.nextCardId(['C-042_x', 'C-100_y']), 'C-101');
});

// ---------------------------------------------------------------------------
// ③ INBOX 追記の影響範囲（§1 のみ）＋ rev 競合リトライ（fetch モック）
// ---------------------------------------------------------------------------
test('③ inbox append affects §1 only, and 409 conflict retries re-apply (fetch mock)', async () => {
  // (a) 純粋 append: §1 のみに影響し §2/§3 は不変
  const inboxV1 = [
    '# INBOX',
    '',
    '## §1 新規(ここに自由に書く)',
    '',
    '（未処理の新規エントリなし）',
    '',
    '## §2 留意台帳',
    '',
    '（登録なし）',
    '',
    '## §3 処理済み',
    '',
    '（まだなし）',
    '',
  ].join('\n');

  const entry = '- 2026-07-15 テスト項目（📱）';
  const appended = P.appendToInbox(inboxV1, entry);
  const s1 = appended.slice(appended.indexOf('## §1'), appended.indexOf('## §2'));
  assert.ok(s1.includes(entry), '§1 に追記される');
  assert.ok(!s1.includes('（未処理の新規エントリなし）'), 'プレースホルダは置換される');
  const s2s3Before = inboxV1.slice(inboxV1.indexOf('## §2'));
  const s2s3After = appended.slice(appended.indexOf('## §2'));
  assert.strictEqual(s2s3After, s2s3Before, '§2/§3 は不変');

  // (b) rev 競合リトライ: 1回目 upload が 409 → 再 download → 再適用 → 成功。
  //     競合中に別端末が §2 を編集していても、その変更は保全されること。
  let serverText = inboxV1;
  let serverRev = 'rev-A';
  let uploads = 0;
  let downloads = 0;

  function res({ status = 200, body = '', headers = {} }) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => JSON.parse(body || 'null'),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }

  async function mockFetch(url, opts) {
    if (url.endsWith('/files/download')) {
      downloads++;
      return res({ status: 200, body: serverText, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: serverRev }) } });
    }
    if (url.endsWith('/files/upload')) {
      uploads++;
      const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
      const mode = arg.mode;
      const bodyText = new TextDecoder().decode(opts.body);
      if (uploads === 1) {
        // 競合を発生させる: 別端末が §2 を編集し rev が進んだ
        serverText = serverText.replace('（登録なし）', '（登録なし）\n- 別端末が追加した留意');
        serverRev = 'rev-B';
        return res({ status: 409, body: JSON.stringify({ error_summary: 'path/conflict/file/...' }) });
      }
      if (mode && mode['.tag'] === 'update' && mode.update === serverRev) {
        serverText = bodyText;
        serverRev = 'rev-C';
        return res({ status: 200, body: JSON.stringify({ rev: serverRev }) });
      }
      return res({ status: 409, body: JSON.stringify({ error_summary: 'path/conflict' }) });
    }
    throw new Error('想定外のURL: ' + url);
  }

  const client = createDropboxClient({
    clientId: 'test',
    fetchImpl: mockFetch,
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 },
  });

  await client.updateTextFileWithRetry('/ArchPlan/Program/INBOX.md', (text) => P.appendToInbox(text, entry));

  assert.strictEqual(uploads, 2, '409 で1回リトライして計2回 upload する');
  assert.strictEqual(downloads, 2, '競合後に再 download する');
  const s1Final = serverText.slice(serverText.indexOf('## §1'), serverText.indexOf('## §2'));
  assert.ok(s1Final.includes(entry), '最終結果の §1 に追記が残る');
  assert.ok(serverText.includes('- 別端末が追加した留意'), '競合相手の §2 変更が保全される');

  // apiArg が非 ASCII を \u エスケープする（HTTP ヘッダ安全）
  assert.ok(!/[^\x00-\x7f]/.test(apiArg({ path: '/日本語/テスト.md' })), 'Dropbox-API-Arg は ASCII 安全');
});

// ---------------------------------------------------------------------------
// ④ CARD_INDEX.md 再生成（ヘッダ保持・表のみ差し替え）
// ---------------------------------------------------------------------------
test('④ CARD_INDEX regeneration preserves header, replaces table', () => {
  const existing =
`# CARD_INDEX — カード台帳

> 所属: ArchPlan/Program/Cards/。説明1。
> 説明2。

| ID | 名称 | 方向 | 種別 | タグ | 浮上条件 | 状態 | 更新 |
|----|------|------|------|------|----------|------|------|
| C-000 | 旧行 | — | template | — | — | 消化 | 2026-07-15 |
`;
  const cards = [
    { id: 'C-000', title: '書式見本', direction: '', type: 'template', tags: [], surface: '', status: 'consumed', created: '2026-07-15' },
    { id: 'C-001', title: '屋根の理想', direction: 'user-to-claude', type: 'reference', tags: ['屋根', 'graphic'], surface: 'グラフィック整備着手時', status: 'new', created: '2026-07-15' },
  ];
  const out = P.regenerateIndexContent(existing, cards);

  // ヘッダ（見出し + 引用ブロック）は保持
  assert.ok(out.startsWith('# CARD_INDEX — カード台帳\n\n> 所属: ArchPlan/Program/Cards/。説明1。\n> 説明2。'), 'ヘッダは保持される');
  // 旧行は消える
  assert.ok(!out.includes('旧行'), '古い表行は差し替えられる');
  // 新行が入る（日本語ラベルへ変換・タグは・区切り・subject 未指定は主題列が —）
  assert.ok(out.includes('| C-001 | 屋根の理想 | あなた→AI | reference | — | 屋根・graphic | グラフィック整備着手時 | 新規 | 2026-07-15 |'), 'C-001 行が生成される');
  assert.ok(out.includes('| C-000 | 書式見本 |'), 'C-000 行も再生成される');
  // 表ヘッダも含む（主題列を追加）
  assert.ok(out.includes('| ID | 名称 | 方向 | 種別 | 主題 | タグ | 浮上条件 | 状態 | 更新 |'), '表ヘッダ（主題列つき）を含む');
});

// ---------------------------------------------------------------------------
// ⑤ subject フィールド ＋ type=knowledge の往復無損失（v1.1）
// ---------------------------------------------------------------------------
const KNOWLEDGE_FIXTURE =
`---
id: C-002
title: 自動調整adjustment とモジュール
direction: user-to-claude
type: knowledge
subject: 自動調整
tags: [module, adjustment, CM07]
surface: "S0座標の錨の仕様起草時"
status: annotated
created: 2026-07-15
---

## 本文

CMP自動調整adjustment こそが建築モジュールと大きく関わってくる。

## 注釈（私が記入）

種別は知見(knowledge)。要点: 調整量子と判定閾値は別概念。

## 処理記録

- ↳ 2026-07-15 作成
- ↳ 2026-07-15 種別をknowledge（知見）へ変更・主題=自動調整
`;

test('⑤ subject と type=knowledge が往復無損失（byte 一致・型解釈）', () => {
  const parsed = P.parseCard(KNOWLEDGE_FIXTURE);
  assert.strictEqual(P.serializeCard(parsed), KNOWLEDGE_FIXTURE, 'subject/knowledge を含む card.md も byte 往復無損失');
  assert.strictEqual(parsed.fm.type, 'knowledge', 'type=knowledge を型解釈');
  assert.strictEqual(parsed.fm.subject, '自動調整', 'subject（引用符なし）を型解釈');

  // subject を含まない旧カードは subject='' となり壊れない（後方互換）
  const legacy = P.parseCard(CARD_FIXTURE);
  assert.strictEqual(legacy.fm.subject, '', 'subject 欄なしの旧カードは subject=""');
  assert.strictEqual(P.serializeCard(legacy), CARD_FIXTURE, 'subject 欄なしでも byte 往復無損失（後方互換）');

  // readCardFromText が subject を UI 用オブジェクトに載せる
  const card = P.readCardFromText(KNOWLEDGE_FIXTURE, 'C-002_x', []);
  assert.strictEqual(card.type, 'knowledge');
  assert.strictEqual(card.subject, '自動調整');

  // TYPE_JP に知見が入っている
  assert.strictEqual(P.TYPE_JP.knowledge, '知見');
});

// ---------------------------------------------------------------------------
// ⑥ buildNewCardMarkdown が subject 行（type 直後）と knowledge 型を出力し再往復する
// ---------------------------------------------------------------------------
test('⑥ buildNewCardMarkdown は subject と knowledge を出力し再パースで往復する', () => {
  const md = P.buildNewCardMarkdown({
    id: 'C-005', title: '知見テスト', direction: 'user-to-claude',
    type: 'knowledge', subject: '自動調整', body: '本文行', date: '2026-07-15',
  });
  const lines = md.split('\n');
  assert.ok(md.includes('type: knowledge'), 'type: knowledge を出力');
  assert.strictEqual(lines[lines.indexOf('type: knowledge') + 1], 'subject: 自動調整', 'subject 行は type の直後');

  // 空 subject は "" として出力（テンプレートと同形）
  const md2 = P.buildNewCardMarkdown({
    id: 'C-006', title: 'x', direction: 'user-to-claude',
    type: 'reference', subject: '', body: '', date: '2026-07-15',
  });
  assert.ok(md2.includes('subject: ""'), '空 subject は "" で出力');

  // 生成物は再パース→再直列化で byte 往復無損失（subject/knowledge を保持）
  const rp = P.parseCard(md);
  assert.strictEqual(rp.fm.type, 'knowledge');
  assert.strictEqual(rp.fm.subject, '自動調整');
  assert.strictEqual(P.serializeCard(rp), md, '生成 md も byte 往復無損失');
});

// ---------------------------------------------------------------------------
// ⑦ CARD_INDEX に主題列を追加して再生成（knowledge 型・主題を反映）
// ---------------------------------------------------------------------------
test('⑦ CARD_INDEX 再生成に主題列が入り knowledge/主題を反映する', () => {
  const existing =
`# CARD_INDEX — カード台帳

> 所属: Cards/。説明。

| ID | 名称 | 方向 | 種別 | タグ | 浮上条件 | 状態 | 更新 |
|----|------|------|------|------|----------|------|------|
| C-000 | 旧行（8列） | — | template | — | — | 消化 | 2026-07-15 |
`;
  const cards = [
    { id: 'C-001', title: '世界のライティング', direction: 'user-to-claude', type: 'reference', subject: 'ライティング', tags: ['graphics', 'world'], surface: 'S4着手時', status: 'annotated', created: '2026-07-15' },
    { id: 'C-002', title: '自動調整', direction: 'user-to-claude', type: 'knowledge', subject: '自動調整', tags: [], surface: '', status: 'annotated', created: '2026-07-15' },
    { id: 'C-003', title: '主題なし', direction: 'user-to-claude', type: 'reference', subject: '', tags: [], surface: '', status: 'new', created: '2026-07-15' },
  ];
  const out = P.regenerateIndexContent(existing, cards);

  assert.ok(out.startsWith('# CARD_INDEX — カード台帳'), 'ヘッダは保持');
  assert.ok(!out.includes('旧行（8列）'), '旧8列の表行は差し替えられる');
  assert.ok(out.includes('| ID | 名称 | 方向 | 種別 | 主題 | タグ | 浮上条件 | 状態 | 更新 |'), '9列（主題列つき）ヘッダ');
  assert.ok(out.includes('| C-001 | 世界のライティング | あなた→AI | reference | ライティング | graphics・world | S4着手時 | 注釈済み | 2026-07-15 |'), 'C-001 行（主題=ライティング）');
  assert.ok(out.includes('| C-002 | 自動調整 | あなた→AI | knowledge | 自動調整 | — | — | 注釈済み | 2026-07-15 |'), 'C-002 行（種別=knowledge・主題=自動調整）');
  assert.ok(out.includes('| C-003 | 主題なし | あなた→AI | reference | — | — | — | 新規 | 2026-07-15 |'), 'subject 空は主題列が —');
});

// ---------------------------------------------------------------------------
// ⑧ parseSubjects（SUBJECTS.md の主題名一覧・無くても壊れない）
// ---------------------------------------------------------------------------
test('⑧ parseSubjects は主題名を抽出し、無し/空でも壊れない', () => {
  const subjectsMd =
`# SUBJECTS — 主題台帳

> 説明文（bullet でない行は無視）。

- 自動調整 — CMP ADJ・建築モジュール・量子・判定閾値まわり
- ライティング — 世界の光・時刻/季節/天候の色彩変化
`;
  assert.deepStrictEqual(P.parseSubjects(subjectsMd), ['自動調整', 'ライティング'], '主題名（em ダッシュ前）を抽出');
  assert.deepStrictEqual(P.parseSubjects(null), [], 'null でも空配列');
  assert.deepStrictEqual(P.parseSubjects(''), [], '空文字でも空配列');
  assert.deepStrictEqual(P.parseSubjects('- モジュール'), ['モジュール'], 'em ダッシュ無しは行全体を主題名');
});
