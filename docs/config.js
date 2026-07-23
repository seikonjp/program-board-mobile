'use strict';

// config.js — アプリ設定（公開してよい値のみ。トークン・データは絶対に含めない）
//
// この app は静的ホスティング（GitHub Pages 想定）に置かれ、ここに書いた値は
// 誰でも閲覧できる。Dropbox の App key（PKCE の公開クライアント識別子）は公開して
// 問題ない値。ユーザーごとのトークン・カード内容は localStorage のみに保持し、
// このファイルにもリポジトリにも一切含まれない。

export const config = {
  // Dropbox App Console で作成した App の「App key」をここに設定する。
  // PKCE（公開クライアント）フローのため client secret は不要・使わない。
  dropboxClientId: 'cc2fedm0eq4eia9',

  // Program ルート（Dropbox 上の絶対パス・末尾スラッシュなし）。
  // Mac 版と同じ実ファイルを見る（二重の正なし）。設定画面で上書き可。
  programRoot: '/ArchPlan/Program',

  // 起動時に開くタブ（board / reference / knowledge / consult / decision / report / tray / memo）。設定画面で上書き可。
  defaultTab: 'board',

  // 画面表示中の自動ポーリング間隔（ms）。モバイル通信量に配慮した軽いポーリング。
  pollIntervalMs: 60000,

  // アップロード画像の長辺上限（px）。これを超える画像のみ縮小する。0 で縮小しない。
  imageMaxEdge: 2048,

  // ビュー有効化リスト（登録制＋群・v2.2）。
  // 将来ビューを増やすときは docs/views/<id>.js を追加し、ここに 1 行足すだけで有効化できる
  //（app.js など既存コードを編集しない設計）。group で最上位ナビ（Cards/Sheets/Views/Sessions）へ束ねる。
  // Cards 群タブ順（v1.8＋完了ビュー2026-07-17）: Board / Reference / Knowledge / Consult / Decision / Report / Review(=tray) / Memo / 完了。
  views: [
    { id: 'board', enabled: true, group: 'cards' },
    { id: 'reference', enabled: true, group: 'cards' },
    { id: 'knowledge', enabled: true, group: 'cards' },
    { id: 'consult', enabled: true, group: 'cards' },
    { id: 'decision', enabled: true, group: 'cards' },
    { id: 'report', enabled: true, group: 'cards' },
    { id: 'tray', enabled: true, group: 'cards' },
    { id: 'memo', enabled: true, group: 'cards' },
    { id: 'completed', enabled: true, group: 'cards' }, // 完了ビュー（consumed＋アーカイブ・2026-07-17）

    { id: 'sheets', enabled: true, group: 'sheets' },
    // 進捗タブ（便5・build 34・独立タブ）: 進捗リスト＋作業順序リスト。
    { id: 'progressboard', enabled: true, group: 'progress' },
    // Views / Sessions は Phase 3/4 で実装予定＝準備中の空状態のみ（タブは出す）。
    { id: 'views', enabled: true, group: 'views' },
    { id: 'sessions', enabled: true, group: 'sessions' },
  ],

  // 最上位ナビ（5群・便5で進捗を独立タブ追加）。表示順＝この順。
  groups: [
    { id: 'cards', label: 'Cards' },
    { id: 'sheets', label: 'Sheets' },
    { id: 'progress', label: '進捗' },
    { id: 'views', label: 'Views' },
    { id: 'sessions', label: 'Sessions' },
  ],

  // Sheets ソース定義（パスはここに集約＝config化・読み取り専用＋💬コメント＋承認）。
  // ベース = programRoot の親（'/ArchPlan/Program' → '/ArchPlan'）＋ sub。
  // match/exclude はファイル basename に適用する正規表現（文字列・exclude 空＝除外なし）。
  sheetSources: [
    { id: 'scenario', label: 'シナリオ', sub: 'Docs/ConOps/Scenarios', recurse: true, numbered: false, match: '^SC-.*\\.md$', exclude: '^_' },
    { id: 'completion', label: '完成定義', sub: 'archplan-core/Docs/TestDefinitions', recurse: true, numbered: false, match: '\\.md$', exclude: '^(METHOD|_)' },
    { id: 'rds', label: 'RDS', sub: 'Projects/RequirementManagement/Works/RDS', recurse: false, numbered: true, match: '^RDS_.*\\.md$', exclude: '' },
  ],

  // 便1（v2.10 / build 30）: D-2動作定義・D-4テスト報告の追加ソース（初期は原典未整備＝空一覧で壊れない・§1-2a）。
  // sheetSources（既存3）は不変更。board 用の拡張ソース。
  sheetBoardSources: [
    { id: 'behaviors', label: '動作定義', sub: 'Docs/ConOps/Behaviors', recurse: true, numbered: false, match: '\\.md$', exclude: '^_' },
    // 便3（§3）: D-4 config `testReports`（既定=archplan-core/Docs/TestReports・実在0本＝空許容・◆置き場未確定＝フォルダは作らない）。
    { id: 'testreport', label: 'テスト報告', sub: 'archplan-core/Docs/TestReports', recurse: true, numbered: false, match: '\\.md$', exclude: '^_' },
  ],

  // 3画面タグ（§1-2a）。設計基盤は便4でB-1〜B-6枠を作成＝便1はタグのみ・準備中表示。
  sheetTags: [
    { id: 'flow', label: '開発フロー', pending: false, subcategories: [
      { id: 'scenario', label: 'D-1シナリオ', flow: 'D-1', kind: 'approval', source: 'scenario' },
      { id: 'behaviors', label: 'D-2動作定義', flow: 'D-2', kind: 'confirm', source: 'behaviors' },
      { id: 'completion', label: 'D-3完成定義', flow: 'D-3', kind: 'approval', source: 'completion' },
      { id: 'testreport', label: 'D-4テスト報告', flow: 'D-4', kind: 'confirm', source: 'testreport' },
    ] },
    // 設計基盤（§4・便4）: B-1〜B-6の枠（画面枠）のみ。各サブカテゴリ pending=準備中（個別加工表示は後日ひとつずつ確定）。
    { id: 'foundation', label: '設計基盤', pending: false, subcategories: [
      { id: 'B-1', label: 'B-1 コム・種体系', pending: true },
      { id: 'B-2', label: 'B-2 設定項目', pending: true },
      { id: 'B-3', label: 'B-3 設計条件', pending: true },
      { id: 'B-4', label: 'B-4 品質基準', pending: true },
      { id: 'B-5', label: 'B-5 操作', pending: true },
      { id: 'B-6', label: 'B-6 画面', pending: true },
    ] },
    { id: 'rds', label: 'RDS', pending: false, subcategories: [
      { id: 'rds', label: 'R-1 RDS文書', flow: null, kind: 'confirm', source: 'rds' },
    ] },
  ],

  // Library原典（Sheetの原典層・§4・便4）。初期スコープ=Sheet原典のみ（対応表11行）。
  // 表示はSheetと同方式（3画面タグ・共通列）だが状態=「変更から一定期間の新着アイコンのみ」（承認ライフサイクルなし）。
  // 実パスが特定できないものは kind:'unknown'＝「未整備（原典未特定）」を正直表示。棚卸し便◆7で後日確定・差し替え前提。
  // match/exclude は sheetArchplanRoot 相対の basename に適用する正規表現（文字列）。
  libraryNewBadgeDays: 7,
  libraryOriginTags: [
    { id: 'flow', label: '開発フロー', subcategories: [
      { id: 'D-1', label: 'D-1 シナリオ', origins: [ { label: 'Scenarios（SC-J/F/C・SC_MAP）', kind: 'dir', sub: 'Docs/ConOps/Scenarios', match: '\\.md$', exclude: '^_' } ] },
      { id: 'D-2', label: 'D-2 動作定義', origins: [ { label: 'BD文書', kind: 'dir', sub: 'Docs/ConOps/Behaviors', match: '\\.md$', exclude: '^_' } ] },
      { id: 'D-3', label: 'D-3 完成定義', origins: [ { label: 'TestDefinitions・QS→テスト対応表', kind: 'dir', sub: 'archplan-core/Docs/TestDefinitions', match: '\\.md$', exclude: '^_' } ] },
      { id: 'D-4', label: 'D-4 テスト報告', origins: [ { label: '報告文書＋提出物の実体', kind: 'dir', sub: 'archplan-core/Docs/TestReports', match: '\\.md$', exclude: '^_' } ] },
    ] },
    { id: 'foundation', label: '設計基盤', subcategories: [
      { id: 'B-1', label: 'B-1 コム・種体系', origins: [
        { label: 'SPECIES_LIST', kind: 'file', sub: 'Projects/DataStructure/Works/W3_定義作成/SPECIES_LIST.md' },
        { label: '種スキーマ G01〜G14', kind: 'dir', sub: 'Projects/DataStructure/Works/W3_定義作成', match: '^G\\d+_SCHEMA\\.md$' } ] },
      { id: 'B-2', label: 'B-2 設定項目', origins: [ { label: 'settingData定義・実行時代入census', kind: 'unknown' } ] },
      { id: 'B-3', label: 'B-3 設計条件', origins: [
        { label: 'CONDITIONS_LIST', kind: 'file', sub: 'Projects/DataStructure/Works/W3_定義作成/CONDITIONS_LIST.md' },
        { label: 'ELEMENT_CATALOG', kind: 'file', sub: 'archplan-core/Docs/Conditions/ELEMENT_CATALOG.md' } ] },
      { id: 'B-4', label: 'B-4 品質基準', origins: [
        { label: 'VALIDATION_RULES.json（正）', kind: 'file', sub: 'archplan-core/Docs/Quality/VALIDATION_RULES.json' },
        { label: 'VALIDATION_RULES.md（閲覧版）', kind: 'file', sub: 'archplan-core/Docs/Quality/VALIDATION_RULES.md' } ] },
      { id: 'B-5', label: 'B-5 操作', origins: [ { label: 'OPERATION_ROUTING_TABLE（操作カタログ成果）', kind: 'file', sub: 'Projects/OperationManagement/OPERATION_ROUTING_TABLE.md' } ] },
      { id: 'B-6', label: 'B-6 画面', origins: [
        { label: 'SCREEN_FRAMEWORK', kind: 'file', sub: 'Docs/UI/SCREEN_FRAMEWORK.md' },
        { label: 'SCREEN_LIST（画面一覧）', kind: 'file', sub: 'Projects/ScreenManagement/SCREEN_LIST.md' } ] },
    ] },
    { id: 'rds', label: 'RDS', subcategories: [
      { id: 'R-1', label: 'R-1 RDS', origins: [
        { label: 'RDS文書・RDS_INDEX', kind: 'dir', sub: 'Projects/RequirementManagement/Works/RDS', match: '^RDS_.*\\.md$' },
        { label: 'REQUIREMENT_MAP', kind: 'file', sub: 'Docs/Requirements/REQUIREMENT_MAP.md' } ] },
    ] },
  ],

  // summaries.json（AI補助キャッシュ・§1-1b）。アプリは生成しない（器のみ）。sheetArchplanRoot 相対。未存在→{}。
  summariesSub: 'Program/data/summaries.json',

  // Views 進捗ソース（config化・sheetArchplanRoot 相対・アダプタ型で正規化・v2.3）。
  // 差し替え（初版census→合流後FEATURE_LIST）は sub+type の変更のみ。
  progressSources: {
    census: { sub: 'Projects/DevelopmentPlan/FEATURE_FPU_CENSUS.md', type: 'census' },
    comTargets: { sub: 'Projects/DevelopmentPlan/Works/W4_全体構成と機能の計画/COM_FUNCTION_TARGETS.md', type: 'comTargets' },
    progressAxis: { sub: 'Program/PROGRESS_AXIS.md', type: 'progressAxis' },
    taskLedger: { sub: 'Projects/DevelopmentPlan/TASK_LEDGER.md', type: 'taskLedger' },
    lanes: { sub: 'Projects/TestSystem/LANES_BOARD_2026-07.md', type: 'lanes' },
    testStatus: { sub: 'archplan-core/Docs/TestDefinitions/test_status.json', type: 'testStatus' },
    carryover: { sub: 'Program/CARRYOVER.md', type: 'carryover' },
  },

  // 進捗タブ（便5・build 34）。IMPL_REGISTRY → 参照 SC-F のみ読む（需要駆動）。sheetArchplanRoot 相対。
  // completionMap は機能コード→D-3完成定義ファイル（completionBase 相対）。実データは全て未チェック=完成定義承認は — 表示（正直）。
  progressBoard: {
    registrySub: 'archplan-core/Docs/Implementation/IMPL_REGISTRY.json',
    scenarioDir: 'Docs/ConOps/Scenarios/Features',
    scenarioPrefix: 'SC-F_',
    completionBase: 'archplan-core/Docs/TestDefinitions',
    completionMap: {
      PL_SP_SP: ['features/敷地配置.md', 'features/敷地方向判定.md'],
      PL_AP_ENTP: ['features/玄関配置.md', 'PL_AP_ENTP.md'],
      PL_SP_PKP: ['features/駐車場配置.md'],
    },
  },

  // Sessions（起動チケット・v2.4・Phase4）。programRoot 直下 'Sessions'（S-*/briefing.md）。
  // モバイルは表示のみ（▶起動は非活性=「Macで起動」）。
  sessionsSub: 'Sessions',

  // Views ライブラリ8軸（DOC_GOVERNANCE_LIST View9の進捗以外・v2.3）。
  // sub:null（品質基準枠）・未存在正本は「未整備」表示で無事故。開いた時のみ取得。
  librarySources: [
    { id: 'feature', label: '機能', sub: 'archplan-core/Docs/Features/FEATURE_LIST.json', type: 'json' },
    { id: 'com', label: 'コム', sub: 'archplan-core/Docs/Species/COM_CATALOG.json', type: 'json' },
    { id: 'condition', label: '設計条件', sub: 'archplan-core/Docs/Conditions/ELEMENT_CATALOG.md', type: 'md' },
    { id: 'operation', label: '操作', sub: 'Projects/OperationManagement/OPERATION_ROUTING_TABLE.md', type: 'md' },
    { id: 'screen', label: '画面', sub: 'Projects/ScreenManagement/SCREEN_LIST.md', type: 'md' },
    { id: 'project', label: 'プロジェクト', sub: 'Program/PROJECT_REGISTRY.md', type: 'md' },
    { id: 'quality', label: '品質基準', sub: null, type: 'md' },
    { id: 'requirement', label: '要件', sub: 'Docs/Requirements/REQUIREMENT_MAP_DATA.json', type: 'json' },
  ],
};

// programRoot（'/ArchPlan/Program'）の親（'/ArchPlan'）＝Sheets ソースのベースルート。
export function sheetArchplanRoot(programRoot) {
  const r = String(programRoot || '').replace(/\/+$/, '');
  const i = r.lastIndexOf('/');
  return i <= 0 ? r : r.slice(0, i);
}

// localStorage に保存されたユーザー上書き（programRoot / defaultTab）をマージして返す。
const OVERRIDE_KEY = 'pbm_config_override';

export function getConfig() {
  let override = {};
  try {
    override = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {};
  } catch {
    override = {};
  }
  return {
    ...config,
    programRoot: override.programRoot || config.programRoot,
    defaultTab: override.defaultTab || config.defaultTab,
  };
}

export function saveConfigOverride(patch) {
  let override = {};
  try {
    override = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {};
  } catch {
    override = {};
  }
  const next = { ...override, ...patch };
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
  return next;
}

// 有効なビュー ID を config の順で返す。
export function enabledViewIds() {
  return config.views.filter((v) => v.enabled).map((v) => v.id);
}

// ビューの所属群（既定 cards）。
export function viewGroup(id) {
  const v = config.views.find((x) => x.id === id);
  return v ? (v.group || 'cards') : 'cards';
}

// 有効ビューを持つ群を config.groups の順で返す（[{id,label}]）。
export function enabledGroups() {
  const present = new Set(config.views.filter((v) => v.enabled).map((v) => v.group || 'cards'));
  return (config.groups || [{ id: 'cards', label: 'Cards' }]).filter((g) => present.has(g.id));
}

// ある群に属する有効ビュー ID を config の順で返す（第2階層タブ）。
export function enabledViewIdsForGroup(groupId) {
  return config.views.filter((v) => v.enabled && (v.group || 'cards') === groupId).map((v) => v.id);
}
