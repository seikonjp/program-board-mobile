'use strict';

// build-flow.cjs — フロー2ビュー（フロー俯瞰・直近の詳細）の静的ペイロード焼き込み。
//
// モバイルは静的ホスティング（GitHub Pages）で、245KB の census 生データや重い純関数を
// クライアントへ運ばない。そこで「ビルド時に Mac 版 server.js の純関数（fs 層）を実行して、
// 導出済みの小さなペイロードを docs/data/*.json へ焼き込む」。モバイル app はそれを fetch で読むだけ。
//
// 静的のため、census / FLOW_VIEW_CONFIG / SC-F 等の台帳を更新したら、このスクリプトを
// 再実行してコミットし直すことで反映される（＝台帳更新後はビルド再実行で追従）。
//
// server.js は require.main === module ガードで listen を保護しているため、require しても
// 稼働中の 5178 サーバには一切触れない。パス解決は server.js 内の __dirname 基準（実 Dropbox）。

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run'); // 数だけ見る（docs/data を書かない）

const BOARD = path.resolve(__dirname, '..', '..', 'program-board', 'server.js');
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'data');
const DECISION_QUEUE = path.resolve(__dirname, '..', '..', '..', 'Program', 'DECISION_QUEUE.md');

// 決定待ちの焼き込み（板ID R4-4・2026-09-02）。
//   DECISION_QUEUE.md の未裁定行（`- [ ]`）だけを {id,title,priority,source,line} へ落とす。
//   解析は server.js の parseDecisionQueue をそのまま使う（板と同じ読み方＝二重実装しない）。
//   **決定待ち箱が読めなければ空配列で素通りする**（板全体を止めない）。
function buildDecisions(board) {
  if (typeof board.parseDecisionQueue !== 'function') return { list: [], ok: false };
  let text;
  try { text = fs.readFileSync(DECISION_QUEUE, 'utf8'); } catch (e) { return { list: [], ok: false }; }
  const list = board.parseDecisionQueue(text)
    .filter((it) => !it.decided)
    .map((it) => ({
      id: it.qid || '',
      title: it.title || '',
      // 優先度は `## P2 — S1〜S2着手前` の見出し由来。`P<数字>` だけを採り、無ければ見出しの原文。
      priority: (/(P\d+)/.exec(it.priority || '') || [null, it.priority || ''])[1],
      source: it.source || '',
      line: it.lineNo || 0,
    }));
  return { list, ok: true };
}

function main() {
  const board = require(BOARD); // listen は走らない（ガード済み）＝5178 に無干渉
  if (typeof board.flowViewPayload !== 'function' || typeof board.flowOverviewPayload !== 'function') {
    throw new Error('server.js が flowViewPayload / flowOverviewPayload を export していません（版数不一致）');
  }
  const builtAt = new Date().toISOString();
  const flowView = { builtAt, ...board.flowViewPayload() };
  const flowOverview = { builtAt, ...board.flowOverviewPayload() };

  // 決定待ち（板ID R4-4）。読めた／読めなかったを俯瞰の sourcesOk にも残す。
  const decisions = buildDecisions(board);
  flowOverview.sourcesOk = { ...(flowOverview.sourcesOk || {}), decisions: decisions.ok };

  if (DRY_RUN) {
    process.stdout.write(
      'dry-run（docs/data は書きません）\n' +
      '  decisions.json  : 決定待ち ' + decisions.list.length + '件（決定待ち箱=' + (decisions.ok ? '読めた' : '読めない→空配列で素通り') + '）\n' +
      '  内訳（優先度別）: ' + JSON.stringify(decisions.list.reduce((m, d) => { m[d.priority || '（無し）'] = (m[d.priority || '（無し）'] || 0) + 1; return m; }, {})) + '\n' +
      '  flow-view.json  : 柱' + (flowView.firstLine && flowView.firstLine.pillars ? flowView.firstLine.pillars.length : 0) + '\n' +
      '  flow-overview   : 全' + ((flowOverview.balance || {}).total || 0) + '・未分類' + ((flowOverview.balance || {}).unclassified || 0) + '\n',
    );
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'decisions.json'), JSON.stringify(decisions.list) + '\n');
  // 最小化（インデントなし）＝通信量配慮。改行1つで終端。
  fs.writeFileSync(path.join(OUT_DIR, 'flow-view.json'), JSON.stringify(flowView) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'flow-overview.json'), JSON.stringify(flowOverview) + '\n');

  const b = flowOverview.balance || {};
  process.stdout.write(
    '焼き込み完了 @ ' + builtAt + '\n' +
    '  flow-view.json      : 柱' + (flowView.firstLine && flowView.firstLine.pillars ? flowView.firstLine.pillars.length : 0) +
      '・分布' + JSON.stringify(flowView.dist || {}) + '・configOk=' + flowView.configOk + '\n' +
    '  flow-overview.json  : 全' + (b.total || 0) + '＝表示' + (b.shown || 0) +
      '・未分類' + (b.unclassified || 0) + '（登記簿' + (b.registry || 0) + '＋目録' + (b.inventory || 0) + '）\n' +
    '  decisions.json      : 決定待ち' + decisions.list.length + '件（決定待ち箱=' + (decisions.ok ? '読めた' : '読めない→空配列') + '）\n' +
    '  出力先: ' + OUT_DIR + '\n',
  );
  if ((b.unclassified || 0) !== 0) {
    process.stderr.write('警告: 未分類が0ではありません（棚規則の見直しが要る可能性）。\n');
  }
}

main();
