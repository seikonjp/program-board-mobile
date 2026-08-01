#!/bin/zsh
# モバイルボードの反映1コマンド（台帳更新後に基幹が実行）
# 焼き込み→コミット→push（GitHub Pagesが自動再公開・モバイルはリロード2回で最新化）
set -eu
cd "$(dirname "$0")"
node scripts/build-flow.cjs
git add docs/data/
git diff --cached --quiet && { echo "変更なし（公開済みが最新）"; exit 0; }
git commit -q -m "data: フロービュー再焼き込み $(date +%Y-%m-%d)"
git push
echo "公開完了"
