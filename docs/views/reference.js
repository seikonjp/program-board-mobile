'use strict';

// views/reference.js — 「Reference」タブ（type=reference）。
// レイアウトは typeTab ファクトリを共有（Knowledge/Consult と完全同一・v1.3 §2-2）。

import { registerView } from '../registry.js';
import { makeTypeTabView } from './typeTab.js';

registerView(makeTypeTabView({
  id: 'reference',
  tabLabel: 'Reference',
  type: 'reference',
  hint: '見せる=参考・画像（ストック型）。主題別に整理。',
}));
