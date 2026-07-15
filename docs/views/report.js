'use strict';

// views/report.js — 「Report」タブ（type=report）。
// レイアウトは typeTab ファクトリを共有（Reference/Knowledge/Consult と完全同一・v1.4）。
// AI 発の完成・動作報告を読むだけの一覧（検収ボタンなし＝Acceptance タブとは別）。主題別＋全文検索。

import { registerView } from '../registry.js';
import { makeTypeTabView } from './typeTab.js';

registerView(makeTypeTabView({
  id: 'report',
  tabLabel: 'Report',
  type: 'report',
  hint: '報告=完成・動作報告（読むだけ）。主題別に整理。',
}));
