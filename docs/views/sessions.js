'use strict';

// views/sessions.js — Sessions 群（Phase 4 で実装予定・準備中の空状態のみ・v2.2）。
// 起動チケット一覧・▶起動。タブ自体は出すが中身は準備中。

import { registerView } from '../registry.js';
import { h } from './shared.js';

function create() {
  const root = h('div', 'placeholder');
  root.appendChild(h('h2', null, 'Sessions'));
  root.appendChild(h('p', 'view-hint', '起動チケット一覧・▶起動（Phase 4 で実装予定）。準備中です。'));
  return root;
}

registerView({ id: 'sessions', tabLabel: 'Sessions', create });
