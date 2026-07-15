# Program Board Mobile — セットアップ手順書

iPhone / iPad から Dropbox 上の `ArchPlan/Program/`（カード・INBOX・検収）を、Mac を経由せず直接読み書きするための PWA です。**このアプリはあなた専用**で、公開されるのは画面のコード（UI）だけ。カードの中身も Dropbox のトークンも、あなたの端末の中（localStorage）にしか残りません。

所要時間の目安: **約15分**。順番どおりに進めれば完了します。

- 手順1: Dropbox App を登録する（App key と権限の設定）
- 手順2: GitHub Pages で公開する（UI コードだけが公開されること）
- 手順3: iPhone / iPad のホーム画面に追加する
- 手順4: 初回接続する

---

## 手順1: Dropbox App を登録する

Dropbox に「このアプリが Program フォルダを読み書きしてよい」と許可させるための登録です。

1. パソコンかスマホのブラウザで **https://www.dropbox.com/developers/apps** を開き、Dropbox にログインする。
2. **「Create app」** を押す。
3. 選択肢を次のとおりにする。
   - **Choose an API**: `Scoped access`
   - **Choose the type of access**: `Full Dropbox`（`ArchPlan/Program` は Apps フォルダの外にあるため `Full Dropbox` を選ぶ）
   - **Name your app**: 好きな名前（例: `program-board-mobile-seiko`）。世界で一意なので、被ったら少し変える。
4. 作成すると設定画面（Settings タブ）が開く。**「App key」** の文字列をコピーしておく（後で使う。これは公開してよい値）。
5. **Permissions タブ**を開き、次の4つにチェックを入れて **Submit** する。
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`
   - （`account_info.read` があれば入れてよいが必須ではない）
6. **Settings タブに戻り**、**「OAuth 2 → Redirect URIs」** の欄に、手順2で決めるあなたの公開 URL を **後で**登録します（今は空のままでOK。手順2の最後で戻ってきます）。
   - ここに入れる URL は「アプリを開くときのアドレスそのもの」。例: `https://ユーザー名.github.io/program-board-mobile/`
   - **末尾のスラッシュまで正確に**一致させる必要があります。

> メモ: このアプリは PKCE という方式を使うため **App secret は使いません**（コピー不要）。secret をコードに書くこともありません。

---

## 手順2: GitHub Pages で公開する

`docs/` フォルダの中身（HTML/JS/CSS）だけをネットに置きます。**カードやトークンは含まれません**（このリポジトリにデータは一切入っていません）。

### 2-1. App key をコードに設定する

1. このプロジェクトの **`docs/config.js`** をテキストエディタで開く。
2. `dropboxClientId: 'PUT_YOUR_DROPBOX_APP_KEY_HERE'` の部分を、手順1でコピーした **App key** に書き換えて保存する。
   - 例: `dropboxClientId: 'abcd1234efgh5678',`
3. `programRoot` が `'/ArchPlan/Program'` になっていることを確認（Dropbox 上の実際の場所と違う場合はここを直す。後から設定画面でも変更可）。

### 2-2. GitHub にアップロードする

1. GitHub で新しいリポジトリを作る（例: `program-board-mobile`）。**Public でも Private でもよい**が、GitHub Pages を無料で使うなら Public が簡単。
2. このフォルダ（`program-board-mobile`）の中身をそのリポジトリに push する。
   - `git` を使う場合、このフォルダで既に `git init` 済みなので、リモートを追加して push するだけ:
     ```
     git remote add origin https://github.com/ユーザー名/program-board-mobile.git
     git branch -M main
     git push -u origin main
     ```
   - パソコンが苦手なら、GitHub の Web 画面で「Add file → Upload files」でフォルダごとドラッグしてもよい。

### 2-3. Pages を有効にする

1. リポジトリの **Settings → Pages** を開く。
2. **Build and deployment → Source** を `Deploy from a branch` にする。
3. **Branch** を `main`、フォルダを **`/docs`** に設定して **Save**。
4. 1〜2分待つと、上部に公開 URL が出る（例: `https://ユーザー名.github.io/program-board-mobile/`）。この URL をメモする。

> 公開されるのは `docs/` の中身（画面のコード）だけです。あなたのカード内容・Dropbox のトークンはこの URL には含まれません。

### 2-4. Redirect URI を Dropbox に登録する（手順1の続き）

1. 手順1の Dropbox App 設定画面（Settings タブ）に戻る。
2. **OAuth 2 → Redirect URIs** に、2-3でメモした公開 URL を**そのまま**貼り付けて **Add** する。
   - 例: `https://ユーザー名.github.io/program-board-mobile/`
   - **末尾スラッシュを含め完全一致**させること（ズレると接続時にエラーになる）。

---

## 手順3: iPhone / iPad のホーム画面に追加する

アプリのように全画面で使えるようにします。

1. iPhone / iPad の **Safari**（Chrome ではなく Safari）で、2-3の公開 URL を開く。
2. 画面下（iPad は上）の **共有ボタン**（□に↑）をタップ。
3. **「ホーム画面に追加」** をタップ → 右上の **「追加」**。
4. ホーム画面に「Program」アイコンができる。以降はこれをタップして起動する（全画面表示になる）。

---

## 手順4: 初回接続する

1. ホーム画面の「Program」を開く。
2. **「Dropbox に接続」** をタップ。
3. Dropbox のログイン／許可画面が出るので、内容を確認して **許可** する。
4. 自動でアプリに戻り、カードのボードが表示されれば成功。
   - 一度接続すれば、次回以降は自動でログイン状態が保たれます（トークンはこの端末だけに保存）。
5. 動作確認（一巡）:
   - **ボード**タブ … 既存カードが状態別に並ぶ。「📷 写真を選ぶ」で新規カードを作成できる。
   - **検収**タブ … 検収待ちがあれば OK／NG／あとで が押せる。
   - **クイック**タブ … 一行書いて登録すると INBOX（§1 新規）に `（📱）` 付きで追記される。
   - **裁定**タブ … DECISION_QUEUE.md が表示される（読み取り専用）。
   - 右上 **⚙ 設定** … 接続の切断、Program ルートパス、起動タブを変更できる。

---

## うまくいかないとき

- **接続で「state 不一致」や「invalid redirect_uri」**: 手順2-4の Redirect URI が公開 URL と完全一致していない。末尾スラッシュ・大文字小文字・`http`/`https` を見直す。
- **「config.js に Dropbox App key を設定してください」**: 手順2-1の書き換えを忘れている。
- **カードが出てこない / 「Program フォルダが見つからない」**: 設定画面の Program ルートパスが実際のフォルダと違う。`/ArchPlan/…` のように Dropbox の絶対パスで指定する（既定 `/ArchPlan/Program`）。
- **画像が表示されない**: オフラインだと画像は読み込めません（テキストは最終取得分が見えます）。オンラインで手動更新（右上 ⟳）してください。
- **権限エラー**: 手順1-5の4つの Permission にチェックが入っているか確認。変更した場合は一度アプリで「切断」→再接続。

## 安全性について

- Dropbox のトークンとカードの控えは、**この端末のブラウザ（localStorage）にのみ**保存され、外部に送信されません。通信先は Dropbox の API だけです。
- アプリはファイルを**削除しません**（状態変更と追記のみ）。Mac 版と同じ実ファイルを見ています（二重管理なし）。
- 端末を手放すときや共有端末では、設定画面の **「切断」** でトークンを消してください。
