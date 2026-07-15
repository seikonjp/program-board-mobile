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
  // 新行が入る（日本語ラベルへ変換・タグは・区切り）
  assert.ok(out.includes('| C-001 | 屋根の理想 | あなた→AI | reference | 屋根・graphic | グラフィック整備着手時 | 新規 | 2026-07-15 |'), 'C-001 行が生成される');
  assert.ok(out.includes('| C-000 | 書式見本 |'), 'C-000 行も再生成される');
  // 表ヘッダも含む
  assert.ok(out.includes('| ID | 名称 | 方向 | 種別 | タグ | 浮上条件 | 状態 | 更新 |'), '表ヘッダを含む');
});
