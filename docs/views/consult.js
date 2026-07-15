'use strict';

// views/consult.js — 「Consult」タブ（type=consult。廃止語 request も consult 扱いで合流）。
// レイアウトは typeTab ファクトリを共有（Reference/Knowledge と完全同一・v1.3 §2-2）。

import { registerView } from '../registry.js';
import { makeTypeTabView } from './typeTab.js';

registerView(makeTypeTabView({
  id: 'consult',
  tabLabel: 'Consult',
  type: 'consult',
  hint: '問う=相談・提案・悩み・要望（ストック型）。主題別に整理。',
}));
