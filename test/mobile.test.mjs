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
import { enabledViewIds } from '../docs/config.js';

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
// ② ID 採番（既存最大 +1・4桁0詰め・混在桁・9999 超）
// ---------------------------------------------------------------------------
test('② nextCardId increments max and zero-pads to 4 digits (混在桁・上限なし)', () => {
  assert.strictEqual(P.nextCardId([]), 'C-0000');
  assert.strictEqual(P.nextCardId(['C-000_TEMPLATE']), 'C-0001');
  assert.strictEqual(
    P.nextCardId(['C-000_TEMPLATE', 'C-003_something', 'C-001_a', 'CARD_INDEX.md', 'not-a-card']),
    'C-0004',
  );
  assert.strictEqual(P.nextCardId(['C-042_x', 'C-100_y']), 'C-0101');
  // 旧3桁 C-00x と新4桁 C-000x の混在でも数値最大 +1
  assert.strictEqual(P.nextCardId(['C-000_a', 'C-0003_b', 'C-002_c']), 'C-0004');
  // 9999 超は上限を作らず自然に5桁へ拡張
  assert.strictEqual(P.nextCardId(['C-9999_x']), 'C-10000');
  assert.strictEqual(P.nextCardId(['C-10000_x', 'C-0003_y']), 'C-10001');
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
  assert.ok(out.includes('| C-001 | 世界のライティング | user→AI | reference | ライティング | graphics・world | S4着手時 | 注釈済み | 2026-07-15 |'), 'C-001 行（主題=ライティング・状態は日本語）');
  assert.ok(out.includes('| C-002 | 自動調整 | user→AI | knowledge | 自動調整 | — | — | 注釈済み | 2026-07-15 |'), 'C-002 行（種別=knowledge・主題=自動調整）');
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
test('⑫ タブ順は Board/Reference/Knowledge/Consult/Decision/Report/Acceptance(=tray)/Quick', () => {
  // enabledViewIds は config.views の有効順で ID を返す（tray の表示名 Acceptance）。
  assert.deepStrictEqual(
    enabledViewIds(),
    ['board', 'reference', 'knowledge', 'consult', 'decision', 'report', 'tray', 'quick'],
    'タブ順（Report 新設・Decision→Report→Acceptance→Quick）',
  );
});

test('⑫b cardsForType(type=report) は report カードのみ抽出（Report タブ）', () => {
  const cards = [
    { id: 'C-001', type: 'reference' },
    { id: 'C-006', type: 'report' },
    { id: 'C-007', type: 'acceptance' },
    { id: 'C-008', type: 'report' },
  ];
  assert.deepStrictEqual(P.cardsForType(cards, 'report').map((c) => c.id), ['C-006', 'C-008'], 'report のみ（acceptance は含めない）');
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
    { id: 'C-0005', type: 'acceptance' },
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
  // (a) STATUS_LABEL は日本語ラベル
  assert.strictEqual(P.STATUS_LABEL.new, '新規');
  assert.strictEqual(P.STATUS_LABEL.annotated, '注釈済み');
  assert.strictEqual(P.STATUS_LABEL.waiting, '浮上待ち');
  assert.strictEqual(P.STATUS_LABEL.acceptance, '検収待ち');
  assert.strictEqual(P.STATUS_LABEL.consumed, '消化');

  // (b) CARD_INDEX の状態列も日本語・英語ラベルは出ない
  const idx = P.buildIndexTable([
    { id: 'C-001', title: 't', direction: 'user-to-claude', type: 'report', subject: '', tags: [], surface: '', status: 'acceptance', created: '2026-07-15' },
    { id: 'C-002', title: 't', direction: 'user-to-claude', type: 'reference', subject: '', tags: [], surface: '', status: 'consumed', created: '2026-07-15' },
  ]);
  assert.ok(idx.includes('| 検収待ち |') && idx.includes('| 消化 |'), 'CARD_INDEX の状態列は日本語');
  assert.ok(!/\| (new|acceptance|consumed) \|/.test(idx), '英語の状態ラベルは出力されない');

  // (c) ファイル内部の status 値は英語のまま（往復無損失＝書き換えない）
  const parsed = P.parseCard(DECISION_FIXTURE);
  assert.strictEqual(parsed.fm.status, 'new', 'frontmatter の status 値は英語のまま');
  assert.strictEqual(P.serializeCard(parsed), DECISION_FIXTURE, '往復無損失（値は書き換えない）');

  // (d) boardColumns=種類別6列（この順）・request→consult 合流・template は入らない
  const cards = [
    { id: 'C-a', type: 'reference' }, { id: 'C-b', type: 'knowledge' }, { id: 'C-c', type: 'consult' },
    { id: 'C-d', type: 'request' }, { id: 'C-e', type: 'decision' }, { id: 'C-f', type: 'report' },
    { id: 'C-g', type: 'acceptance' }, { id: 'C-h', type: 'template' },
  ];
  const cols = P.boardColumns(cards);
  assert.deepStrictEqual(cols.map((c) => c.type), ['reference', 'knowledge', 'consult', 'decision', 'report', 'acceptance'], '6列この順');
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

  // shared.js の cardTile が日本語の状態 chip を付与
  const shared = readDoc('views/shared.js');
  assert.ok(shared.includes('chip chip-status') && shared.includes('P.STATUS_LABEL[card.status]'), 'cardTile が状態 chip（日本語ラベル）を付与');
});
