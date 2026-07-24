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

const BOARD = path.resolve(__dirname, '..', '..', 'program-board', 'server.js');
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'data');

function main() {
  const board = require(BOARD); // listen は走らない（ガード済み）＝5178 に無干渉
  if (typeof board.flowViewPayload !== 'function' || typeof board.flowOverviewPayload !== 'function') {
    throw new Error('server.js が flowViewPayload / flowOverviewPayload を export していません（版数不一致）');
  }
  const builtAt = new Date().toISOString();
  const flowView = { builtAt, ...board.flowViewPayload() };
  const flowOverview = { builtAt, ...board.flowOverviewPayload() };

  fs.mkdirSync(OUT_DIR, { recursive: true });
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
    '  出力先: ' + OUT_DIR + '\n',
  );
  if ((b.unclassified || 0) !== 0) {
    process.stderr.write('警告: 未分類が0ではありません（棚規則の見直しが要る可能性）。\n');
  }
}

main();
