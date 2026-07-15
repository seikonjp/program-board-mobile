'use strict';

// registry.js — ビュー登録制の中核（登録レジストリ）
//
// 各 views/<id>.js は読み込み時に registerView(def) を呼んで自己登録する。
// app.js は config.views の有効リストに従い該当モジュールを import（＝登録を発火）し、
// listViews() から順序どおりのビュー定義を得る。新ビュー追加が既存コードに触れない。
//
// ビュー定義 def の形:
//   {
//     id:       'board',                // 一意 ID（ファイル名と一致）
//     tabLabel: 'ボード',               // タブ表示名
//     badge:    (ctx) => number|null,   // 任意: タブに出す件数バッジ
//     create:   (ctx) => HTMLElement,   // 初回マウント。永続する DOM を返す（1回だけ）
//     onData:   (ctx) => void,          // 任意: データ更新時に一覧等を再描画（入力欄は壊さない）
//     onShow:   (ctx) => void,          // 任意: タブが表示された時
//   }

const views = new Map();

export function registerView(def) {
  if (!def || !def.id) throw new Error('registerView: id が必要です');
  views.set(def.id, def);
}

export function getView(id) {
  return views.get(id) || null;
}

export function listViews(ids) {
  if (!ids) return [...views.values()];
  return ids.map((id) => views.get(id)).filter(Boolean);
}

export function hasView(id) {
  return views.has(id);
}
