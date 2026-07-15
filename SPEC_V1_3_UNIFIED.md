# SPEC v1.3 — 語彙の英語化・タブ再編・書式統一・ID拡張

> 2026-07-15ユーザー承認。対象=**両アプリ**（program-board-mobile／program-board）。後方互換必須（既存C-000〜C-002がそのまま動く）。

## 1. 語彙（英語化）

- **type（ユーザー発・3分類）**: `reference`（見せる=参考・画像）／`knowledge`（残す=知見・証言）／**`consult`（問う=相談・提案・悩み・要望）**——`request`は廃止語（読み込み時はconsultとして扱う・書き換えはしない）
- **type（AI発・不変）**: `report`／`acceptance`（作成フォームには出さない）
- **UI表示は分類語彙をすべて英語に**: type・status（new/annotated/waiting/acceptance/consumed）・direction（user→AI / AI→user）・タブ名。説明文・ヒント・ボタン補足は日本語のままでよい
- CARD_INDEXの表も同じ英語語彙で出力（列名見出しは日本語のままでよい: 種別列にreference等）

## 2. タブ再編（両アプリ共通）

**Board ／ Reference ／ Knowledge ／ Consult ／ Quick ／ Decision**（＋既存のTray=検収はそのまま維持）

1. **Board（全体）**: 状態カンバン。**全type表示**（knowledge除外を撤廃・reference/knowledge/consult/report/acceptance全部）。カードにtypeのchip表示
2. **Reference／Knowledge／Consultの各タブ**: **3つとも完全に同一のレイアウト**——主題（subject）別グルーピング＋全文検索ボックス（title/subject/本文/注釈/tags/処理記録横断・空白AND）。現行の知見タブの実装を一般化してtypeパラメータ化すること（コード複製でなく1モジュールの再利用）
3. Quick（INBOX一行登録）・Decision（裁定ビュー）: 不変
4. 新規作成フォーム: 種別セグメント=Reference/Knowledge/Consult（既定=Reference）・主題入力＋サジェスト（従来どおり）

## 3. カード表示書式の統一

- 詳細表示は全typeで**完全に同一の書式**: タイトル／type・subject・tags・status・浮上条件のchip列／**画像（あれば表示・なければ画像領域ごと非表示**・複数あれば縦並び）／本文／注釈／処理記録
- 一覧（タブ内・Board）も同一書式のカード: サムネイル（画像があれば先頭1枚・なければ出さない）＋タイトル＋主題chip

## 4. ID拡張

- **新規採番を4桁0詰めへ**（次はC-0003）。既存C-000〜C-002はリネームしない
- パースは `C-\d+` を全許容・次ID=既存全カードの数値最大+1・**9999超は自然に5桁**（上限を作らない）。両アプリの採番・ソート・indexが混在桁で正しく動くこと（テスト必須: C-000系とC-0003系の混在）

## 5. 受け入れ条件

- 両リポ `node --test` 全緑（追加: consult扱い・request後方互換・混在桁ID採番・type別タブ抽出）
- 既存実カード3枚（読み取りのみ）で表示が壊れないこと
- モバイル=build 11・SW版数+1。**git commitのみ・pushしない**
