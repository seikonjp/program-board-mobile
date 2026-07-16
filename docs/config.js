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
  // Cards 群タブ順（v1.8）: Board / Reference / Knowledge / Consult / Decision / Report / Review(=tray) / Memo。
  views: [
    { id: 'board', enabled: true, group: 'cards' },
    { id: 'reference', enabled: true, group: 'cards' },
    { id: 'knowledge', enabled: true, group: 'cards' },
    { id: 'consult', enabled: true, group: 'cards' },
    { id: 'decision', enabled: true, group: 'cards' },
    { id: 'report', enabled: true, group: 'cards' },
    { id: 'tray', enabled: true, group: 'cards' },
    { id: 'memo', enabled: true, group: 'cards' },
    { id: 'sheets', enabled: true, group: 'sheets' },
    // Views / Sessions は Phase 3/4 で実装予定＝準備中の空状態のみ（タブは出す）。
    { id: 'views', enabled: true, group: 'views' },
    { id: 'sessions', enabled: true, group: 'sessions' },
  ],

  // 最上位ナビ（4群・v2.2）。表示順＝この順。
  groups: [
    { id: 'cards', label: 'Cards' },
    { id: 'sheets', label: 'Sheets' },
    { id: 'views', label: 'Views' },
    { id: 'sessions', label: 'Sessions' },
  ],

  // Sheets ソース定義（パスはここに集約＝config化・読み取り専用＋💬コメント＋承認）。
  // ベース = programRoot の親（'/ArchPlan/Program' → '/ArchPlan'）＋ sub。
  // match/exclude はファイル basename に適用する正規表現（文字列・exclude 空＝除外なし）。
  sheetSources: [
    { id: 'scenario', label: 'シナリオ', sub: 'Docs/ConOps/Scenarios', recurse: false, numbered: false, match: '^SC-.*\\.md$', exclude: '^_TEMPLATE\\.md$' },
    { id: 'completion', label: '完成定義', sub: 'archplan-core/Docs/TestDefinitions', recurse: true, numbered: false, match: '\\.md$', exclude: '^(METHOD|_)' },
    { id: 'rds', label: 'RDS', sub: 'Projects/RequirementManagement/Works/RDS', recurse: false, numbered: true, match: '^RDS_.*\\.md$', exclude: '' },
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
