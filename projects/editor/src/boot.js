/*
  Adam™ Programming Language

  Copyright © 2026-present tinyBigGAMES™ LLC
  All Rights Reserved.

  https://adamlang.org

  SPDX-License-Identifier: MPL-2.0

  This Source Code Form is subject to the terms of the
  Mozilla Public License, v. 2.0. If a copy of the MPL
  was not distributed with this file, You can obtain one
  at https://mozilla.org/MPL/2.0/.

  ---

  Adam Editor - boot: configure the Monaco AMD loader and start.
  Kept out of index.html so the CSP needs no 'unsafe-inline' for scripts.
*/
'use strict';

require.config({ paths: { vs: 'vendor/monaco/min/vs' } });
require(['vs/editor/editor.main'], function () {
  AdamLang.register(monaco);
  AdamEditor.start(monaco);
});
