#!/bin/zsh
# モバイルボードの反映1コマンド（台帳更新後に基幹が実行）
# 焼き込み→コミット→push（GitHub Pagesが自動再公開・モバイルはリロード2回で最新化）
set -eu
cd "$(dirname "$0")"

# 平易文の変換キャッシュの鮮度検査（2026-08-03追加）
#   狙い＝再生成の取りこぼしをなくす。原典を直しても平易文は自動では追随しないため、
#   気づかないまま置き去りになると、ボードもモバイルも平易文を出せず機械抽出＋
#   「変換が古い」表示へ落ちる（実例=2026-08-03、原典更新の2分後に走った再生成が
#   1本取りこぼした。検査すれば一発で名指しできるのに、狙い撃ちの運用だったため）。
#   公開のたびに必ず目へ入る場所へ置くのが狙い。
#   公開自体は止めない＝変換の古さは公開の可否とは別の問題で、止めると完了登記が滞る。
_tf_check=../program-board/scripts/check-transform-stale.js
if [ -f "$_tf_check" ]; then
  if ! node "$_tf_check"; then
    echo ''
    echo '⚠️  上の平易文の変換が古くなっています（ボード・モバイルとも平易文が出ません）'
    echo '    → 再生成の便を立ててください（平易文はAIが書くもので機械生成できません）'
    echo '    → 公開自体はこのまま続けます'
    echo ''
  fi
else
  echo "（変換の鮮度検査は省略: $_tf_check が見つかりません）"
fi

node scripts/build-flow.cjs
git add docs/data/
git diff --cached --quiet && { echo "変更なし（公開済みが最新）"; exit 0; }
git commit -q -m "data: フロービュー再焼き込み $(date +%Y-%m-%d)"
git push
echo "公開完了"
