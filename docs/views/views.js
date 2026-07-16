'use strict';

// views/views.js — Views 群（Phase 3 で実装予定・準備中の空状態のみ・v2.2）。
// 進捗・ライブラリの一望ビュー。タブ自体は出すが中身は準備中。

import { registerView } from '../registry.js';
import { h } from './shared.js';

function create() {
  const root = h('div', 'placeholder');
  root.appendChild(h('h2', null, 'Views'));
  root.appendChild(h('p', 'view-hint', '進捗・ライブラリの一望ビュー（Phase 3 で実装予定）。準備中です。'));
  return root;
}

registerView({ id: 'views', tabLabel: 'Views', create });
