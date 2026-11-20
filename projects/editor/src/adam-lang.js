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

  Adam Editor - Adam for Monaco (Monarch tokenizer).

  The word lists are not written here: adam --dev-editor writes Adam's
  keywords and builtin types (the Lexer's own table) into the packed
  package.json `words`, main.js hands them over with app:info and the
  renderer passes them to setWords. Adam is case-sensitive. The literal and
  comment rules follow BNF sec 9 (C++'s literal forms, no string prefixes,
  raw strings, block comments do not nest, line splices). This tokenizer
  gives instant colouring; the LSP's semantic tokens (M11b) refine it.
*/
'use strict';

var AdamLang = (function () {
  // Empty until the editor's words arrive (setWords)
  var WORDS = { keywords: [], types: [] };
  // The monaco register() was given: setWords re-sets the tokenizer with it
  var gMonaco = null;

  // pp-number body after its first digit (or '.' digit): a signed exponent
  // (tried first, or 'e' alone would match as a letter and stop at the sign),
  // digits, letters, '_', a ' separator before a digit / letter, a '.' not
  // followed by another '.' (so 1..5 is 1 .. 5)
  var PP_TAIL = "(?:[eEpP][+\\-]|[0-9A-Za-z_]|'[0-9A-Za-z]|\\.(?!\\.))*";

  var MONARCH = {
    defaultToken: '',
    tokenPostfix: '.adam',
    ignoreCase: false,
    keywords: WORDS.keywords,
    types: WORDS.types,

    tokenizer: {
      root: [
        { include: '@whitespace' },

        { include: '@literals' },

        // @directive: @ + identifier, exact case
        [/@[A-Za-z_]\w*/, 'annotation'],

        [/[A-Za-z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@types': 'type',
            '@default': 'identifier'
          }
        }],

        [/:=|\.\.|<>|<=|>=|::|->|<<|>>|\+\+|--|&&|\|\||[+\-*\/%=<>&|^~!?]=?/, 'operator'],
        [/[()\[\]{}]/, '@brackets'],
        [/[;,.:]/, 'delimiter']
      ],

      whitespace: [
        [/[ \t\f\v\r\n]+/, ''],
        [/\/\*/, 'comment', '@blockComment'],
        [/\/\/.*\\$/, 'comment', '@lineCommentSplice'],
        [/\/\/.*$/, 'comment']
      ],

      // Strings, chars and numbers
      literals: [
        // Raw string: R" delimiter ( ... ) delimiter " (no other prefix: Adam's
        // wide literals are type-driven)
        [/(R)(")([^ ()\\\t"]{0,16})(\()/, ['string', 'string', 'string', { token: 'string', next: '@raw.$3' }]],
        // Unterminated on its line (a trailing splice continues it instead)
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/'(?:[^'\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@string'],
        [/'/, 'string', '@char'],
        // Numbers (C++ pp-number shape; a suffix is part of the token)
        [new RegExp('(?:\\d|\\.\\d)' + PP_TAIL), {
          cases: {
            '~0[xX].*': 'number.hex',
            '~0[bB].*': 'number',
            '~[^eE]*(?:\\.|[eE][+\\-]?\\d).*': 'number.float',
            '@default': 'number'
          }
        }]
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/\\$/, 'string.escape'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop']
      ],
      char: [
        [/[^\\']+/, 'string'],
        [/\\$/, 'string.escape'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop']
      ],
      // $S2 = the raw delimiter (state raw.<delimiter>), as Monaco's cpp tokenizer
      raw: [
        [/(.*)(\))([^ ()\\\t"]*)(")/, {
          cases: {
            '$3==$S2': ['string', 'string', 'string', { token: 'string', next: '@pop' }],
            '@default': ['string', 'string', 'string', 'string']
          }
        }],
        [/.*$/, 'string']
      ],

      // Not nesting (BNF sec 9)
      blockComment: [
        [/[^*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/\*/, 'comment']
      ],
      // A // comment whose line ends in a splice continues on the next line
      lineCommentSplice: [
        [/.*\\$/, 'comment'],
        [/.*$/, 'comment', '@pop']
      ]
    }
  };

  var CONFIG = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
      { open: '/*', close: ' */', notIn: ['string'] }
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ],
    indentationRules: {
      // A line opening a block, or a bare section header (var / const / type)
      increaseIndentPattern: /^\s*((.*\b(begin|repeat|record|object|overlay|choices|guard|except|finally|then|do|else|of)\b\s*)|((var|const|type|import)\s*))$/,
      decreaseIndentPattern: /^\s*(end\b|until\b|else\b|except\b|finally\b)/
    }
  };

  var THEME = {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '569CD6' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'annotation', foreground: 'C586C0' },
      { token: 'string.invalid', foreground: 'F44747' },
      { token: 'string.escape', foreground: 'D7BA7D' },
      { token: 'number.hex', foreground: 'B5CEA8' },
      { token: 'number.float', foreground: 'B5CEA8' },
      // LSP semantic token types and modifiers; colours follow the Monarch
      // rules above. keyword, comment, string, number, type match existing
      // rules / the vs-dark base.
      { token: 'namespace', foreground: '4EC9B0' },
      { token: 'struct', foreground: '4EC9B0' },
      { token: 'class', foreground: '4EC9B0' },
      { token: 'enum', foreground: '4EC9B0' },
      { token: 'enumMember', foreground: '4FC1FF' },
      { token: 'parameter', foreground: '9CDCFE' },
      { token: 'variable', foreground: '9CDCFE' },
      { token: 'variable.readonly', foreground: '4FC1FF' },
      { token: 'property', foreground: '9CDCFE' },
      { token: 'function', foreground: 'DCDCAA' },
      { token: 'method', foreground: 'DCDCAA' },
      { token: 'operator', foreground: 'D4D4D4' },
      { token: 'macro', foreground: 'C586C0' }
    ],
    // Scrollbar slider = VS Code dark; same values as editor.css --adam-scroll-thumb*
    colors: {
      'scrollbarSlider.background': '#79797966',
      'scrollbarSlider.hoverBackground': '#646464b3',
      'scrollbarSlider.activeBackground': '#bfbfbf66'
    }
  };

  function register(AMonaco) {
    gMonaco = AMonaco;
    AMonaco.languages.register({ id: 'adam', extensions: ['.adam'], aliases: ['Adam', 'adam'] });
    AMonaco.languages.setMonarchTokensProvider('adam', MONARCH);
    AMonaco.languages.setLanguageConfiguration('adam', CONFIG);
    AMonaco.editor.defineTheme('adam-dark', THEME);
  }

  // Adam's keyword and builtin type lists ({ keywords, types }); a missing
  // or malformed list leaves the current one. Setting the tokenizer again
  // makes Monaco re-colour every open adam model
  function setWords(AWords) {
    if (!AWords || !Array.isArray(AWords.keywords) || !Array.isArray(AWords.types)) {
      return;
    }
    WORDS = { keywords: AWords.keywords.slice(), types: AWords.types.slice() };
    MONARCH.keywords = WORDS.keywords;
    MONARCH.types = WORDS.types;
    if (gMonaco) {
      gMonaco.languages.setMonarchTokensProvider('adam', MONARCH);
    }
  }

  return { register: register, setWords: setWords };
})();
