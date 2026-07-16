# Program Board Mobile

iPhone / iPad から Dropbox 上の `ArchPlan/Program/`（カード・INBOX・検収・裁定）を、Mac を経由せず直接読み書きする静的 PWA。データの正は Dropbox 上のファイル（Mac 版 `Tool/program-board/` と同じ実ファイルを見る別の窓＝二重の正なし）。

- **エンドユーザー向けセットアップ（約15分）** → [`README_SETUP.md`](./README_SETUP.md)
- 仕様 → `SPEC_MOBILE.md`（`ArchPlan/Tool/program-board-mobile/`）

## 技術

- 静的サイト・vanilla JS（ESM）・**外部依存/CDN ゼロ**・ビルド工程なし。公開ルート = `docs/`
- Dropbox API v2 直結（OAuth2 **PKCE** / refresh token・トークンは localStorage のみ・削除 API 不使用）
- iPhone/iPad 同一コード（狭幅=セグメント縦1カラム／広幅=カンバン＋詳細ペイン）

## 構成（`docs/`）

| ファイル | 役割 |
|----------|------|
| `index.html` / `style.css` | アプリ殻・スタイル |
| `config.js` | App key・Program ルート・起動タブ・**ビュー有効化リスト（views）** |
| `parser.js` | md 解析（frontmatter/セクション/`- [ ]`）・ID採番・INBOX追記・CARD_INDEX再生成（純粋関数） |
| `dropbox.js` | Dropbox API ゲートウェイ（PKCE・token管理・list/download/upload・**rev競合リトライ**） |
| `program.js` | ドメイン統治層（dropbox × parser を束ねる。削除しない・§1のみ追記等の規律） |
| `registry.js` | ビュー登録制の中核 |
| `app.js` | シェル（起動・OAuthリダイレクト・タブ・ポーリング・画像遅延読込・設定） |
| `views/*.js` | 1画面1モジュール（board / tray / quick / decision） |
| `sw.js` / `manifest.json` | PWA（**アプリ殻のみ**キャッシュ・データはキャッシュしない） |

将来ビュー（進捗・CONTROL ダッシュボード等）は `docs/views/<id>.js` を追加し `config.js` の `views` に1行足すだけで有効化できる（既存コード非改変）。

## テスト

```
node --test
```

`test/mobile.test.mjs` に4件:
1. カード frontmatter 往復無損失（C-U0000 相当 fixture）
2. ID 採番（list_folder 名から）
3. INBOX 追記の影響範囲（§1 のみ）＋ 409 競合リトライ（fetch モック）
4. CARD_INDEX 再生成（ヘッダ保持・表のみ差し替え）

Dropbox 通信層は fetch モックで単体テスト（実ネットワークアクセスなし）。
