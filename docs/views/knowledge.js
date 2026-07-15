'use strict';

// views/knowledge.js — 「Knowledge」タブ（type=knowledge）。
// レイアウトは typeTab ファクトリを共有（Reference/Consult と完全同一・v1.3 §2-2）。
// 設計知識・作者証言のストック置き場。主題別グルーピング＋全文検索。

import { registerView } from '../registry.js';
import { makeTypeTabView } from './typeTab.js';

registerView(makeTypeTabView({
  id: 'knowledge',
  tabLabel: 'Knowledge',
  type: 'knowledge',
  hint: '残す=知見・証言（ストック型）。主題別に整理。',
}));
