# SPEC v1.1 — 知見（knowledge）とストック/フロー分離

> 2026-07-15ユーザー承認。対象=**両アプリ**（`Tool/program-board-mobile/`=主・`Tool/program-board/`=互換対応）。データの正は従来どおりファイル。**後方互換必須**（subject無し・旧typeの既存カードがそのまま動くこと）。

## 1. カード書式の拡張（正=C-000_TEMPLATE・変更は発注元が実施済み）

- frontmatterに**任意フィールド `subject:`**（主題・一語・自由記述文字列）を追加。無くてもよい
- typeの語彙に **`knowledge`（知見・設計知識・作者証言）** を追加
- 主題の一覧=`Program/Cards/SUBJECTS.md`（`- 主題名 — 説明`の箇条書き・発注元が維持。アプリは**読み取りのみ**・存在しなくても動くこと）

## 2. モバイル版（program-board-mobile・build 10）

1. **新規作成フォーム**: 種別セグメント（参考/知見/要望・既定=参考）＋**主題入力欄**（`<input list>`のdatalistサジェスト=読み込み済み全カードのsubject値∪SUBJECTS.mdの主題名。自由入力可）
2. **「知見」タブを新設**（views/knowledge.js・登録制に追加・タブ名「知見」）:
   - type=knowledgeのカードを**主題別にグルーピング表示**（主題見出し＋件数、カードはタイトル+先頭行）
   - **全文検索ボックス**（title/subject/本文/注釈/tags/処理記録を横断・部分一致・ひらがなカタカナはそのまま単純一致でよい・結果はハイライト不要でリスト表示）
   - カードタップで既存の詳細表示を再利用
3. **ボード（カンバン）からtype=knowledgeを除外**（知見タブへ分離・フロー汚染防止）。検収トレイ・クイック・裁定は不変
4. CARD_INDEX.md再生成に**「主題」列を追加**（ID/名称/方向/種別/主題/タグ/浮上条件/状態/更新）
5. build表示を10へ・SWキャッシュ版数+1・新規view追加はconfig.jsのviewsリスト経由（既存コード無改変の原則）

## 3. Mac版（program-board・最小互換）

1. parser/serialize: subjectフィールドとtype=knowledgeを**無損失で往復**（未知フィールド保全が既にあるなら確認のみ）
2. CARD_INDEX再生成に「主題」列を追加（モバイルと同一列構成・同一日本語ラベル）
3. ボードUI: type=knowledgeカードに「知見」バッジ表示（カンバン除外まではしなくてよい・任意）

## 4. 受け入れ条件

- 両リポで `node --test` 全緑（追加: subject往復無損失・knowledge型の扱い・主題列つきindex再生成）
- 既存カードC-000〜C-002（subject有り・無し混在）を読んで壊れないこと（fixtureで検証・実Program書き込み禁止）
- **git commitのみ・pushしない**（発注元が検証後にpush）
