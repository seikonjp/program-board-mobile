# SPEC_MOBILE — Program Board Mobile v1（iPhone/iPad特化・Dropbox直結PWA）

> 目的: `ArchPlan/Program/` のカード・INBOX・検収を、**Macを経由せず**iPhone/iPadから直接読み書きするPWA。データの正はDropbox上のファイル（Mac版ボード`Tool/program-board/`と同じファイルを見る別の窓＝二重の正なし・同期作業なし）。
> 発注: 2026-07-15ユーザー承認（案A）。実装=coder（Opus）。置き場=本フォルダ`ArchPlan/Tool/program-board-mobile/`（独立git）。ホスティング=GitHub Pages想定（静的サイト・UIコードのみ公開・データ/トークンは含まない）。
> **iPhone/iPadは同一アプリ**: レスポンシブ1コードベース（狭幅=縦1カラム／広幅=2ペイン）。

## 0. 技術原則

- **静的サイト・外部依存ゼロ**（vanilla JS/HTML/CSS・ビルド工程なし・npmパッケージなし・CDN読込なし）。構成: `docs/`（GitHub Pagesの公開ルート）=index.html・app.js・views/*.js・dropbox.js・parser.js・style.css・manifest.json・sw.js・icons・config.js
- **Dropbox API v2直結**（クライアントサイドのみ）: OAuth2 **PKCE**フロー（client secretなし）・refresh token対応・トークンはlocalStorageのみ（外部送信なし）。`config.js`にclient_id（プレースホルダ）とProgramルートパス（既定 `/ArchPlan/Program`）
- 通信先はDropbox APIのみ（analytics等一切なし）。**削除APIは呼ばない**（状態変更のみ・Mac版と同じ規律）
- PWA: manifest（ホーム画面追加・standalone表示）＋Service Workerは**アプリ殻のみ**キャッシュ（データはキャッシュしない。ただし最終取得データをlocalStorageに保持しオフライン時は閲覧のみ可・書込はオンライン必須）
- UI日本語・タッチ最適化（ボタン44px以上・スワイプ不要のシンプル操作）

## 1. データ規約（Mac版SPEC.mdと同一・往復無損失）

- カード=`Cards/C-〈方向1字〉〈4桁連番〉_slug/card.md`（U=ユーザー発／A=AI発・方向別連番。YAML frontmatter＋「## 本文」「## 注釈（私が記入）」「## 処理記録」）＋同フォルダ画像。書式見本=`Cards/C-U0000_TEMPLATE/card.md`（必読）
- 新規カード: list_folderで既存最大ID+1（3桁0詰め）・slugはtitleから安全化・status=new・画像はカメラロールから選択しJPEG/PNGのままアップロード（長辺2048px超は縮小してよい）
- INBOX追記: download→§1末尾に`- YYYY-MM-DD 本文（📱）`を追記→**rev指定のupdate mode**でupload（409競合時は再download→再適用・最大3回）。§2/§3は不変
- 応答（AI発カード・v2.1）: card.mdの「## 処理記録」へ`- 応答（あなた・📱 YYYY-MM-DD HH:MM）: OK`（NG=`: NG — 一言`〔一言必須〕／`: 選択=X — コメント`／`: あとで`／`: コメント — 本文`）の固定書式（統括AIのparse対象）で追記＋status機械更新（review+OK→consumed／NG・あとで→reviewのまま／decision+選択→responded）。完了提案（done-proposed）は完了ボタン→consumed＋`- 完了確定（あなた・📱 …）`。status語彙に`responded`（応答済み）・`done-proposed`（完了提案）を追加。frontmatterに任意`target`欄（対象付け・欄なしでも後方互換）。`Cards/_archive/`は検索のみヒット（一覧除外）。rev指定update
- `CARD_INDEX.md`: カード書込後に表部分のみ再生成（ヘッダ`>`引用・見出し保持・Mac版と同一ロジック）
- 読み取り専用: `DECISION_QUEUE.md`・`CONTROL.md`

## 2. 画面（最上位ナビ4群＋設定・iPadは広幅で一覧+詳細の2ペイン）

> **build21（Phase 3・Views）**: **Views** 群を実装（Progress＋Library）。**Progress**＝機能×段階×実装状態の一望（FEATURE_FPU_CENSUS/TASK_LEDGER/LANES_BOARD/テスト状況JSON をアダプタで合成・開いた時のみ取得＝通信量配慮）。**Library**＝View9の残り8軸を読み取り整形（一覧は `get_metadata` で存在確認＝大きいファイルは落とさない・本文は開いた時DL・未整備軸は無事故）。行/項目の💬コメント→**consultカード自動生成**（C-U採番・target=項目ID・正本無書き込み）。ソースは `config.js`（progressSources/librarySources・`/ArchPlan` から導出）。
>
> **build20（Phase 2）**: 最上位ナビを4群へ再編＝**Cards**（従来の Board/type別/Review/Memo を第2階層に内包）／**Sheets**（新設）／**Views**（build21実装）／**Sessions**（Phase 4・準備中）。各view定義に `group` 属性・`buildTabbar` を2階層化（群バー＋第2階層タブ）。**Sheets**＝シナリオ/完成定義/RDS を項目単位で表示（一覧はファイル名のみ・本文は開いた時DL）＋項目直下に💬コメント（`updateTextFileWithRetry`・本文編集なし）＋frontmatter `state`/`review_card` のシートに状態チップ＋承認ボタン（reviewed のみ活性→reviewカードOK＋consumed／シートstate→approved）。ソースパスは `config.js`（programRoot の親＝`/ArchPlan` から導出）。

1. **ボード**: 状態5列（狭幅ではセグメント切替・広幅ではカンバン）。カード=サムネ+タイトル+タグ。**新規作成: 「写真を選ぶ」ボタン（カメラロール/カメラ・複数可）＋テキスト欄＋作成**——モバイルの主動線なので最短タップ数で
2. **検収トレイ**: type=report/reviewかつstatus=reviewを大きなスクショ付きで縦並び・**OK／NG（コメント欄）／あとで**の3ボタン（type/status値=review・カード詳細の操作モードはrespond〔二重意味回避〕。日本語表示「検収待ち」「検収」等は不変）
3. **クイック登録**: 1行テキスト→INBOXへ（起動直後にこのタブを開く設定可＝思いつき最速登録）
4. **裁定ビュー**: DECISION_QUEUE.md整形表示（読み取り専用）
- 設定画面: Dropbox接続（PKCE認可・切断）・Programルートパス・起動タブ選択
- ヘッダ: 検収待ち件数バッジ・オフライン表示・手動更新（自動は画面表示時+60秒間隔の軽いポーリング＝モバイル通信量配慮）

## 3. 将来拡張への構造要求（v1では作らない・ただし壊さない設計にする）

**このアプリは将来「開発特化の管理面」（進捗表示・段階管理・検収統計・CONTROLダッシュボード等）へ育てる方針（2026-07-15ユーザー）。** そのため:

- **ビューはモジュール式**: views/*.jsに1画面1モジュール（登録制）。新ビュー追加が既存に触れない構造
- **ファイルゲートウェイ層の分離**: Dropbox API呼出はdropbox.jsに集約・md解析（frontmatter/セクション/チェックリスト`- [ ]`）はparser.jsに集約——将来STAGE_PLAN.mdやCONTROL.mdを解析する進捗ビューが同じ部品で書けること
- config.jsに`views`有効化リスト（将来ビューのon/off）

## 4. 品質・受け入れ条件

- `node --test`（開発機で実行）: parser往復無損失（C-U0000相当fixture）・ID採番・INBOX追記の影響範囲・CARD_INDEX再生成 の4件緑（Dropbox API層はfetchモックで単体テスト）
- 実機確認前提の**セットアップ手順書 `README_SETUP.md`** を必ず作成: ①Dropbox Appの登録手順（App console・scopes=files.metadata.read/files.content.read/files.content.write・redirect URIの設定・client_id取得）②GitHub Pages公開手順（公開されるのはUIコードのみである旨明記）③iPhone/iPadホーム画面追加手順④初回接続の流れ。**ユーザーが1人で15分で終わる粒度**で
- git init・一括コミット（v1・テスト結果記載）
- **禁止**: 外部依存・CDN・analytics・Dropbox削除API・Program/規約外の書式変更

## 5. Mac版との関係

Mac版（Tool/program-board/）は併存（デスク用）。本アプリの完成でLAN公開改修（旧v1.1案）は不要となり実施しない。
