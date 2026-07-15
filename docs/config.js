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

  // 起動時に開くタブ（board / tray / quick / decision）。設定画面で上書き可。
  defaultTab: 'board',

  // 画面表示中の自動ポーリング間隔（ms）。モバイル通信量に配慮した軽いポーリング。
  pollIntervalMs: 60000,

  // アップロード画像の長辺上限（px）。これを超える画像のみ縮小する。0 で縮小しない。
  imageMaxEdge: 2048,

  // ビュー有効化リスト（登録制）。
  // 将来ビューを増やすときは docs/views/<id>.js を追加し、ここに 1 行足すだけで有効化できる
  //（app.js など既存コードを編集しない設計）。
  views: [
    { id: 'board', enabled: true },
    { id: 'tray', enabled: true },
    { id: 'quick', enabled: true },
    { id: 'decision', enabled: true },
    // 将来の開発特化ビュー（v1 では作らない・enabled:false のまま置ける）:
    // { id: 'progress', enabled: false },   // STAGE_PLAN.md の `- [ ]` 進捗を parser.js で解析
    // { id: 'control',  enabled: false },   // CONTROL ダッシュボード
  ],
};

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
