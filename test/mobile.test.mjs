'use strict';

// node --test 用スモークテスト（4件）。ブラウザ用 ESM をそのまま Node で検証する。
// Dropbox 通信層は fetch モックで単体テスト（実ネットワークアクセスなし）。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as P from '../docs/parser.js';
import { createDropboxClient, apiArg } from '../docs/dropbox.js';
import { createProgram } from '../docs/program.js';
import { enabledViewIds, enabledGroups, enabledViewIdsForGroup, viewGroup, sheetArchplanRoot, config as APP_CONFIG } from '../docs/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readDoc = (rel) => readFileSync(resolve(HERE, '..', 'docs', rel), 'utf8');

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
type: reference（参考）／request（要望）／report（完成・動作報告）／review（検収依頼=OK/NG/あとで）
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
  P.setField(parsed, 'status', 'review');
  const changed = P.serializeCard(parsed);
  assert.ok(changed.includes('status: review'));
  assert.ok(changed.includes('id: C-000') && changed.includes('created: 2026-07-15'));
});

// ---------------------------------------------------------------------------
// ② ID 採番（既存最大 +1・4桁0詰め・混在桁・9999 超）
// ---------------------------------------------------------------------------
test('② nextCardId increments U-series max and zero-pads to 4 digits (混在桁・上限なし・Mac版と同一仕様)', () => {
  assert.strictEqual(P.nextCardId([]), 'C-U0000');
  assert.strictEqual(P.nextCardId(['C-U0000_TEMPLATE']), 'C-U0001');
  assert.strictEqual(
    P.nextCardId(['C-U0000_TEMPLATE', 'C-003_something', 'C-U0001_a', 'CARD_INDEX.md', 'not-a-card']),
    'C-U0004',
  );
  assert.strictEqual(P.nextCardId(['C-042_x', 'C-100_y']), 'C-U0101');
  // 旧3桁 C-00x（字なし・保険としてU系計上）と新4桁 C-U000x の混在でも数値最大 +1
  assert.strictEqual(P.nextCardId(['C-000_a', 'C-U0003_b', 'C-002_c']), 'C-U0004');
  // 9999 超は上限を作らず自然に5桁へ拡張
  assert.strictEqual(P.nextCardId(['C-U9999_x']), 'C-U10000');
  assert.strictEqual(P.nextCardId(['C-U10000_x', 'C-U0003_y']), 'C-U10001');
});

test('②b A-series folders do not affect U-series numbering (v1.9)', () => {
  assert.strictEqual(P.nextCardId(['C-U0000_TEMPLATE', 'C-U0001_something']), 'C-U0002');
  assert.strictEqual(
    P.nextCardId(['C-U0000_TEMPLATE', 'C-U0001_something', 'C-A0001_x', 'C-A0002_y', 'C-A9999_z']),
    'C-U0002',
    'A系フォルダはU採番に影響しない',
  );
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
  // 新行が入る（英語ラベルへ変換・タグは・区切り・subject 未指定は主題列が —）
  assert.ok(out.includes('| C-001 | 屋根の理想 | user→AI | reference | — | 屋根・graphic | グラフィック整備着手時 | 新規 | 2026-07-15 |'), 'C-001 行が生成される');
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

  // TYPE_LABEL は英語表示（v1.3）
  assert.strictEqual(P.TYPE_LABEL.knowledge, 'knowledge');
  assert.strictEqual(P.TYPE_LABEL.consult, 'consult');
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
  assert.ok(out.includes('| C-001 | 世界のライティング | user→AI | reference | ライティング | graphics・world | S4着手時 | 確認済み | 2026-07-15 |'), 'C-001 行（主題=ライティング・状態は日本語・新語彙）');
  assert.ok(out.includes('| C-002 | 自動調整 | user→AI | knowledge | 自動調整 | — | — | 確認済み | 2026-07-15 |'), 'C-002 行（種別=knowledge・主題=自動調整・新語彙）');
  assert.ok(out.includes('| C-003 | 主題なし | user→AI | reference | — | — | — | 新規 | 2026-07-15 |'), 'subject 空は主題列が —');
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

// ---------------------------------------------------------------------------
// ⑨ consult 語彙・request 後方互換（正規化／往復無損失＝ファイルは書き換えない）（v1.3）
// ---------------------------------------------------------------------------
const REQUEST_FIXTURE =
`---
id: C-004
title: 玄関配置の相談
direction: user-to-claude
type: request
subject: 玄関
tags: []
surface: ""
status: new
created: 2026-07-15
---

## 本文

玄関の自動配置について相談したい。

## 注釈（私が記入）


## 処理記録

- ↳ 2026-07-15 作成
`;

test('⑨ request は書き換えず consult 扱い（正規化・ラベル・往復無損失）', () => {
  const parsed = P.parseCard(REQUEST_FIXTURE);
  assert.strictEqual(parsed.fm.type, 'request', 'type=request はそのまま型解釈（書き換えない）');
  assert.strictEqual(P.serializeCard(parsed), REQUEST_FIXTURE, 'request カードも byte 往復無損失（ファイルは書き換えない）');

  assert.strictEqual(P.normalizeType('request'), 'consult', 'request→consult 正規化');
  assert.strictEqual(P.normalizeType('consult'), 'consult');
  assert.strictEqual(P.normalizeType('reference'), 'reference');
  assert.strictEqual(P.normalizeType(''), '');
  assert.strictEqual(P.typeLabel('request'), 'consult', 'request の表示ラベルは consult');
  assert.strictEqual(P.typeLabel('reference'), 'reference');

  // CARD_INDEX でも request は consult 表示（英語ラベル）
  const out = P.buildIndexTable([
    { id: 'C-004', title: '玄関配置の相談', direction: 'user-to-claude', type: 'request', subject: '玄関', tags: [], surface: '', status: 'new', created: '2026-07-15' },
  ]);
  assert.ok(out.includes('| C-004 | 玄関配置の相談 | user→AI | consult | 玄関 | — | — | 新規 | 2026-07-15 |'), 'request 行は種別=consult で出力');
});

// ---------------------------------------------------------------------------
// ⑩ cardsForType（type 別タブ抽出・request は consult タブへ合流）（v1.3）
// ---------------------------------------------------------------------------
test('⑩ cardsForType は type 別に抽出し request を consult へ合流する', () => {
  const cards = [
    { id: 'C-001', type: 'reference' },
    { id: 'C-002', type: 'knowledge' },
    { id: 'C-004', type: 'request' },
    { id: 'C-005', type: 'consult' },
    { id: 'C-006', type: 'report' },
    { id: 'C-007', type: '' },
  ];
  assert.deepStrictEqual(P.cardsForType(cards, 'reference').map((c) => c.id), ['C-001']);
  assert.deepStrictEqual(P.cardsForType(cards, 'knowledge').map((c) => c.id), ['C-002']);
  assert.deepStrictEqual(P.cardsForType(cards, 'consult').map((c) => c.id), ['C-004', 'C-005'], 'request は consult 扱いで合流');
  assert.deepStrictEqual(P.cardsForType([], 'consult'), [], '空でも壊れない');
  assert.deepStrictEqual(P.cardsForType(null, 'reference'), [], 'null でも壊れない');
});

// ---------------------------------------------------------------------------
// ⑪ 混在桁 ID: cardIdNum / compareCardId / sort が桁数でなく数値順（v1.3）
// ---------------------------------------------------------------------------
test('⑪ 混在桁 ID は数値順に採番・ソートされる', () => {
  assert.strictEqual(P.cardIdNum('C-002'), 2);
  assert.strictEqual(P.cardIdNum('C-0003_slug'), 3);
  assert.strictEqual(P.cardIdNum('C-10000'), 10000);
  assert.strictEqual(P.cardIdNum(''), Number.MAX_SAFE_INTEGER, '非該当は末尾へ');

  const ids = ['C-0003', 'C-000', 'C-002', 'C-0010', 'C-001'];
  const sorted = ids.slice().sort(P.compareCardId);
  assert.deepStrictEqual(sorted, ['C-000', 'C-001', 'C-002', 'C-0003', 'C-0010'], '桁数でなく数値順');
});

// ---------------------------------------------------------------------------
// ⑫ タブ順（v1.4）＋ Report タブ抽出（type=report・cardsForType 再利用）
// ---------------------------------------------------------------------------
test('⑫ 最上位ナビ4群（v2.2）＋Cards群の第2階層タブ順', () => {
  // 最上位ナビ = Cards / Sheets / Views / Sessions（この順）
  assert.deepStrictEqual(enabledGroups().map((g) => g.id), ['cards', 'sheets', 'views', 'sessions'], '群の順');
  assert.deepStrictEqual(enabledGroups().map((g) => g.label), ['Cards', 'Sheets', 'Views', 'Sessions'], '群のラベル');
  // Cards 群の第2階層タブ順（v1.8 の8タブを内包）
  assert.deepStrictEqual(
    enabledViewIdsForGroup('cards'),
    ['board', 'reference', 'knowledge', 'consult', 'decision', 'report', 'tray', 'memo', 'completed'],
    'Cards 群の第2階層タブ順',
  );
  // 各群の単一ビュー・所属判定
  assert.deepStrictEqual(enabledViewIdsForGroup('sheets'), ['sheets']);
  assert.deepStrictEqual(enabledViewIdsForGroup('views'), ['views']);
  assert.deepStrictEqual(enabledViewIdsForGroup('sessions'), ['sessions']);
  assert.strictEqual(viewGroup('board'), 'cards');
  assert.strictEqual(viewGroup('sheets'), 'sheets');
  // enabledViewIds は全群のビューを config 順で返す（動的 import 用）
  assert.deepStrictEqual(enabledViewIds(), ['board', 'reference', 'knowledge', 'consult', 'decision', 'report', 'tray', 'memo', 'completed', 'sheets', 'views', 'sessions']);
});

test('⑫b cardsForType(type=report) は report カードのみ抽出（Report タブ）', () => {
  const cards = [
    { id: 'C-001', type: 'reference' },
    { id: 'C-006', type: 'report' },
    { id: 'C-007', type: 'review' },
    { id: 'C-008', type: 'report' },
  ];
  assert.deepStrictEqual(P.cardsForType(cards, 'report').map((c) => c.id), ['C-006', 'C-008'], 'report のみ（review は含めない）');
});

// ---------------------------------------------------------------------------
// ⑬ decision 語彙（AI発・裁定依頼）: ラベル・タブ抽出・往復無損失・生成（v1.5）
// ---------------------------------------------------------------------------
const DECISION_FIXTURE =
`---
id: C-0003
title: Q-04 lightingコムの追加要否（裁定依頼）
direction: claude-to-user
type: decision
subject: ライティング
tags: [species, S0, Q-04]
surface: ""
status: new
created: 2026-07-15
---

## 本文

**問い**: 照明を独立コム（lighting）として種リストに追加しますか？

## 注釈（私が記入）


## 処理記録

- ↳ 2026-07-15 作成
`;

test('⑬ decision 型: ラベル・抽出・往復無損失・buildNewCardMarkdown（v1.5）', () => {
  // ラベル（英語表示・恒等）
  assert.strictEqual(P.TYPE_LABEL.decision, 'decision');
  assert.strictEqual(P.typeLabel('decision'), 'decision');
  assert.strictEqual(P.normalizeType('decision'), 'decision');

  // decision タブ抽出（他 type と混ぜても decision のみ）
  const cards = [
    { id: 'C-0003', type: 'decision' },
    { id: 'C-0004', type: 'report' },
    { id: 'C-0005', type: 'review' },
    { id: 'C-0006', type: 'decision' },
    { id: 'C-0007', type: 'consult' },
  ];
  assert.deepStrictEqual(P.cardsForType(cards, 'decision').map((c) => c.id), ['C-0003', 'C-0006'], 'decision のみ抽出');

  // decision カードは byte 往復無損失＋型解釈
  const parsed = P.parseCard(DECISION_FIXTURE);
  assert.strictEqual(parsed.fm.type, 'decision');
  assert.strictEqual(parsed.fm.direction, 'claude-to-user', 'AI発');
  assert.strictEqual(P.serializeCard(parsed), DECISION_FIXTURE, 'decision カードも byte 往復無損失');
  const card = P.readCardFromText(DECISION_FIXTURE, 'C-0003_x', []);
  assert.strictEqual(card.type, 'decision');
  assert.strictEqual(card.subject, 'ライティング');

  // CARD_INDEX でも decision 表示
  const idx = P.buildIndexTable([
    { id: 'C-0003', title: 'Q-04', direction: 'claude-to-user', type: 'decision', subject: 'ライティング', tags: [], surface: '', status: 'new', created: '2026-07-15' },
  ]);
  assert.ok(idx.includes('| C-0003 | Q-04 | AI→user | decision | ライティング | — | — | 新規 | 2026-07-15 |'), 'decision 行が生成される');

  // buildNewCardMarkdown が decision を出力し再往復
  const md = P.buildNewCardMarkdown({ id: 'C-0099', title: 't', direction: 'claude-to-user', type: 'decision', subject: 'x', body: '本文', date: '2026-07-15' });
  assert.ok(md.includes('type: decision'));
  assert.strictEqual(P.serializeCard(P.parseCard(md)), md, '生成 md も byte 往復無損失');
});

// ---------------------------------------------------------------------------
// ⑭ Decision タブ=カード化＋全文折りたたみ／全タブでタイル統一（v1.5・ソース構造）
// ---------------------------------------------------------------------------
test('⑭ Decision はカード表示（typeTab 再利用）＋DECISION_QUEUE 全文の折りたたみを残す', () => {
  const src = readDoc('views/decision.js');
  assert.ok(src.includes("from './typeTab.js'") && src.includes('makeTypeTabView('), 'カード一覧は typeTab 機構を再利用');
  assert.ok(/type:\s*'decision'/.test(src), 'type=decision のカードを表示');
  assert.ok(src.includes("h('details'") && src.includes("h('summary'"), '全文は details/summary の折りたたみ');
  assert.ok(src.includes('readDecisionQueue'), 'DECISION_QUEUE.md 全文の閲覧手段を残す');
  // 既定は閉じる（open にしない・開いた時に読み込む）
  assert.ok(!/\.open\s*=\s*true/.test(src), '既定は閉（open=true にしない）');
  assert.ok(src.includes("addEventListener('toggle'"), '開いた時に初回読み込み');
});

test('⑭b Acceptance(=tray) は共通 cardTile を使う（タイル部が全タブ統一）', () => {
  const src = readDoc('views/tray.js');
  assert.ok(src.includes("cardTile") && src.includes("from './shared.js'"), 'tray は shared.js の cardTile を使用');
  assert.ok(src.includes('cardTile(ctx, card'), '共通タイルでカードを描画');
  // 3ボタン（OK/NG/あとで）は維持
  assert.ok(src.includes("'OK'") && src.includes("'NG'") && src.includes("'あとで'"), '3ボタンは維持');
});

// ---------------------------------------------------------------------------
// ⑮ 状態ラベルは表示のみ日本語（値は英語）／Board=種類別6列／タイルに日本語状態 chip（v1.6）
// ---------------------------------------------------------------------------
test('⑮ status labels Japanese (display only); board is type-based 6 columns (v1.6)', () => {
  // (a) STATUS_LABEL は日本語ラベル（2026-07-17 整理版）
  assert.strictEqual(P.STATUS_LABEL.new, '新規');
  assert.strictEqual(P.STATUS_LABEL.annotated, '確認済み');
  assert.strictEqual(P.STATUS_LABEL.waiting, '保留');
  assert.strictEqual(P.STATUS_LABEL.review, '対応待ち');
  assert.strictEqual(P.STATUS_LABEL.responded, 'AI対応中');
  assert.strictEqual(P.STATUS_LABEL['done-proposed'], '完了提案');
  assert.strictEqual(P.STATUS_LABEL.consumed, '完了');
  assert.strictEqual(P.STATUS_LABEL.carried, '申し送り');

  // (b) CARD_INDEX の状態列も日本語・英語ラベルは出ない（type 非依存の素の STATUS_LABEL）
  const idx = P.buildIndexTable([
    { id: 'C-001', title: 't', direction: 'user-to-claude', type: 'report', subject: '', tags: [], surface: '', status: 'review', created: '2026-07-15' },
    { id: 'C-002', title: 't', direction: 'user-to-claude', type: 'reference', subject: '', tags: [], surface: '', status: 'consumed', created: '2026-07-15' },
  ]);
  assert.ok(idx.includes('| 対応待ち |') && idx.includes('| 完了 |'), 'CARD_INDEX の状態列は日本語（新語彙）');
  assert.ok(!/\| (new|review|consumed) \|/.test(idx), '英語の状態ラベルは出力されない');

  // (c) ファイル内部の status 値は英語のまま（往復無損失＝書き換えない）
  const parsed = P.parseCard(DECISION_FIXTURE);
  assert.strictEqual(parsed.fm.status, 'new', 'frontmatter の status 値は英語のまま');
  assert.strictEqual(P.serializeCard(parsed), DECISION_FIXTURE, '往復無損失（値は書き換えない）');

  // (d) boardColumns=種類別6列（この順）・request→consult 合流・template は入らない
  const cards = [
    { id: 'C-a', type: 'reference' }, { id: 'C-b', type: 'knowledge' }, { id: 'C-c', type: 'consult' },
    { id: 'C-d', type: 'request' }, { id: 'C-e', type: 'decision' }, { id: 'C-f', type: 'report' },
    { id: 'C-g', type: 'review' }, { id: 'C-h', type: 'template' },
  ];
  const cols = P.boardColumns(cards);
  assert.deepStrictEqual(cols.map((c) => c.type), ['reference', 'knowledge', 'consult', 'decision', 'report', 'review'], '6列この順');
  assert.deepStrictEqual(cols.map((c) => c.label), ['Reference', 'Knowledge', 'Consult', 'Decision', 'Report', 'Acceptance'], '列見出しは英語（タブ名と同形）');
  const consult = cols.find((c) => c.type === 'consult').cards.map((x) => x.id);
  assert.deepStrictEqual(consult, ['C-c', 'C-d'], 'request は consult 列へ合流');
  const shown = cols.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(!shown.includes('C-h'), 'template は6列いずれにも入らない');
});

test('⑮b board.js は種類別カラム（boardColumns）を使い、タイルに状態 chip を出す（v1.6）', () => {
  const board = readDoc('views/board.js');
  assert.ok(board.includes('boardColumns') && board.includes("from '../parser.js'"), 'board は parser.js の boardColumns（種類別）を使用');
  assert.ok(board.includes('showType: false'), '列=種類のため type chip は付けない');
  assert.ok(board.includes('BOARD_COLUMN_ORDER'), 'セグメントも種類別（BOARD_COLUMN_ORDER）');

  // shared.js の cardTile が日本語の状態 chip を付与（type 考慮の statusLabel）
  const shared = readDoc('views/shared.js');
  assert.ok(shared.includes('chip chip-status') && shared.includes('P.statusLabel(card.status'), 'cardTile が状態 chip（type考慮の statusLabel）を付与');
});

// ⑮c 表示語彙整理（3グループ）＋処遇マーカー＋完了ビュー（2026-07-17・正=カード凡例C-U0000）
test('⑮c status vocab整理: statusLabel/treatmentMarker/listableCards/completedCards', () => {
  // (a) statusLabel: 内部値→表示語彙。reference/knowledge は既定値(new/annotated/空)のとき「参考」。
  assert.strictEqual(P.statusLabel('new', 'consult'), '新規');
  assert.strictEqual(P.statusLabel('annotated', 'consult'), '確認済み');
  assert.strictEqual(P.statusLabel('review', 'review'), '対応待ち');
  assert.strictEqual(P.statusLabel('responded', 'decision'), 'AI対応中');
  assert.strictEqual(P.statusLabel('done-proposed', 'report'), '完了提案');
  assert.strictEqual(P.statusLabel('consumed', 'consult'), '完了');
  assert.strictEqual(P.statusLabel('waiting', 'consult'), '保留');
  assert.strictEqual(P.statusLabel('carried', 'consult'), '申し送り');
  assert.strictEqual(P.statusLabel('new', 'reference'), '参考');
  assert.strictEqual(P.statusLabel('annotated', 'knowledge'), '参考');
  assert.strictEqual(P.statusLabel('', 'reference'), '参考');
  // 具体的 status が付けばそちら優先（C-U0001=reference+carried→「申し送り」）
  assert.strictEqual(P.statusLabel('carried', 'reference'), '申し送り');
  assert.strictEqual(P.statusLabel('consumed', 'reference'), '完了');
  assert.strictEqual(P.statusLabel('review', 'reference'), '対応待ち');

  // (b) treatmentMarker: 完了✓／保留→／対応中=null。完了グループ status は type=reference でも✓優先。
  assert.strictEqual(P.treatmentMarker('done-proposed', 'report'), '✓hollow');
  assert.strictEqual(P.treatmentMarker('consumed', 'consult'), '✓filled');
  assert.strictEqual(P.treatmentMarker('waiting', 'consult'), '→');
  assert.strictEqual(P.treatmentMarker('carried', 'consult'), '→');
  assert.strictEqual(P.treatmentMarker('new', 'reference'), '→');
  assert.strictEqual(P.treatmentMarker('annotated', 'knowledge'), '→');
  assert.strictEqual(P.treatmentMarker('new', 'consult'), null);
  assert.strictEqual(P.treatmentMarker('annotated', 'consult'), null);
  assert.strictEqual(P.treatmentMarker('review', 'review'), null);
  assert.strictEqual(P.treatmentMarker('responded', 'decision'), null);
  assert.strictEqual(P.treatmentMarker('consumed', 'reference'), '✓filled');
  assert.strictEqual(P.treatmentMarker('done-proposed', 'knowledge'), '✓hollow');

  // (c) listableCards は consumed とアーカイブを除外、completedCards はそれらを集約。
  const cards = [
    { id: 'C-1', type: 'consult', status: 'new' },
    { id: 'C-2', type: 'reference', status: 'consumed' },
    { id: 'C-3', type: 'report', status: 'review' },
    { id: 'C-4', type: 'knowledge', status: 'annotated', archived: true },
  ];
  assert.deepStrictEqual(P.listableCards(cards).map((c) => c.id), ['C-1', 'C-3'], '既定一覧は consumed とアーカイブを除外');
  assert.deepStrictEqual(P.completedCards(cards).map((c) => c.id), ['C-2', 'C-4'], '完了ビューは consumed ＋アーカイブ');

  // (d) STATUS_ORDER に carried が登録されている
  assert.ok(P.STATUS_ORDER.includes('carried'), 'STATUS_ORDER に carried');

  // (e) board.js は既定一覧に listableCards を使う（consumed 除外）
  const board = readDoc('views/board.js');
  assert.ok(board.includes('listableCards'), 'board は listableCards（consumed 除外）を使用');

  // (f) 完了ビュー completed.js は completedCards を使う
  const completed = readDoc('views/completed.js');
  assert.ok(completed.includes('completedCards') && completed.includes("id: 'completed'"), '完了ビューは completedCards を使い id=completed で登録');
});

// ---------------------------------------------------------------------------
// ⑯ direction 別操作モード＋コメント行生成／処理記録追記の往復（v1.7）
// ---------------------------------------------------------------------------
test('⑯ cardOperationMode（direction別）＋ buildCommentLine ＋ 処理記録追記の無損失（v1.7）', () => {
  // direction 別の操作モード（一覧タイルには出さない・詳細のみで使う判定）
  assert.strictEqual(P.cardOperationMode('user-to-claude'), 'edit', 'ユーザー発=編集（削除+コメント即動作）');
  assert.strictEqual(P.cardOperationMode('claude-to-user'), 'respond', 'AI発=応答（OK/NGトグル表示のみ・コメント準備中）');
  assert.strictEqual(P.cardOperationMode(''), 'none', '方向不明は操作を出さない');
  assert.strictEqual(P.cardOperationMode(undefined), 'none');

  // コメント行（📱=モバイル）
  const line = P.buildCommentLine('2026-07-15', 'ここを直したい', '📱');
  assert.strictEqual(line, '- ↳ 2026-07-15 コメント（あなた・📱）: ここを直したい', 'コメント行の書式');

  // 処理記録へ追記 → 本文/注釈は不変・既存記録行も残る（往復無損失の追記）
  const parsed = P.parseCard(CARD_FIXTURE);
  const before = parsed.body;
  const after = P.appendUnderHeading(before, '処理記録', line);
  assert.ok(after.includes(line), '処理記録にコメント行が入る');
  const secB = P.parseSections(before);
  const secA = P.parseSections(after);
  assert.strictEqual(secA['本文'], secB['本文'], '本文は不変');
  assert.strictEqual(secA['注釈（私が記入）'], secB['注釈（私が記入）'], '注釈は不変');
  assert.ok(secA['処理記録'].includes('テンプレートとして作成'), '既存の処理記録行も残る');
});

// ---------------------------------------------------------------------------
// ⑰ dropbox.move は /files/move_v2 を呼ぶ（移動のみ・from/to・削除APIでない）（v1.7）
// ---------------------------------------------------------------------------
test('⑰ dropbox.move は /files/move_v2（移動のみ・from/to・autorename）を呼ぶ（v1.7）', async () => {
  let called = null;
  const res = (body) => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => body, json: async () => JSON.parse(body || 'null'),
  });
  async function mockFetch(url, opts) {
    if (url.endsWith('/files/move_v2')) { called = { url, body: JSON.parse(opts.body) }; return res(JSON.stringify({ metadata: {} })); }
    throw new Error('想定外のURL: ' + url);
  }
  const client = createDropboxClient({
    clientId: 't', fetchImpl: mockFetch,
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 },
  });
  await client.move('/ArchPlan/Program/Cards/C-0001_x', '/ArchPlan/Program/Cards/_trash/C-0001_x');
  assert.ok(called, 'move_v2 が呼ばれる');
  assert.strictEqual(called.body.from_path, '/ArchPlan/Program/Cards/C-0001_x');
  assert.strictEqual(called.body.to_path, '/ArchPlan/Program/Cards/_trash/C-0001_x', '移動先も Cards 内');
  assert.strictEqual(called.body.autorename, true, '衝突時は退避名（上書きしない）');
});

// ---------------------------------------------------------------------------
// ⑱ loadCards は _trash 配下を走査除外する（台帳・全タブ・検索から消える）（v1.7）
// ---------------------------------------------------------------------------
test('⑱ loadCards は _trash 配下のカードを走査除外する（fetch モック・v1.7）', async () => {
  const root = '/ArchPlan/Program';
  const cardsRoot = root + '/Cards';
  const mdText = (id) => `---\nid: ${id}\ntitle: t${id}\ndirection: user-to-claude\ntype: reference\ntags: []\nsurface: ""\nstatus: new\ncreated: 2026-07-15\n---\n\n## 本文\n\nx\n`;
  const entries = [
    { '.tag': 'folder', path_display: cardsRoot + '/C-0001_a' },
    { '.tag': 'file', path_display: cardsRoot + '/C-0001_a/card.md', rev: 'r1' },
    { '.tag': 'folder', path_display: cardsRoot + '/_trash' },
    { '.tag': 'folder', path_display: cardsRoot + '/_trash/C-0002_b' },
    { '.tag': 'file', path_display: cardsRoot + '/_trash/C-0002_b/card.md', rev: 'r2' },
  ];
  function res({ status = 200, body = '', headers = {} }) {
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      text: async () => body, json: async () => JSON.parse(body || 'null'),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }
  async function mockFetch(url, opts) {
    if (url.endsWith('/files/list_folder')) return res({ status: 200, body: JSON.stringify({ entries, has_more: false, cursor: 'c' }) });
    if (url.endsWith('/files/download')) {
      const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
      const id = arg.path.includes('C-0001') ? 'C-0001' : 'C-0002';
      return res({ status: 200, body: mdText(id), headers: { 'Dropbox-API-Result': JSON.stringify({ rev: id === 'C-0001' ? 'r1' : 'r2' }) } });
    }
    throw new Error('想定外のURL: ' + url);
  }
  const client = createDropboxClient({
    clientId: 't', fetchImpl: mockFetch,
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 },
  });
  const program = createProgram(client, { programRoot: root });
  const { cards, cardDirs } = await program.loadCards();
  assert.deepStrictEqual(cards.map((c) => c.id), ['C-0001'], '_trash 配下（C-0002）は台帳に出ない');
  assert.deepStrictEqual(cardDirs, ['C-0001_a'], 'cardDirs も _trash を含まない');
});

// ---------------------------------------------------------------------------
// ⑲ shared.js の詳細シートに操作系を差し込む／一覧タイルには出さない（ソース構造・v1.7）
// ---------------------------------------------------------------------------
test('⑲ 詳細シートに操作系（削除/コメント/OKNGトグル）・タイルには出さない（v1.7）', () => {
  const shared = readDoc('views/shared.js');
  // 詳細シート（openCardDetail）にのみ操作系を差し込む
  const openFn = shared.slice(shared.indexOf('export function openCardDetail('), shared.indexOf('function addSection('));
  assert.ok(openFn.includes('addOperations(ctx, body, card)'), 'openCardDetail が操作系を差し込む');
  // 一覧タイル（cardTile）には操作系を出さない
  const tileFn = shared.slice(shared.indexOf('export function cardTile('), shared.indexOf('// ---- 詳細シート'));
  assert.ok(!tileFn.includes('addOperations'), '一覧タイルには操作系を出さない');
  // 操作系の配線: 編集=deleteCard/addComment、AI発=応答配線（v2.1・旧「準備中」は廃止）
  const opsFn = shared.slice(shared.indexOf('function addOperations('));
  assert.ok(opsFn.includes('P.cardOperationMode(card.direction)'), 'direction で出し分け');
  assert.ok(opsFn.includes('ctx.program.deleteCard(card.id)') && opsFn.includes('ctx.program.addComment(card.id'), '編集モード=削除+コメント（即動作）');
  assert.ok(!opsFn.includes('準備中'), 'AI発の送信「準備中」は廃止（新仕様が勝つ）');
  assert.ok(opsFn.includes("sendRespond(ctx, card, 'ok'") && opsFn.includes("sendRespond(ctx, card, 'ng'") && opsFn.includes("sendRespond(ctx, card, 'later'"), 'AI発=OK/NG/あとでを応答配線');
  assert.ok(opsFn.includes('P.extractChoices(') && opsFn.includes("sendRespond(ctx, card, 'choice'"), 'decision は選択肢抽出で応答配線');
  // v2.7（C-U0004）: 選択→送信の一括方式。選択肢ボタンは即送信せず prefix 差し込み・[送信]で parse。
  assert.ok(opsFn.includes('P.setChoicePrefix(ta.value'), 'decision 選択肢ボタンは即送信でなく textarea へ「選択=X」を差し込む');
  assert.ok(opsFn.includes('P.parseChoicePrefix(ta.value'), '[送信]は先頭 prefix を parse して一括送信');
  assert.ok(!/b\.onclick = \(\) => sendRespond\(ctx, card, 'choice'/.test(opsFn), '選択肢ボタンのタップ即送信は廃止');
  assert.ok(!/okBtn\.onclick = \(\) => sendRespond/.test(opsFn), 'OK ボタンのタップ即送信は廃止');
  // OK/NG/あとで＝選択状態（相互排他ハイライト）＋[送信]ラベル更新。
  assert.ok(opsFn.includes('is-selected') && opsFn.includes('selectedKind'), 'OK/NG/あとで＝選択状態（ハイライト・相互排他）');
  assert.ok(opsFn.includes('送信（OK）') && opsFn.includes('送信（NG）') && opsFn.includes('送信（あとで）'), '[送信]ラベルは選択に応じて更新');
});

// ---------------------------------------------------------------------------
// 共有: 疑似 Dropbox（インメモリ FS）fetch モック（list_folder / download / upload / move_v2）
// ---------------------------------------------------------------------------
function makeMockDropbox(initial) {
  const store = new Map(Object.entries(initial || {}).map(([k, v]) => [k, { content: v, rev: 'r-' + k.length }]));
  let revCounter = 100;
  function res({ status = 200, body = '', headers = {} }) {
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      text: async () => body, json: async () => JSON.parse(body || 'null'),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }
  async function fetchImpl(url, opts) {
    if (url.endsWith('/files/list_folder')) {
      const arg = JSON.parse(opts.body);
      const base = arg.path.replace(/\/+$/, '');
      const recursive = !!arg.recursive;
      const entries = [];
      const seen = new Set();
      for (const [p, meta] of store) {
        if (!p.startsWith(base + '/')) continue;
        const rel = p.slice(base.length + 1).split('/');
        if (recursive) {
          let acc = base;
          for (let i = 0; i < rel.length - 1; i++) {
            acc += '/' + rel[i];
            if (!seen.has(acc)) { seen.add(acc); entries.push({ '.tag': 'folder', path_display: acc }); }
          }
          entries.push({ '.tag': 'file', path_display: p, rev: meta.rev });
        } else if (rel.length === 1) {
          entries.push({ '.tag': 'file', path_display: p, rev: meta.rev });
        } else {
          const folder = base + '/' + rel[0];
          if (!seen.has(folder)) { seen.add(folder); entries.push({ '.tag': 'folder', path_display: folder }); }
        }
      }
      return res({ status: 200, body: JSON.stringify({ entries, has_more: false, cursor: 'c' }) });
    }
    if (url.endsWith('/files/download')) {
      const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
      const meta = store.get(arg.path);
      if (!meta) return res({ status: 409, body: JSON.stringify({ error_summary: 'path/not_found/..' }) });
      return res({ status: 200, body: meta.content, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: meta.rev }) } });
    }
    if (url.endsWith('/files/get_metadata')) {
      const arg = JSON.parse(opts.body);
      const meta = store.get(arg.path);
      if (!meta) return res({ status: 409, body: JSON.stringify({ error_summary: 'path/not_found/..' }) });
      return res({ status: 200, body: JSON.stringify({ '.tag': 'file', path_display: arg.path, rev: meta.rev }) });
    }
    if (url.endsWith('/files/upload')) {
      const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
      const mode = arg.mode || { '.tag': 'add' };
      const bodyText = typeof opts.body === 'string' ? opts.body : new TextDecoder().decode(opts.body);
      const existing = store.get(arg.path);
      if (mode['.tag'] === 'add' && existing) return res({ status: 409, body: JSON.stringify({ error_summary: 'path/conflict/file/..' }) });
      if (mode['.tag'] === 'update' && existing && mode.update !== existing.rev) return res({ status: 409, body: JSON.stringify({ error_summary: 'path/conflict/..' }) });
      const rev = 'r' + (++revCounter);
      store.set(arg.path, { content: bodyText, rev });
      return res({ status: 200, body: JSON.stringify({ rev }) });
    }
    if (url.endsWith('/files/move_v2')) {
      const arg = JSON.parse(opts.body);
      const from = arg.from_path;
      const moved = [];
      for (const [p, m] of store) {
        if (p === from || p.startsWith(from + '/')) moved.push([p, arg.to_path + p.slice(from.length), m]);
      }
      if (moved.length === 0) return res({ status: 409, body: JSON.stringify({ error_summary: 'from_lookup/not_found/..' }) });
      for (const [p, np, m] of moved) { store.delete(p); store.set(np, m); }
      return res({ status: 200, body: JSON.stringify({ metadata: {} }) });
    }
    throw new Error('想定外のURL: ' + url);
  }
  return { fetchImpl, store };
}
function mockProgram(initial, configOverride) {
  const { fetchImpl, store } = makeMockDropbox(initial);
  const client = createDropboxClient({
    clientId: 't', fetchImpl,
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 },
  });
  return { program: createProgram(client, { programRoot: '/ArchPlan/Program', ...(configOverride || {}) }), store };
}

// ---------------------------------------------------------------------------
// ⑳ replaceUnderHeading（本文のみ置換・他は byte 不変）＋ buildEditLine ＋ memoStamp/firstLine（v1.8）
// ---------------------------------------------------------------------------
test('⑳ replaceUnderHeading / buildEditLine / memoStamp / firstLine（v1.8）', () => {
  const body =
`## 本文

古い本文。

## 注釈（私が記入）

注釈テキスト（触らない）。

## 処理記録

- ↳ 2026-07-15 作成
`;
  const next = P.replaceUnderHeading(body, '本文', '新しい本文\n2行目');
  assert.strictEqual(P.parseSections(next)['本文'], '新しい本文\n2行目', '本文は差し替わる');
  assert.strictEqual(next.slice(next.indexOf('## 注釈')), body.slice(body.indexOf('## 注釈')), '注釈以降は byte 不変');
  // 空本文へ
  const emptied = P.replaceUnderHeading(body, '本文', '');
  assert.strictEqual(P.parseSections(emptied)['本文'], '', '空本文にできる');
  assert.strictEqual(emptied.slice(emptied.indexOf('## 注釈')), body.slice(body.indexOf('## 注釈')), '空でも注釈以降 byte 不変');

  // buildEditLine（📱=モバイル）
  assert.strictEqual(P.buildEditLine('2026-07-15', '📱'), '- ↳ 2026-07-15 本文/タイトル編集（あなた・📱）');

  // memoStamp / memoFileName / firstLine
  const d = new Date(2026, 6, 16, 9, 8, 7); // 2026-07-16 09:08:07（月0始まり）
  assert.strictEqual(P.memoStamp(d), '20260716-090807');
  assert.strictEqual(P.memoFileName(d), 'M-20260716-090807.md');
  assert.strictEqual(P.firstLine('\n\n  最初の行  \n二行目'), '最初の行');
  assert.strictEqual(P.firstLine(''), '');
});

// ---------------------------------------------------------------------------
// ㉑ program.editCard: title と「## 本文」節のみ書き換え・注釈 byte 不変・処理記録に編集記録（v1.8）
// ---------------------------------------------------------------------------
test('㉑ program.editCard rewrites title/本文 only; 注釈 byte-identical; index regenerated (v1.8)', async () => {
  const cardMd =
`---
id: C-0001
title: 旧タイトル
direction: user-to-claude
type: reference
subject: 玄関
tags: []
surface: ""
status: new
created: 2026-07-15
---

## 本文

旧本文。

## 注釈（私が記入）

私の注釈（触らない）。

## 処理記録

- ↳ 2026-07-15 作成
`;
  const { program, store } = mockProgram({ '/ArchPlan/Program/Cards/C-0001_a/card.md': cardMd });

  await program.editCard('C-0001', { title: '新タイトル', body: '新しい本文\n2行目' });

  const after = store.get('/ArchPlan/Program/Cards/C-0001_a/card.md').content;
  const parsed = P.parseCard(after);
  assert.strictEqual(parsed.fm.title, '新タイトル', 'title が変わる');
  assert.strictEqual(parsed.fm.subject, '玄関', 'subject は不変');
  assert.strictEqual(parsed.fm.created, '2026-07-15', 'created は不変');
  const sec = P.parseSections(parsed.body);
  assert.strictEqual(sec['本文'], '新しい本文\n2行目', '本文が差し替わる');
  assert.strictEqual(sec['注釈（私が記入）'], '私の注釈（触らない）。', '注釈は byte 不変');
  assert.ok(sec['処理記録'].includes('本文/タイトル編集（あなた・📱）'), '処理記録に編集記録（📱）');
  assert.ok(sec['処理記録'].includes('作成'), '既存の作成記録も残る');
  // フォルダ名（slug）はリネームしない＝キーが同一
  assert.ok(store.has('/ArchPlan/Program/Cards/C-0001_a/card.md'), 'フォルダ名は変えない');
  // CARD_INDEX が新タイトルで再生成される
  const idx = store.get('/ArchPlan/Program/Cards/CARD_INDEX.md');
  assert.ok(idx && idx.content.includes('新タイトル') && !idx.content.includes('旧タイトル'), 'CARD_INDEX は新タイトルで再生成');
});

// ---------------------------------------------------------------------------
// ㉒ program メモ: 作成・一覧（新しい順・_done/_trash 除外）・更新・移動・パスガード（v1.8）
// ---------------------------------------------------------------------------
test('㉒ program memo create/list/update/move with _done/_trash exclusion and path guard (v1.8)', async () => {
  const { program, store } = mockProgram({
    '/ArchPlan/Program/Memos/M-20260716-100000.md': '新しいメモ\n二行目',
    '/ArchPlan/Program/Memos/M-20260716-090000.md': '古いメモ',
    '/ArchPlan/Program/Memos/_done/M-20260101-000000.md': 'カード化済み',
    '/ArchPlan/Program/Memos/_trash/M-20260101-000001.md': '削除済み',
  });

  // 一覧: _done/_trash を除外・新しい順（名前=時刻の降順）・先頭行を持つ
  let memos = await program.loadMemos();
  assert.deepStrictEqual(memos.map((m) => m.name), ['M-20260716-100000.md', 'M-20260716-090000.md'], '_done/_trash 除外・新しい順');
  assert.strictEqual(memos[0].firstLine, '新しいメモ', '先頭行を表示用に持つ');

  // 作成（プレーンテキストがそのまま保存）
  const created = await program.createMemo('作った\nメモ');
  assert.ok(/^M-\d{8}-\d{6}(-\d+)?$/.test(created.id), 'id は M-YYYYMMDD-HHMMSS');
  const createdKey = '/ArchPlan/Program/Memos/' + created.name;
  assert.strictEqual(store.get(createdKey).content, '作った\nメモ', 'プレーンテキストがそのまま保存');
  memos = await program.loadMemos();
  assert.strictEqual(memos.length, 3, '一覧が3件に増える');

  // 空メモは拒否
  await assert.rejects(program.createMemo('   '), /空/, '空メモは拒否');

  // 更新（内容の丸ごと書き換え）
  await program.updateMemo('M-20260716-090000.md', '書き換え');
  assert.strictEqual(store.get('/ArchPlan/Program/Memos/M-20260716-090000.md').content, '書き換え', '内容が更新される');

  // _done へ移動（物理削除でなく移動）
  await program.doneMemo('M-20260716-100000.md');
  assert.ok(!store.has('/ArchPlan/Program/Memos/M-20260716-100000.md'), 'Memos 直下から消える');
  assert.ok(store.has('/ArchPlan/Program/Memos/_done/M-20260716-100000.md'), '_done に残存（移動）');

  // _trash へ移動
  await program.trashMemo('M-20260716-090000.md');
  assert.ok(store.has('/ArchPlan/Program/Memos/_trash/M-20260716-090000.md'), '_trash に残存（移動）');

  // 一覧は移動後 _done/_trash を除外（作成した1件のみ残る）
  memos = await program.loadMemos();
  assert.deepStrictEqual(memos.map((m) => m.name), [created.name], '移動後は作成分のみ・_done/_trash 除外');

  // パスガード: Memos/ 外・不正名は拒否（更新・移動の入口）
  await assert.rejects(program.updateMemo('../INBOX.md', 'x'), /不正なメモ名/, '.. を含む名は拒否');
  await assert.rejects(program.trashMemo('M-x/../escape.md', ), /不正なメモ名/, '区切りを含む名は拒否');
  await assert.rejects(program.updateMemo('INBOX.md', 'x'), /不正なメモ名/, 'M- で始まらない名は拒否');
});

// ---------------------------------------------------------------------------
// ㉓ ソース構造: memo ビュー＝ Memo タブ／編集フォーム配線／Board のカード化フック（v1.8）
// ---------------------------------------------------------------------------
test('㉓ memo view = Memo tab; edit form wiring; board conversion hook (v1.8)', () => {
  const memo = readDoc('views/memo.js');
  assert.ok(/tabLabel:\s*'Memo'/.test(memo) && /id:\s*'memo'/.test(memo), 'memo ビューは id/tabLabel=memo');
  assert.ok(memo.includes('ctx.program.createMemo') && memo.includes('ctx.program.updateMemo'), '作成・更新を配線');
  assert.ok(memo.includes('ctx.program.doneMemo') && memo.includes('ctx.program.trashMemo'), 'カード化=_done・削除=_trash');
  assert.ok(memo.includes('ctx.requestNewCard'), 'カード化は Board の新規カードフォームを開く');

  const shared = readDoc('views/shared.js');
  const editFn = shared.slice(shared.indexOf('export function openEditCardSheet('));
  assert.ok(editFn.includes('ctx.program.editCard(card.id'), '編集フォームは editCard を配線');
  assert.ok(shared.includes('openEditCardSheet(ctx, card)'), '編集ボタンが編集フォームを開く');
});

// ---------------------------------------------------------------------------
// ㉔ 応答行の固定書式（Mac版と一字一句同一・📱）＋完了確定行＋extractChoices＋nowStamp（v2.1）
// ---------------------------------------------------------------------------
test('㉔ response line fixed format + done-confirm + extractChoices + nowStamp (v2.1)', () => {
  const dt = '2026-07-16 14:30';
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'ok'), '- 応答（あなた・📱 2026-07-16 14:30）: OK');
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'ng', { comment: '一言' }), '- 応答（あなた・📱 2026-07-16 14:30）: NG — 一言');
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'later'), '- 応答（あなた・📱 2026-07-16 14:30）: あとで');
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'choice', { choice: 'A', comment: 'コメント' }), '- 応答（あなた・📱 2026-07-16 14:30）: 選択=A — コメント');
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'choice', { choice: 'B' }), '- 応答（あなた・📱 2026-07-16 14:30）: 選択=B');
  assert.strictEqual(P.buildResponseLine(dt, '📱', 'comment', { comment: '本文' }), '- 応答（あなた・📱 2026-07-16 14:30）: コメント — 本文');
  assert.strictEqual(P.buildDoneConfirmLine(dt, '📱'), '- 完了確定（あなた・📱 2026-07-16 14:30）');
  assert.strictEqual(P.nowStamp(new Date(2026, 6, 16, 9, 5)), '2026-07-16 09:05');
  assert.deepStrictEqual(P.extractChoices('選択肢: A=残す／B=削除／C=やり直す'), ['A', 'B', 'C']);
  assert.deepStrictEqual(P.extractChoices('A=x A=y B=z'), ['A', 'B'], '重複排除');
  assert.deepStrictEqual(P.extractChoices('選択肢なし'), []);
  assert.deepStrictEqual(P.extractChoices('dataA=1'), [], '語中の A= は拾わない');

  // parseChoicePrefix / setChoicePrefix: 選択→送信の一括方式のプレフィックス処理（v2.7・C-U0004・Mac版と同一）
  assert.deepStrictEqual(P.parseChoicePrefix('選択=A コメント'), { choice: 'A', comment: 'コメント' });
  assert.deepStrictEqual(P.parseChoicePrefix('選択=A'), { choice: 'A', comment: '' }, 'コメントなし');
  assert.deepStrictEqual(P.parseChoicePrefix('選択=A '), { choice: 'A', comment: '' }, '末尾空白のみ＝コメントなし');
  assert.deepStrictEqual(P.parseChoicePrefix('ただのコメント'), { choice: '', comment: 'ただのコメント' }, 'prefix無し＝全文がコメント');
  assert.deepStrictEqual(P.parseChoicePrefix(''), { choice: '', comment: '' }, '空文字');
  assert.deepStrictEqual(P.parseChoicePrefix('選択＝A コメント'), { choice: 'A', comment: 'コメント' }, '全角＝');
  assert.deepStrictEqual(P.parseChoicePrefix('選択=A 複数 語 コメント'), { choice: 'A', comment: '複数 語 コメント' }, 'コメントに空白可');
  assert.strictEqual(P.setChoicePrefix('', 'A'), '選択=A ', '未入力→選択=A ');
  assert.strictEqual(P.setChoicePrefix('選択=A コメント', 'B'), '選択=B コメント', '別選択への置換＝コメント保持');
  assert.strictEqual(P.setChoicePrefix('既存コメント', 'A'), '選択=A 既存コメント', 'prefix無しコメントへ選択を前置');
});

// ---------------------------------------------------------------------------
// ㉕ program.respondCard の status 機械更新＋confirmDone＋NG一言必須（v2.1）
// ---------------------------------------------------------------------------
test('㉕ program.respondCard status transitions + confirmDone + NG requires comment (v2.1)', async () => {
  const cp = (dir) => '/ArchPlan/Program/Cards/' + dir + '/card.md';
  const mkMd = (id, status, type = 'review', body = 'x') =>
    `---\nid: ${id}\ntitle: t\ndirection: claude-to-user\ntype: ${type}\ntags: []\nsurface: ""\nstatus: ${status}\ncreated: 2026-07-15\n---\n\n## 本文\n\n${body}\n\n## 処理記録\n\n- ↳ 2026-07-15 作成\n`;
  const { program, store } = mockProgram({
    [cp('C-A0001_a')]: mkMd('C-A0001', 'review'),
    [cp('C-A0002_b')]: mkMd('C-A0002', 'review'),
    [cp('C-A0003_c')]: mkMd('C-A0003', 'review'),
    [cp('C-A0004_d')]: mkMd('C-A0004', 'review'),
    [cp('C-A0005_e')]: mkMd('C-A0005', 'new', 'decision', '選択肢: A=x／B=y'),
    [cp('C-A0006_f')]: mkMd('C-A0006', 'new', 'report'),
    [cp('C-A0007_g')]: mkMd('C-A0007', 'done-proposed', 'knowledge'),
    [cp('C-U0007_carry')]: mkMd('C-U0007', 'carried', 'reference'),
    [cp('C-A0009_i')]: mkMd('C-A0009', 'review', 'review'),
  });
  const st = (dir) => P.parseCard(store.get(cp(dir)).content).fm.status;
  const rec = (dir) => P.parseSections(P.parseCard(store.get(cp(dir)).content).body)['処理記録'];

  await program.respondCard('C-A0001', 'ok', {});
  assert.strictEqual(st('C-A0001_a'), 'consumed', 'review+OK→consumed');
  assert.ok(/- 応答（あなた・📱 .+?）: OK/.test(rec('C-A0001_a')));

  await program.respondCard('C-A0002', 'ok', { comment: 'よい' });
  assert.strictEqual(st('C-A0002_b'), 'consumed');
  assert.ok(rec('C-A0002_b').includes(': OK') && rec('C-A0002_b').includes(': コメント — よい'), 'OK行＋コメント行');

  await program.respondCard('C-A0003', 'ng', { comment: 'ここが変' });
  assert.strictEqual(st('C-A0003_c'), 'review', 'NGはreviewのまま（新仕様）');
  assert.ok(rec('C-A0003_c').includes(': NG — ここが変'));
  await assert.rejects(program.respondCard('C-A0003', 'ng', { comment: '  ' }), /一言|必須/, 'NGは一言必須');

  await program.respondCard('C-A0004', 'later', {});
  assert.strictEqual(st('C-A0004_d'), 'review');
  assert.ok(rec('C-A0004_d').includes(': あとで'));

  await program.respondCard('C-A0005', 'choice', { choice: 'A', comment: 'これで' });
  assert.strictEqual(st('C-A0005_e'), 'responded', 'decision+選択→responded');
  assert.ok(rec('C-A0005_e').includes(': 選択=A — これで'));
  await assert.rejects(program.respondCard('C-A0005', 'choice', { choice: '' }), /選択/, '選択は空不可');

  await program.respondCard('C-A0006', 'comment', { comment: 'メモ' });
  assert.strictEqual(st('C-A0006_f'), 'new', 'コメントは status 不変');
  assert.ok(rec('C-A0006_f').includes(': コメント — メモ'));
  await assert.rejects(program.respondCard('C-A0006', 'comment', { comment: '' }), /空/, '空コメント不可');

  await program.confirmDone('C-A0007');
  assert.strictEqual(st('C-A0007_g'), 'consumed', 'done-proposed+完了→consumed');
  assert.ok(/- 完了確定（あなた・📱 .+?）/.test(rec('C-A0007_g')));

  // carried + confirmDone → consumed ＋完了確定行（S-0006吸収・2026-07-17）
  await program.confirmDone('C-U0007');
  assert.strictEqual(st('C-U0007_carry'), 'consumed', 'carried+完了→consumed');
  assert.ok(/- 完了確定（あなた・📱 .+?）/.test(rec('C-U0007_carry')), 'carried でも完了確定行が入る');

  // confirmDone の対象は done-proposed／carried のみ（他 status は拒否・データ層の検証）
  await assert.rejects(program.confirmDone('C-A0009'), /done-proposed|carried|完了提案|申し送り/, 'review へ confirmDone は拒否');
});

// ---------------------------------------------------------------------------
// ㉖ target 欄: 後方互換の往復無損失＋program.setTarget＋typeTab の検索対象（v2.1）
// ---------------------------------------------------------------------------
test('㉖ target field: round-trip + program.setTarget + typeTab search wiring (v2.1)', async () => {
  const noTarget = '---\nid: C-001\ntitle: t\ndirection: user-to-claude\ntype: reference\ntags: []\nsurface: ""\nstatus: new\ncreated: 2026-07-15\n---\n\n## 本文\n\nx\n';
  const p = P.parseCard(noTarget);
  assert.deepStrictEqual(p.fm.target, [], '欄なしは target=[]');
  assert.strictEqual(P.serializeCard(p), noTarget, '欄なしでも byte 往復無損失（勝手に欄を足さない）');

  const withTarget = '---\nid: C-002\ntitle: t\ndirection: user-to-claude\ntype: reference\ntags: []\nsurface: ""\nstatus: new\ncreated: 2026-07-15\ntarget: [SP01, CM07]\n---\n\n## 本文\n\nx\n';
  assert.deepStrictEqual(P.parseCard(withTarget).fm.target, ['SP01', 'CM07']);
  assert.strictEqual(P.serializeCard(P.parseCard(withTarget)), withTarget, 'target 付きも byte 往復無損失');
  assert.deepStrictEqual(P.readCardFromText(withTarget, 'C-002_x', []).target, ['SP01', 'CM07'], 'readCardFromText が target を持つ');

  const cardPath = '/ArchPlan/Program/Cards/C-0001_a/card.md';
  const { program, store } = mockProgram({ [cardPath]: noTarget.replace('C-001', 'C-0001') });
  await program.setTarget('C-0001', 'SP01, CM07 AP02');
  assert.ok(/^target: \[SP01, CM07, AP02\]$/m.test(store.get(cardPath).content), 'target 行が書き出される');

  const typeTab = readDoc('views/typeTab.js');
  assert.ok(typeTab.includes('(card.target || []).join'), 'typeTab の全文検索対象に target が含まれる');
});

// ---------------------------------------------------------------------------
// ㉗ loadCards は _archive を archived フラグ付きで含める・台帳からは除外（検索のみ）（v2.1）
// ---------------------------------------------------------------------------
test('㉗ loadCards includes _archive with archived flag; excluded from index (v2.1)', async () => {
  const mkMd = (id, type = 'reference', title = 't') =>
    `---\nid: ${id}\ntitle: ${title}\ndirection: user-to-claude\ntype: ${type}\ntags: []\nsurface: ""\nstatus: new\ncreated: 2026-07-15\n---\n\n## 本文\n\nx\n`;
  const { program, store } = mockProgram({
    '/ArchPlan/Program/Cards/C-0001_a/card.md': mkMd('C-0001'),
    '/ArchPlan/Program/Cards/_archive/C-A0001_old/card.md': mkMd('C-A0001', 'knowledge', '過去xyzzy'),
    '/ArchPlan/Program/Cards/_trash/C-0002_b/card.md': mkMd('C-0002'),
  });
  const { cards, cardDirs } = await program.loadCards();
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.ok(byId['C-0001'] && !byId['C-0001'].archived, '現役は archived なし');
  assert.strictEqual(byId['C-A0001'] && byId['C-A0001'].archived, true, 'アーカイブは archived:true');
  assert.ok(!byId['C-0002'], '_trash は走査除外');
  assert.deepStrictEqual(cardDirs, ['C-0001_a'], 'cardDirs は現役のみ（_archive/_trash 除外）');
  assert.strictEqual(byId['C-A0001'].dir, '_archive/C-A0001_old', 'アーカイブの dir は _archive/ 付き');

  await program.regenerateIndex();
  const idx = store.get('/ArchPlan/Program/Cards/CARD_INDEX.md');
  assert.ok(idx && idx.content.includes('C-0001') && !idx.content.includes('C-A0001'), 'CARD_INDEX はアーカイブ除外');
});

// ---------------------------------------------------------------------------
// ㉘ Sheets: 項目ブロック分割＋💬コメント挿入位置と byte 不変（parser・Mac版と挙動互換・v2.2）
// ---------------------------------------------------------------------------
test('㉘ sheet blocks (heading + numbered) and 💬 comment insertion + byte-invariance (v2.2)', () => {
  // (a) 見出しブロック（シナリオ/完成定義形式）
  const scen = '# SC-001 タイトル\n\n> メタ\n\n## ステップ\n\n### SC-001-S01 一つ目\n- 状況: x\n\n### SC-001-S02 二つ目\n- 状況: y\n';
  const hb = P.parseSheetBlocks(scen, false);
  assert.deepStrictEqual(hb.map((b) => b.id), ['SC-001', 'ステップ', 'SC-001-S01', 'SC-001-S02'], '見出しの先頭トークンがID');
  assert.ok(hb.every((b) => b.kind === 'heading'));

  // (b) 番号項目ブロック（RDS形式）
  const rds = '## REQ-DOC-001 一意性\n〔AI抽出〕\n\n1. [人間] item one\n- 補足1\n  💬 ok\n\n2. [AI] item two\n- 補足2\n\n';
  const nb = P.parseSheetBlocks(rds, true);
  assert.deepStrictEqual(nb.map((b) => ({ kind: b.kind, id: b.id })),
    [{ kind: 'heading', id: 'REQ-DOC-001' }, { kind: 'item', id: '1' }, { kind: 'item', id: '2' }],
    '見出し1＋番号項目2（列0の N. のみ・- 補足や 💬 は分割しない）');

  // (c) 💬 コメント行の書式（📱・固定）
  const line = P.buildSheetCommentLine('2026-07-16 14:30', '📱', '本文  改\n行');
  assert.strictEqual(line, '💬（📱 2026-07-16 14:30）: 本文  改 行', '💬（📱 日時）: 本文（改行は空白化）');

  // (d) 挿入位置 = 当該項目の直下・次項目の直前。他部分は byte 不変。
  const i1 = nb.findIndex((b) => b.kind === 'item' && b.id === '1');
  const out = P.insertSheetCommentInBody(rds, i1, line, true);
  const expected = '## REQ-DOC-001 一意性\n〔AI抽出〕\n\n1. [人間] item one\n- 補足1\n  💬 ok\n' + line + '\n\n2. [AI] item two\n- 補足2\n\n';
  assert.strictEqual(out, expected, '項目1の末尾（💬 ok の直後・空行の前）に挿入');
  assert.strictEqual(out.replace('\n' + line, ''), rds, '挿入行を除けば元と byte 一致');

  // (e) frontmatter は byte 不変（本文のみ変わる）
  const withFm = '---\nid: SC-001\nstate: reviewed\nreview_card: C-A0001\n---\n\n### SC-001-S01 a\n- x\n\n### SC-001-S02 b\n- y\n';
  const blocks = P.parseSheetBlocks(P.parseCard(withFm).body, false);
  const i0 = blocks.findIndex((b) => b.id === 'SC-001-S01');
  const out2 = P.insertSheetComment(withFm, i0, line, false);
  assert.ok(out2.startsWith('---\nid: SC-001\nstate: reviewed\nreview_card: C-A0001\n---\n'), 'frontmatter は byte 不変');
  assert.ok(out2.includes('- x\n' + line + '\n'), 'S01 の直下に挿入');

  // (f) frontmatter メタ・state 行のみ書き換え・折りたたみ判定・sheetPayload
  assert.deepStrictEqual(P.parseSheetMeta('# no fm\nx\n'), { hasFrontmatter: false, state: null, reviewCard: null });
  assert.deepStrictEqual(P.parseSheetMeta(withFm), { hasFrontmatter: true, state: 'reviewed', reviewCard: 'C-A0001' });
  assert.strictEqual(P.setSheetState(withFm, 'approved'), withFm.replace('state: reviewed', 'state: approved'), 'state 行のみ approved');
  const critique = '## 批評履歴\n- 指摘1\n\n### 通常\n- x\n';
  const cb = P.parseSheetBlocks(critique, false);
  assert.strictEqual(P.sheetBlockCollapses(cb[0]), true, '「批評」見出しは折りたたみ対象');
  assert.strictEqual(P.sheetBlockCollapses(cb[1]), false);
  const pay = P.sheetPayload(withFm, false);
  assert.strictEqual(pay.blocks.length, 2);
  assert.ok(pay.blocks[0].raw.includes('### SC-001-S01'), 'blocks に raw が入る');
});

// ---------------------------------------------------------------------------
// ㉘b Sheets: CASE分割（トップレベル`- [ ]`＝サブ項目開始）＋各CASE直下への💬挿入＋トグル錨（v2.6・Mac版と挙動互換）
// ---------------------------------------------------------------------------
test('㉘b sheet CASE split: top-level checkbox = sub-item; per-CASE 💬 insert; toggle anchor', () => {
  const caseSheet =
    '## ケース表\n' +
    '\n' +
    '- [ ] **CASE-01 タイトルA**\n' +
    '  - 前提: x\n' +
    '  - 対象: PL\n' +
    '- [x] **CASE-02 タイトルB**\n' +
    '  - 前提: y\n' +
    '\n' +
    '## 前提\n' +
    '- 軸1: a\n' +
    '- 軸2: b\n';

  // (a) 見出し＋トップレベルCASE2件＋チェックボックス無し見出しに分割
  const blks = P.parseSheetBlocks(caseSheet, false);
  assert.deepStrictEqual(blks.map((b) => ({ kind: b.kind, id: b.id })), [
    { kind: 'heading', id: 'ケース表' },
    { kind: 'case', id: 'CASE-01' },
    { kind: 'case', id: 'CASE-02' },
    { kind: 'heading', id: '前提' },
  ], 'ケース表＝見出し / CASE-01・CASE-02＝case / 前提＝見出し');

  // (b) チェックボックスを含まない見出しは分割されず1欄（従来どおり）
  const zen = blks[3];
  const zenRaw = caseSheet.slice(zen.start, zen.end);
  assert.ok(zenRaw.includes('- 軸1: a') && zenRaw.includes('- 軸2: b'), '普通の箇条書きは分割しない');

  // (c) CASE欄への💬挿入 = 当該CASEのぶら下がり末尾・次CASE/見出しの前。他部分 byte 不変。
  const line = P.buildSheetCommentLine('2026-07-17 10:00', '📱', 'これで良い');
  const out1 = P.insertSheetCommentInBody(caseSheet, 1, line, false);
  assert.ok(out1.includes('  - 対象: PL\n' + line + '\n- [x] **CASE-02'), 'CASE-01 の対象:PL 直後・CASE-02 の前へ');
  assert.strictEqual(out1.replace('\n' + line, ''), caseSheet, '挿入行を除けば元と byte 一致');
  const out2 = P.insertSheetCommentInBody(caseSheet, 2, line, false);
  assert.ok(out2.includes('  - 前提: y\n' + line + '\n\n## 前提'), 'CASE-02 のぶら下がり末尾・次見出しの前へ');

  // (d) 分割後もトグル書き戻しは正しい全文行に当たる（行番号照合）
  const scan = P.scanSheetCheckboxes(caseSheet);
  assert.deepStrictEqual(scan.map((c) => [c.line, c.indent, c.checked]), [[2, 0, false], [5, 0, true]], 'CASE行は全文2行目・5行目');
  const toggled = P.toggleCheckboxLine(caseSheet, 2, '- [ ] **CASE-01 タイトルA**');
  assert.ok(toggled.includes('- [x] **CASE-01 タイトルA**'), 'CASE-01 行のトグルが正しい行に当たる');
});

// ---------------------------------------------------------------------------
// ㉙ Sheets: sheetArchplanRoot 導出＋program.listSheets/readSheet/addSheetComment/approveSheet（v2.2）
// ---------------------------------------------------------------------------
test('㉙ program sheets: list/read/comment/approve with path derivation and activation (v2.2)', async () => {
  // 親導出: '/ArchPlan/Program' → '/ArchPlan'
  assert.strictEqual(sheetArchplanRoot('/ArchPlan/Program'), '/ArchPlan');
  assert.strictEqual(sheetArchplanRoot('/ArchPlan/Program/'), '/ArchPlan');

  const scDir = '/ArchPlan/Docs/ConOps/Scenarios';
  const tdDir = '/ArchPlan/archplan-core/Docs/TestDefinitions';
  const rdsDir = '/ArchPlan/Projects/RequirementManagement/Works/RDS';
  const scText = '---\nid: SC-001\nstate: reviewed\nreview_card: C-A0001\n---\n\n### SC-001-S01 a\n- x\n\n### SC-001-S02 b\n- y\n';
  const reviewCard = '/ArchPlan/Program/Cards/C-A0001_sc/card.md';
  const reviewMd = '---\nid: C-A0001\ntitle: SC-001承認\ndirection: claude-to-user\ntype: review\ntags: []\nsurface: ""\nstatus: review\ncreated: 2026-07-16\n---\n\n## 本文\n\nx\n\n## 処理記録\n\n- ↳ 2026-07-16 作成\n';
  const { program, store } = mockProgram({
    [scDir + '/SC-001.md']: scText,
    [scDir + '/_TEMPLATE.md']: '# t\n',
    [scDir + '/SC_MAP.md']: '# map\n',
    [tdDir + '/METHOD.md']: '# m\n',
    [tdDir + '/GLOSSARY.md']: '# g\n',
    [tdDir + '/features/玄関配置.md']: '# 玄関\n',
    [rdsDir + '/RDS_DOC.md']: '## REQ-DOC-001 x\n\n1. [人間] one\n- s\n\n2. [AI] two\n\n',
    [rdsDir + '/OTHER.md']: '# o\n',
    [reviewCard]: reviewMd,
  }, { sheetSources: APP_CONFIG.sheetSources });

  // (a) listSheets: 除外規則が効く（_TEMPLATE/SC_MAP/METHOD*/_・OTHER 除外・features は再帰で拾う）
  const list = await program.listSheets();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.files.map((f) => f.file)]));
  assert.deepStrictEqual(byId.scenario, ['SC-001.md'], 'scenario は SC-*.md のみ');
  assert.deepStrictEqual(byId.completion, ['GLOSSARY.md', 'features/玄関配置.md'], 'completion は再帰＋METHOD*/_ 除外');
  assert.deepStrictEqual(byId.rds, ['RDS_DOC.md'], 'rds は RDS_*.md のみ');

  // (b) readSheet: 番号項目ブロック＋メタ
  const rd = await program.readSheet('rds', 'RDS_DOC.md');
  assert.strictEqual(rd.blocks.filter((b) => b.kind === 'item').length, 2, 'RDS は番号項目2');
  const sc = await program.readSheet('scenario', 'SC-001.md');
  assert.deepStrictEqual(sc.meta, { hasFrontmatter: true, state: 'reviewed', reviewCard: 'C-A0001' });

  // (c) addSheetComment: 項目直下へ📱コメント（rev リトライ経由・他部分 byte 不変）
  const i1 = rd.blocks.findIndex((b) => b.kind === 'item' && b.id === '1');
  await program.addSheetComment('rds', 'RDS_DOC.md', i1, 'これで良い');
  const rdsAfter = store.get(rdsDir + '/RDS_DOC.md').content;
  assert.ok(/1\. \[人間\] one\n- s\n💬（📱 .+?）: これで良い\n\n2\. \[AI\]/.test(rdsAfter), '項目1直下に📱コメント挿入');

  // (d) パスガード: 対象外/.. を拒否
  await assert.rejects(program.readSheet('scenario', '../../evil.md'), /不正|対象外/);
  await assert.rejects(program.readSheet('completion', 'METHOD.md'), /対象外/, '除外ファイル直接読取り拒否');

  // (e) 承認活性条件: draft/frontmatter無しは不可（review_card は任意＝改定 2026-07-17・(g) で検証）
  store.set(scDir + '/SC-001.md', { content: scText.replace('state: reviewed', 'state: draft'), rev: 'rx' });
  await assert.rejects(program.approveSheet('scenario', 'SC-001.md'), /reviewed/, 'draft は承認不可');
  store.set(scDir + '/SC-001.md', { content: '# no fm\n### x\n- y\n', rev: 'ry' });
  await assert.rejects(program.approveSheet('scenario', 'SC-001.md'), /frontmatter/, 'frontmatter無しは承認不可');

  // (f) 正常承認: reviewカードOK+consumed / シート state approved
  store.set(scDir + '/SC-001.md', { content: scText, rev: 'rz' });
  const res = await program.approveSheet('scenario', 'SC-001.md');
  assert.ok(res.ok && res.reviewCard === 'C-A0001');
  const cardAfter = store.get(reviewCard).content;
  assert.ok(/^status: consumed$/m.test(cardAfter), 'reviewカードが consumed');
  assert.ok(/- 応答（あなた・📱 .+?）: OK/.test(cardAfter), 'reviewカードへ OK 応答行');
  assert.ok(/^state: approved$/m.test(store.get(scDir + '/SC-001.md').content), 'シート state approved');

  // (g) review_card 任意化（2026-07-17）: 無くても reviewed＋全チェック（0個は免除）なら承認可（state のみ更新・reviewカード連動なし）
  store.set(scDir + '/SC-002.md', { content: '---\nid: SC-002\nstate: reviewed\n---\n\n### x\n- y\n', rev: 'r2' });
  const res2 = await program.approveSheet('scenario', 'SC-002.md');
  assert.ok(res2.ok && res2.reviewCard === '', 'review_card 無しでも承認可');
  assert.ok(/^state: approved$/m.test(store.get(scDir + '/SC-002.md').content), 'review_card 無し承認は state のみ approved へ');
});

// ---------------------------------------------------------------------------
// §2-4(A) 項目チェックボックス: 走査・カウント・1字トグル（byte不変・ネスト・不一致拒否・大文字X）（v2.5）
// ---------------------------------------------------------------------------
test('§2-4(A) checkbox scan/count/toggle: 1-char write, nesting, mismatch reject, uppercase X', () => {
  const body = '### 条件\n- [ ] ケース1\n  - [x] 子ケース\n- [X] 大文字\nふつうの行\n';
  const scanned = P.scanSheetCheckboxes(body);
  assert.deepStrictEqual(scanned.map((c) => [c.line, c.indent, c.checked, c.char, c.text]), [
    [1, 0, false, ' ', 'ケース1'],
    [2, 2, true, 'x', '子ケース'],
    [3, 0, true, 'X', '大文字'],
  ], 'チェックボックス3行を走査');
  assert.deepStrictEqual(P.countSheetCheckboxes(body), { total: 3, checked: 2, unchecked: 1 });
  assert.deepStrictEqual(P.countSheetCheckboxes('（チェックなし）\n- 普通の箇条書き\n'), { total: 0, checked: 0, unchecked: 0 });

  // (a) [ ]→[x]（該当1字のみ変化・前後 byte 一致）
  const t1 = P.toggleCheckboxLine(body, 1, '- [ ] ケース1');
  assert.strictEqual(t1, body.replace('- [ ] ケース1', '- [x] ケース1'), '[ ]→[x] は1字のみ');
  let diff = 0; for (let i = 0; i < body.length; i++) if (body[i] !== t1[i]) diff++;
  assert.strictEqual(diff, 1, '変化は角括弧内の1字のみ');

  // (b) ネスト行 [x]→[ ]
  assert.strictEqual(P.toggleCheckboxLine(body, 2, '  - [x] 子ケース'),
    body.replace('  - [x] 子ケース', '  - [ ] 子ケース'), 'ネスト行トグル');
  // (c) 大文字 X はトグルで [ ] へ
  assert.strictEqual(P.toggleCheckboxLine(body, 3, '- [X] 大文字'),
    body.replace('- [X] 大文字', '- [ ] 大文字'), '[X]→[ ]');
  // (d) 不一致・非チェック行・範囲外は拒否
  assert.throws(() => P.toggleCheckboxLine(body, 1, '- [ ] 別'), /変化しています/);
  assert.throws(() => P.toggleCheckboxLine(body, 4, 'ふつうの行'), /チェックボックス行では/);
  assert.throws(() => P.toggleCheckboxLine(body, 99, null), /範囲外/);

  // (e) sheetPayload に checkStats と block.startLine が入る
  const fm = '---\nid: SC-001\nstate: reviewed\nreview_card: C-A0001\n---\n\n### 条件\n- [ ] ケース1\n- [x] ケース2\n';
  const pay = P.sheetPayload(fm, false);
  assert.deepStrictEqual(pay.checkStats, { total: 2, checked: 1, unchecked: 1 }, 'checkStats');
  // 全文行: 0=--- 1=id 2=state 3=review_card 4=--- 5=空 6=### 条件
  assert.strictEqual(pay.blocks[0].startLine, 6, 'block.startLine は全文行番号');
});

// ---------------------------------------------------------------------------
// §2-4(B/C/D) program: 承認ゲート＋トグル書き戻し＋承認後 reviewed 戻し＋完成定義（rev楽観ロック）（v2.5）
// ---------------------------------------------------------------------------
test('§2-4(B/C/D) program approve gate + toggle write-back + post-approval revert', async () => {
  const scDir = '/ArchPlan/Docs/ConOps/Scenarios';
  const tdDir = '/ArchPlan/archplan-core/Docs/TestDefinitions';
  const reviewCard = '/ArchPlan/Program/Cards/C-A0001_sc/card.md';
  const reviewMd = '---\nid: C-A0001\ntitle: 承認\ndirection: claude-to-user\ntype: review\ntags: []\nsurface: ""\nstatus: review\ncreated: 2026-07-16\n---\n\n## 本文\n\nx\n\n## 処理記録\n\n- ↳ 2026-07-16 作成\n';
  const withChecks = (s1, s2, st) =>
    '---\nid: SC-001\nstate: ' + (st || 'reviewed') + '\nreview_card: C-A0001\n---\n\n### 条件\n- [' + s1 + '] ケース1\n- [' + s2 + '] ケース2\n';

  const { program, store } = mockProgram({
    [scDir + '/SC-001.md']: withChecks(' ', 'x'),
    [tdDir + '/features/玄関配置.md']: '---\nid: DOD-玄関\nstate: reviewed\nreview_card: C-A0001\n---\n\n## 完成条件\n- [ ] 条件1\n- [ ] 条件2\n',
    [reviewCard]: reviewMd,
  }, { sheetSources: APP_CONFIG.sheetSources });

  // (B) 未チェックが残れば承認拒否（残数付き）
  await assert.rejects(program.approveSheet('scenario', 'SC-001.md'), /未チェック.*1 件/, '未チェック1件で拒否');

  // (A) トグル書き戻し（全文行7 = '- [ ] ケース1'・reviewed のまま state 不変）
  const before = store.get(scDir + '/SC-001.md').content;
  await program.toggleSheetCheckbox('scenario', 'SC-001.md', 7, '- [ ] ケース1');
  const after = store.get(scDir + '/SC-001.md').content;
  assert.strictEqual(after, before.replace('- [ ] ケース1', '- [x] ケース1'), 'トグルは1字のみ・state 不変');

  // 行不一致トグルは拒否（transform が throw → updateTextFileWithRetry は propagate）
  await assert.rejects(program.toggleSheetCheckbox('scenario', 'SC-001.md', 7, '- [ ] 変わった内容'), /変化しています/);

  // (B) 全 [x] で承認可（reviewカード OK+consumed・シート approved）
  const res = await program.approveSheet('scenario', 'SC-001.md');
  assert.ok(res.ok && res.reviewCard === 'C-A0001', '承認成功');
  assert.ok(/^state: approved$/m.test(store.get(scDir + '/SC-001.md').content), 'state approved');
  assert.ok(/^status: consumed$/m.test(store.get(reviewCard).content), 'reviewカード consumed');

  // (C) approved でトグル → reviewed へ戻る
  await program.toggleSheetCheckbox('scenario', 'SC-001.md', 7, '- [x] ケース1');
  let now = store.get(scDir + '/SC-001.md').content;
  assert.ok(/^state: reviewed$/m.test(now) && /- \[ \] ケース1/.test(now), 'approved でトグル→ reviewed へ戻る');

  // (C) approved でコメント追記 → reviewed へ戻る
  store.set(scDir + '/SC-001.md', { content: withChecks('x', 'x', 'approved'), rev: 'rz' });
  await program.addSheetComment('scenario', 'SC-001.md', 0, '確認しました');
  now = store.get(scDir + '/SC-001.md').content;
  assert.ok(/^state: reviewed$/m.test(now) && /💬（📱 .+?）: 確認しました/.test(now), 'approved でコメント→ reviewed');

  // (B) チェック0個は従来どおり承認可
  store.set(scDir + '/SC-001.md', { content: '---\nid: SC-001\nstate: reviewed\nreview_card: C-A0001\n---\n\n### 条件\n- 普通の箇条書き\n', rev: 'r0' });
  store.set(reviewCard, { content: reviewMd, rev: 'rc' });
  assert.ok((await program.approveSheet('scenario', 'SC-001.md')).ok, 'チェック0個は承認可');

  // (D) 完成定義ソースでも同一機構（全文行7,8 = 条件1,2）
  await assert.rejects(program.approveSheet('completion', 'features/玄関配置.md'), /未チェック/, '完成定義も未チェックで拒否');
  await program.toggleSheetCheckbox('completion', 'features/玄関配置.md', 7, '- [ ] 条件1');
  await program.toggleSheetCheckbox('completion', 'features/玄関配置.md', 8, '- [ ] 条件2');
  store.set(reviewCard, { content: reviewMd, rev: 'rc2' });
  assert.ok((await program.approveSheet('completion', 'features/玄関配置.md')).ok, '完成定義も全チェックで承認可');
});

// ---------------------------------------------------------------------------
// ㉚ Sheets view: 群配線・ソース一覧・項目コメント・承認の配線（ソース文字列検証）（v2.2）
// ---------------------------------------------------------------------------
test('㉚ sheets view + group wiring (source-text checks) (v2.2)', () => {
  const sheets = readDoc('views/sheets.js');
  assert.ok(sheets.includes("registerView({ id: 'sheets'"), 'sheets ビューが登録される');
  assert.ok(sheets.includes('ctx.program.listSheets()') && sheets.includes('ctx.program.readSheet('), '一覧＋開くを program に委譲');
  assert.ok(sheets.includes('ctx.program.addSheetComment(') && sheets.includes('ctx.program.approveSheet('), 'コメント＋承認を program に委譲');
  assert.ok(sheets.includes('ctx.program.toggleSheetCheckbox('), 'チェックボックスのトグルを program に委譲（§2-4）');
  assert.ok(sheets.includes('未チェック') && sheets.includes('checkStats'), '未チェック残数の表示＋承認ゲート（§2-4 B）');
  assert.ok(!sheets.includes('editSheet') && !sheets.includes('replaceUnderHeading') && !sheets.includes('editCard'), '本文編集UIは提供しない（コメントのみ）');
  assert.ok(sheets.includes("st === 'reviewed'") && sheets.includes('meta.reviewCard'), '承認ボタンは review_card+reviewed で活性');
  assert.ok(sheets.includes('block.collapse') && sheets.includes('details'), '批評ブロックは details で折りたたみ');

  // 群配線（app.js）
  const app = readDoc('app.js');
  assert.ok(app.includes('buildGroupbar') && app.includes('enabledViewIdsForGroup(ctx.state.activeGroup)'), 'buildTabbar は群でフィルタ');
  assert.ok(app.includes('function setGroup('), '群切替 setGroup がある');

  // Sessions は Phase4 で実装済み（準備中プレースホルダは廃止・詳細は ㊴）
  assert.ok(!readDoc('views/sessions.js').includes('準備中'), 'Sessions の準備中プレースホルダは廃止');
});

// ---------------------------------------------------------------------------
// ㉛ Views アダプタ: parseCensus（正常＋崩れ行skip・FPUコード継承・§1/§2のみ）（v2.3）
// ---------------------------------------------------------------------------
test('㉛ parseCensus: checklist rows, tag split, code inheritance, broken-row skip (v2.3)', () => {
  const census = [
    '## §1 カテゴリ別の機能チェックリスト',
    '### PL（プランニング機能・132行）',
    '- [ ] **敷地の配置**（PL_SP_SP）',
    '  - [ ] カスタム敷地の配置 — ユーザーが任意の形状で配置 [未実装/MG/S6]',
    '  - [x] 敷地の初期配置 — テストケースから初期配置 [実装/AG/済]',
    '- [ ] 周辺状況の配置（隣地建物）（PL_SP_CTX） [不明/AG/S3]',
    '- [ ] 壊れ行 [未実装/AG]',
    '## §2 リスト外の追記',
    '### MF 集合住宅系',
    '  - [ ] 複数棟の自動配棟 ◇ [未実装/AG/S5]',
    '## §3 件数サマリ',
    '- [ ] これは無視される [実装/AG/済]',
  ].join('\n');
  const { records, skipped } = P.parseCensus(census);
  assert.strictEqual(skipped, 1, '崩れ行1件skip');
  assert.ok(!records.some((r) => r.name === 'これは無視される'), '§3以降は非収集');
  const custom = records.find((r) => r.name === 'カスタム敷地の配置');
  assert.strictEqual(custom.joinKey, 'PL_SP_SP', '子FPUは親コードを継承');
  assert.deepStrictEqual([custom.state, custom.form, custom.stage], ['未実装', 'MG', 'S6']);
  assert.strictEqual(records.find((r) => r.name === '敷地の初期配置').done, true, 'x はdone');
  const ctx = records.find((r) => r.name.startsWith('周辺状況の配置'));
  assert.strictEqual(ctx.fpu, 'PL_SP_CTX', 'コード括弧のみ採用');
  const mf = records.find((r) => r.name === '複数棟の自動配棟');
  assert.ok(mf && mf.stage === 'S5' && mf.category === 'MF', '§2収集・◇除去');
});

// ---------------------------------------------------------------------------
// ㉜ Views 合成: task/lane/testColor/レコードの形・test_status 未存在→null/存在→重ね（v2.3）
// ---------------------------------------------------------------------------
test('㉜ progress synthesis: task/lane/testColor + row shape (Mac版と挙動互換) (v2.3)', () => {
  const census = ['## §1 x', '### PL（p）', '- [ ] 基準線の計算（PL_SP_BSLC） [実装/AG/済]', '- [ ] テラスの配置（PL_SP_TRCP） [未実装/AG/S1]'].join('\n');
  const ledger = ['## 未分類', '- PL_SP_BSLC の余裕率を見直す', '- 別件'].join('\n');
  const lanes = ['## 1. レーン欄', '### SP（敷地）', '- 担当: PL_SP_BSLC 稼働中', '### AP', '- 無関係'].join('\n');
  const cRes = P.parseCensus(census), lRes = P.parseTaskLedger(ledger), laRes = P.parseLanes(lanes);

  const rows0 = P.buildProgressRows(cRes, lRes, laRes, P.parseTestStatus(null));
  const bslc = rows0.find((r) => r.id === 'PL_SP_BSLC');
  assert.strictEqual(bslc.taskCount, 1, 'コード一致でタスク1');
  assert.strictEqual(bslc.laneActive, true, 'レーン出現→稼働');
  assert.strictEqual(bslc.testColor, null, 'test_status未存在→無表示');
  assert.deepStrictEqual({ id: bslc.id, stage: bslc.stage, state: bslc.state, form: bslc.form },
    { id: 'PL_SP_BSLC', stage: '済', state: '実装', form: 'AG' });
  assert.strictEqual(rows0.find((r) => r.id === 'PL_SP_TRCP').taskCount, 0);

  const map = P.parseTestStatus(JSON.stringify({ PL_SP_BSLC: 'green', PL_SP_TRCP: 'fail' }));
  const rows = P.buildProgressRows(cRes, lRes, laRes, map);
  assert.strictEqual(rows.find((r) => r.id === 'PL_SP_BSLC').testColor, 'green');
  assert.strictEqual(rows.find((r) => r.id === 'PL_SP_TRCP').testColor, 'red', 'fail→red');
  assert.strictEqual(P.parseTestStatus('{壊れ'), null, '壊れJSON→null');
  assert.deepStrictEqual(P.libraryMdBlocks('# A\n## B\n- x\n### C\n').map((b) => b.heading), ['A', 'B', 'C'], 'md見出しブロック抽出');
});

// ---------------------------------------------------------------------------
// ㉝ program.loadProgress: 4源泉をアダプタ経由で合成（開いた時のみ取得・fetchモック）（v2.3）
// ---------------------------------------------------------------------------
test('㉝ program.loadProgress synthesizes 4 sources (open-on-demand) (v2.3)', async () => {
  const A = '/ArchPlan';
  const { program } = mockProgram({
    [A + '/Projects/DevelopmentPlan/FEATURE_FPU_CENSUS.md']: '## §1 x\n### PL（p）\n- [ ] 基準線の計算（PL_SP_BSLC） [実装/AG/済]\n',
    [A + '/Projects/DevelopmentPlan/TASK_LEDGER.md']: '## 未分類\n- PL_SP_BSLC 見直す\n',
    [A + '/Projects/TestSystem/LANES_BOARD_2026-07.md']: '## 1. レーン欄\n### SP\n- PL_SP_BSLC 稼働\n',
    // test_status.json は置かない＝未存在
  }, { progressSources: APP_CONFIG.progressSources, librarySources: APP_CONFIG.librarySources });
  const p = await program.loadProgress();
  assert.strictEqual(p.sources.census, true);
  assert.strictEqual(p.sources.testStatus, false, 'test_status未存在→false（無表示）');
  const row = p.rows.find((r) => r.id === 'PL_SP_BSLC');
  assert.ok(row && row.taskCount === 1 && row.laneActive === true && row.testColor === null, '合成が効く');
});

// ---------------------------------------------------------------------------
// ㉞ program.listLibrary/readLibraryItem: 存在確認・未整備の無事故・md/json ペイロード（v2.3）
// ---------------------------------------------------------------------------
test('㉞ program library list/read: availability, missing-axis graceful, md/json (v2.3)', async () => {
  const A = '/ArchPlan';
  const { program } = mockProgram({
    [A + '/archplan-core/Docs/Conditions/ELEMENT_CATALOG.md']: '# 設計条件\n\n## CN-1 敷地\nx\n\n## CN-2 道路\ny\n',
    [A + '/archplan-core/Docs/Features/FEATURE_LIST.json']: JSON.stringify({ meta: { name: 'x' } }),
    // com/screen/operation/project/requirement は置かない＝未整備
  }, { progressSources: APP_CONFIG.progressSources, librarySources: APP_CONFIG.librarySources });

  const list = await program.listLibrary();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.available]));
  assert.deepStrictEqual(list.map((s) => s.id),
    ['feature', 'com', 'condition', 'operation', 'screen', 'project', 'quality', 'requirement'], 'View9の8軸');
  assert.strictEqual(byId.condition, true, '実在md→available');
  assert.strictEqual(byId.feature, true, '実在json→available');
  assert.strictEqual(byId.quality, false, 'sub:null（品質基準枠）→未整備');
  assert.strictEqual(byId.com, false, '未存在→未整備（無事故）');

  const md = await program.readLibraryItem('condition');
  assert.ok(md.type === 'md' && md.available && md.blocks.some((b) => b.heading === 'CN-1 敷地'), 'md見出しブロック');
  const js = await program.readLibraryItem('feature');
  assert.ok(js.type === 'json' && js.parsedOk && js.pretty.includes('"name"'), 'json整形');
  const q = await program.readLibraryItem('quality');
  assert.strictEqual(q.available, false, '未整備軸→available:false（無事故）');
});

// ---------------------------------------------------------------------------
// ㉟ program.createViewCommentCard: C-U採番・target・本文=コメント+引用・正本無書き込み（3-4）
// ---------------------------------------------------------------------------
test('㉟ view comment creates consult card (C-U, target, quote, source untouched) (v2.3)', async () => {
  const A = '/ArchPlan';
  const censusPath = A + '/Projects/DevelopmentPlan/FEATURE_FPU_CENSUS.md';
  const censusText = '## §1 x\n### PL（p）\n- [ ] 基準線の計算（PL_SP_BSLC） [実装/AG/済]\n';
  const { program, store } = mockProgram({ [censusPath]: censusText },
    { progressSources: APP_CONFIG.progressSources, librarySources: APP_CONFIG.librarySources });

  const created = await program.createViewCommentCard({
    itemId: 'PL_SP_BSLC', itemLabel: '基準線の計算', comment: '様式を確認したい', quote: '基準線の計算（済/実装）',
  });
  assert.ok(/^C-U\d{4}$/.test(created.id), 'C-U採番');
  const cardMd = store.get(A + '/Program/Cards/' + created.dirName + '/card.md').content;
  const parsed = P.parseCard(cardMd);
  assert.strictEqual(parsed.fm.type, 'consult', 'type=consult');
  assert.strictEqual(parsed.fm.direction, 'user-to-claude', 'direction=user→AI');
  assert.strictEqual(parsed.fm.status, 'new', 'status=new');
  assert.deepStrictEqual(parsed.fm.target, ['PL_SP_BSLC'], 'target=当該項目ID');
  const body = P.parseSections(parsed.body)['本文'];
  assert.ok(body.includes('様式を確認したい') && body.includes('> 基準線の計算（済/実装）'), '本文=コメント+引用');
  // 正本（census）は一切書き換えない（Cards のみ生成）
  assert.strictEqual(store.get(censusPath).content, censusText, '正本ファイルは無改変');
  await assert.rejects(program.createViewCommentCard({ itemId: 'x', comment: '' }), /空/, '空コメント拒否');
});

// ---------------------------------------------------------------------------
// ㊱ Views ビュー: 群配線・進捗/ライブラリの program 委譲・行コメント配線（ソース文字列検証）（v2.3）
// ---------------------------------------------------------------------------
test('㊱ views view: progress/library wiring + comment→card (source-text checks) (v2.3)', () => {
  const v = readDoc('views/views.js');
  assert.ok(v.includes("registerView({ id: 'views'"), 'views ビューが登録される');
  assert.ok(v.includes('ctx.program.loadProgress()'), '進捗を program に委譲');
  assert.ok(v.includes('ctx.program.listLibrary()') && v.includes('ctx.program.readLibraryItem('), 'ライブラリを program に委譲');
  assert.ok(v.includes('ctx.program.createViewCommentCard('), '行/項目コメント→consultカードを配線');
  assert.ok(v.includes('段階') && v.includes('STAGE_ORDER'), '進捗は段階でグルーピング');
  assert.ok(v.includes('未整備'), '未存在軸は未整備表示');
});

// ---------------------------------------------------------------------------
// Phase 4（Sessions・起動チケット・v2.4）
// ---------------------------------------------------------------------------

const TICKET_FULL_M =
`---
id: S-0009
title: テストセッション
role: 実行（Builder）
target: [SP01, SP02]
model: opus
permission_mode: default
remote_control_name: s0009-builder
cwd: .
confirm_mode: 承認
status: 起票
---

# S-0009 起動ブリーフィング — テストセッション

## 使命

これはテスト用のブリーフィングです。

## 進め方

- 手順1
- 手順2
`;

const TICKET_NONE_M =
`# S-0001 起動ブリーフィング — S1現行レーンのシナリオ起草

> 種別: セッション起動チケット（初号・手動起動用） ／ role: **設計相談（Architect）** ／ 発行: 2026-07-16

## 使命

手動起動用チケット。
`;

// ㊲ チケットparse3形（完備／欠け欄／なし）＋ ticketMeta（Mac版と挙動互換）
test('㊲ parseTicket 3 forms + ticketMeta derivation (Mac版互換) (v2.4)', () => {
  // 完備
  const full = P.parseTicket(TICKET_FULL_M);
  assert.strictEqual(full.hasFrontmatter, true);
  assert.strictEqual(full.fm.permission_mode, 'default');
  const mFull = P.ticketMeta('S-0009_テスト', TICKET_FULL_M);
  assert.strictEqual(mFull.id, 'S-0009');
  assert.strictEqual(mFull.title, 'テストセッション');
  assert.strictEqual(mFull.role, '実行（Builder）');
  assert.deepStrictEqual(mFull.target, ['SP01', 'SP02']);
  assert.strictEqual(mFull.permissionMode, 'default');
  assert.strictEqual(mFull.remoteControlName, 's0009-builder');
  assert.strictEqual(mFull.status, '起票');

  // 欠け欄（frontmatterに model 等なし）→ 壊れず空文字で表示
  const partial = `---\nid: S-0010\ntitle: 欠け欄\nrole: 設計相談\nstatus: 起票\n---\n\n本文。\n`;
  const mPart = P.ticketMeta('S-0010_x', partial);
  assert.strictEqual(mPart.model, '', '欠けた欄は空文字');
  assert.strictEqual(mPart.permissionMode, '', '欠けた欄は空文字');
  assert.strictEqual(mPart.hasFrontmatter, true);

  // frontmatterなし（S-0001型）→ 見出しから id/名称・blockquote から role
  const none = P.parseTicket(TICKET_NONE_M);
  assert.strictEqual(none.hasFrontmatter, false);
  const mNone = P.ticketMeta('S-0001_シナリオ起草S1', TICKET_NONE_M);
  assert.strictEqual(mNone.id, 'S-0001', '見出しから id');
  assert.strictEqual(mNone.title, 'S1現行レーンのシナリオ起草', '— 以降が名称');
  assert.strictEqual(mNone.role, '設計相談（Architect）', '冒頭 blockquote から role');
  assert.strictEqual(mNone.hasFrontmatter, false);
});

// ㊳ program.listSessions / readSession（Dropbox モック・手動チケット含む・本文つき詳細）
test('㊳ program listSessions/readSession: list (incl. manual), detail body, not-found (v2.4)', async () => {
  const A = '/ArchPlan';
  const initial = {
    [A + '/Program/Sessions/S-0001_シナリオ起草S1/briefing.md']: TICKET_NONE_M,
    [A + '/Program/Sessions/S-0009_テスト/briefing.md']: TICKET_FULL_M,
  };
  const { program } = mockProgram(initial);
  const list = await program.listSessions();
  assert.deepStrictEqual(list.map((s) => s.id), ['S-0001', 'S-0009'], 'dir 昇順で2件（手動含む）');
  assert.strictEqual(list.find((s) => s.id === 'S-0001').hasFrontmatter, false, '手動チケットは frontmatter なし');
  assert.strictEqual(list.find((s) => s.id === 'S-0009').permissionMode, 'default');

  const detail = await program.readSession('S-0009');
  assert.strictEqual(detail.id, 'S-0009');
  assert.ok(detail.body.includes('## 使命'), '詳細に本文');
  await assert.rejects(program.readSession('S-9999'), /見つかりません/, '不明IDは reject');

  // Sessions フォルダ未存在なら空一覧（無事故）
  const { program: empty } = mockProgram({ [A + '/Program/Cards/C-0001_a/card.md']: '---\nid: C-0001\n---\n\n' });
  assert.deepStrictEqual(await empty.listSessions(), [], '未存在は空一覧');
});

// ㊴ Sessions ビュー: 群配線・program 委譲・▶は非活性（Macで起動）（ソース文字列検証）
test('㊴ sessions view: wiring + program delegation + launch disabled=Macで起動 (v2.4)', () => {
  const v = readDoc('views/sessions.js');
  assert.ok(v.includes("registerView({ id: 'sessions'"), 'sessions ビューが登録される');
  assert.ok(v.includes('ctx.program.listSessions()'), '一覧を program に委譲');
  assert.ok(v.includes('ctx.program.readSession('), '詳細を program に委譲');
  assert.ok(v.includes('▶ Macで起動') && v.includes('btn.disabled = true'), '▶は非活性表示（Macで起動）');
  assert.ok(v.includes('起動は Mac 版のみ'), 'Macで起動の注記');
  assert.ok(!v.includes('準備中'), '旧「準備中」プレースホルダは廃止');
  assert.ok(v.includes('renderBriefingBody'), 'briefing 本文を md 整形表示');
  // config に sessions ソースが宣言され、群配線されている
  assert.strictEqual(viewGroup('sessions'), 'sessions', 'sessions は sessions 群');
  assert.ok(APP_CONFIG.sessionsSub, 'config に sessionsSub が宣言される');
});
