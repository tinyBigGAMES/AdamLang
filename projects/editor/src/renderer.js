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

  Adam Editor - renderer.

  Documents and tabs. One Monaco editor, one model per tab; switching a tab
  swaps the model and restores that tab's view state. A tab's identity is
  its file path (tab.path), never the model Uri: models are created without
  a Uri, so Save As keeps the model (and its undo history) and no two tabs
  can collide on a Uri. File access goes through window.host (preload.js).
  Dirty state is the model's alternative version id against the id at the
  last open/save, so undoing back to the saved text is clean.
*/
'use strict';

var AdamEditor = (function () {
  var gMonaco = null;
  var gEditor = null;
  // Tab: { path, untitledName, model, viewState, savedVersion, diskText,
  // diskState } (diskText / diskState: onDiskChanges)
  var gTabs = [];
  var gActive = -1;
  var gUntitledCount = 0;
  // Session sync state (syncSession)
  var gSessionReady = false;
  var gLastSession = '';
  // The tab files main.js watches, as last sent (syncFileWatch), and the
  // queue that handles disk changes one at a time (onDiskChanges)
  var gLastWatch = '';
  var gDiskQueue = Promise.resolve();

  function baseName(APath) {
    var LParts = APath.split(/[\\/]/);
    return LParts[LParts.length - 1];
  }

  // Windows paths compare case-insensitively
  function samePath(AA, AB) {
    return !!AA && !!AB && AA.toLowerCase() === AB.toLowerCase();
  }

  function tabLabel(ATab) {
    return ATab.path ? baseName(ATab.path) : ATab.untitledName;
  }

  // The text differs from what was last loaded / saved
  function modelDirty(ATab) {
    return ATab.model.getAlternativeVersionId() !== ATab.savedVersion;
  }

  // Unsaved: edited, or the file was deleted on disk (a save recreates it)
  function isDirty(ATab) {
    return modelDirty(ATab) || ATab.diskState === 'deleted';
  }

  // What the tab strip adds to the label of a tab whose file moved on disk
  function diskSuffix(ATab) {
    if (ATab.diskState === 'deleted') {
      return ' (deleted)';
    }
    if (ATab.diskState === 'changed') {
      return ' (changed on disk)';
    }
    return '';
  }

  function anyDirty() {
    var LIndex;
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (isDirty(gTabs[LIndex])) {
        return true;
      }
    }
    return false;
  }

  function activeTab() {
    return gTabs[gActive];
  }

  function findTab(APath) {
    var LIndex;
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (samePath(gTabs[LIndex].path, APath)) {
        return LIndex;
      }
    }
    return -1;
  }

  // An untitled tab nobody has typed into; opening a file replaces it
  function isPristineUntitled(ATab) {
    return !ATab.path && ATab.model.getValueLength() === 0 && !isDirty(ATab);
  }

  function refresh() {
    var LList = [];
    var LIndex;
    var LTab = activeTab();
    var LDirty;

    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      LList.push({
        label: tabLabel(gTabs[LIndex]) + diskSuffix(gTabs[LIndex]),
        tooltip: (gTabs[LIndex].path || gTabs[LIndex].untitledName) + diskSuffix(gTabs[LIndex]),
        dirty: isDirty(gTabs[LIndex])
      });
    }
    AdamShell.setTabs(LList, gActive, activateTab, closeTab);

    LDirty = isDirty(LTab);
    AdamShell.setTitle((LDirty ? '* ' : '') + tabLabel(LTab) + ' - Adam Editor');
    AdamShell.setFileState(LDirty, anyDirty(), !!LTab.path);
    // main.js guards the window close with this: any tab unsaved; Pack's
    // menu state follows the active file ('' = untitled)
    window.host.setDocState({ title: tabLabel(LTab), dirty: anyDirty(), path: LTab.path || '' });
    AdamExplorer.setActive(LTab.path);
    syncSession();
    syncFileWatch();
    // Every tab-set/path change passes through here: keep the server's
    // open documents in step
    syncLspDocs();
  }

  // Names the file tabs to main.js (file:watch) when the set changed, so a
  // change on disk reaches the tab (onDiskChanges)
  function syncFileWatch() {
    var LFiles = [];
    var LIndex;
    var LKey;

    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (gTabs[LIndex].path) {
        LFiles.push(gTabs[LIndex].path);
      }
    }
    LKey = JSON.stringify(LFiles);
    if (LKey !== gLastWatch) {
      gLastWatch = LKey;
      window.host.watchFiles(LFiles);
    }
  }

  // Disk changes from main.js: [{ path, exists }], handled one at a time in
  // arrival order (a prompt waits for the one before it)
  function onDiskChanges(AChanges) {
    var LIndex;

    for (LIndex = 0; LIndex < AChanges.length; LIndex++) {
      queueDiskChange(AChanges[LIndex].path, AChanges[LIndex].exists);
    }
  }

  function queueDiskChange(APath, AExists) {
    gDiskQueue = gDiskQueue.then(function () {
      return handleDiskChange(APath, AExists);
    }).catch(function (AErr) {
      AdamShell.outputLine('File watch: ' + String(AErr && AErr.message ? AErr.message : AErr));
    });
  }

  // One file changed on disk. Nothing happens when the disk text is the text
  // this tab last loaded or wrote (diskText), so the editor's own saves are
  // silent. Otherwise:
  //   clean tab -> the new text replaces the old in one undoable edit,
  //                cursor and scroll kept, the tab stays clean
  //   dirty tab -> the tab is marked changed on disk and asks: reload (the
  //                edits are lost) or keep mine (the next save overwrites)
  //   deleted   -> the text stays, the tab is marked deleted and unsaved;
  //                a save recreates the file
  async function handleDiskChange(APath, AExists) {
    var LIndex = findTab(APath);
    var LTab;
    var LRes;

    if (LIndex < 0) {
      return;
    }
    LTab = gTabs[LIndex];
    if (!AExists) {
      if (LTab.diskState !== 'deleted') {
        LTab.diskState = 'deleted';
        LTab.diskText = null;
        // Name the files again: main.js stopped watching a directory that
        // went away and starts again once it is back (file:watch)
        gLastWatch = '';
        refresh();
      }
      return;
    }
    LRes = await window.host.readFile(LTab.path);
    // Unreadable now (mid-replace by another program): its next change
    // brings another notice. The tab may have closed during the read.
    if (!LRes.ok || gTabs.indexOf(LTab) < 0) {
      return;
    }
    if (LRes.text === LTab.diskText) {
      return;
    }
    if (!modelDirty(LTab)) {
      reloadTab(LTab, LRes.text);
      return;
    }
    LTab.diskText = LRes.text;
    LTab.diskState = 'changed';
    refresh();
    if (window.confirm(tabLabel(LTab) + ' changed on disk.\n\n' +
        'OK: reload it from disk (your unsaved edits are lost)\n' +
        'Cancel: keep your edits (the next save overwrites the file)')) {
      if (gTabs.indexOf(LTab) >= 0) {
        reloadTab(LTab, LRes.text);
      }
      return;
    }
    // Kept: unsaved until the next save, even if every edit is undone (the
    // saved version is the old disk text, no longer the file's)
    LTab.savedVersion = -1;
    refresh();
  }

  // Replaces the tab's text with the disk's in one undoable edit (undo brings
  // the old text back, as unsaved); cursor, selection and scroll are kept
  function reloadTab(ATab, AText) {
    var LActive = gEditor.getModel() === ATab.model;
    var LView = null;

    if (ATab.model.getValue() !== AText) {
      if (LActive) {
        LView = gEditor.saveViewState();
      }
      ATab.model.pushStackElement();
      ATab.model.pushEditOperations([], [{ range: ATab.model.getFullModelRange(), text: AText }], function () {
        return null;
      });
      ATab.model.pushStackElement();
      if (LActive) {
        gEditor.restoreViewState(LView);
      }
    }
    ATab.savedVersion = ATab.model.getAlternativeVersionId();
    ATab.diskText = AText;
    ATab.diskState = '';
    refresh();
  }

  // Reports the file tabs to main.js (state.json) when the set or the
  // active one changed. Off until start() has restored the previous
  // session, or the startup Untitled tab would overwrite the saved list.
  function syncSession() {
    var LFiles = [];
    var LIndex;
    var LActive;
    var LKey;

    if (!gSessionReady) {
      return;
    }
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (gTabs[LIndex].path) {
        LFiles.push(gTabs[LIndex].path);
      }
    }
    LActive = activeTab().path || '';
    LKey = JSON.stringify([LFiles, LActive]);
    if (LKey !== gLastSession) {
      gLastSession = LKey;
      window.host.saveSession(LFiles, LActive);
    }
  }

  // A save passes the text it wrote (ADiskText) and the model version that
  // text is (AVersion), both taken BEFORE the write: an edit made while the
  // write was in flight is not on disk and must stay unsaved. Left out =
  // the tab's text as it is now (open, rename: already on disk).
  function markSaved(ATab, ADiskText, AVersion) {
    ATab.savedVersion = (AVersion !== undefined) ? AVersion : ATab.model.getAlternativeVersionId();
    ATab.diskText = (ADiskText !== undefined) ? ADiskText : ATab.model.getValue();
    ATab.diskState = '';
    refresh();
  }

  function activateTab(AIndex) {
    var LTab = gTabs[AIndex];
    var LPos;

    // Keep the outgoing tab's cursor/scroll/folding
    if (gActive >= 0 && gActive !== AIndex && gTabs[gActive]) {
      gTabs[gActive].viewState = gEditor.saveViewState();
    }
    gActive = AIndex;
    if (gEditor.getModel() !== LTab.model) {
      gEditor.setModel(LTab.model);
      gEditor.restoreViewState(LTab.viewState);
    }
    LPos = gEditor.getPosition();
    if (LPos) {
      AdamShell.setCursor(LPos.lineNumber, LPos.column);
    }
    refresh();
    gEditor.focus();
  }

  // Every model carries a URI: file tabs the LSP document URI (parsed, so
  // Monaco routes definition / references / rename edits to it), untitled
  // tabs untitled:<name>. A model's URI is fixed at creation, so a tab whose
  // path changes gets a new model (retargetTab). Map a model back to its LSP
  // URI with lspUriOfModel, never model.uri.toString() (Monaco re-encodes).
  function documentUri(APath, AUntitledName) {
    if (APath) {
      return gMonaco.Uri.parse(AdamLsp.pathToUri(APath));
    }
    return gMonaco.Uri.from({ scheme: 'untitled', path: AUntitledName });
  }

  // uri string (model.uri.toString()) -> LSP uri, for models loaded from
  // disk without a tab (peek into a closed file). A tab opening that file
  // adopts the model (takeModel).
  var gBackgroundModels = {};

  // Adam sources: .adam files, and untitled tabs (they save as .adam).
  // Only these get the 'adam' language and reach the LSP: one rule for both.
  function isSourcePath(APath) {
    return !APath || /\.adam$/i.test(APath);
  }

  // Monaco language for a tab's file: 'adam' for Adam sources, else the
  // language Monaco registers for the extension (python, json, ...), else
  // plain text
  function languageOf(APath) {
    var LExt;
    var LLangs;
    var LIndex;

    if (isSourcePath(APath)) {
      return 'adam';
    }
    LExt = (APath.match(/\.[^.\\\/]+$/) || [''])[0].toLowerCase();
    if (LExt) {
      LLangs = gMonaco.languages.getLanguages();
      for (LIndex = 0; LIndex < LLangs.length; LIndex++) {
        if (LLangs[LIndex].id !== 'adam' && (LLangs[LIndex].extensions || []).indexOf(LExt) >= 0) {
          return LLangs[LIndex].id;
        }
      }
    }
    return 'plaintext';
  }

  // A tab's model for AUri (the file APath, '' / null = untitled): adopts a
  // background model, else creates one, in APath's language.
  // Invariant: no other TAB holds AUri (findTab / doSaveAs guarantee it).
  function takeModel(AUri, AText, APath) {
    var LModel = gMonaco.editor.getModel(AUri);
    var LKey = AUri.toString();
    var LLanguage = languageOf(APath);

    if (LModel) {
      if (!gBackgroundModels[LKey]) {
        throw new Error('takeModel: ' + LKey + ' already belongs to a tab');
      }
      delete gBackgroundModels[LKey];
      if (LModel.getValue() !== AText) {
        LModel.setValue(AText);
      }
      if (LModel.getLanguageId() !== LLanguage) {
        gMonaco.editor.setModelLanguage(LModel, LLanguage);
      }
      return LModel;
    }
    return gMonaco.editor.createModel(AText, LLanguage, AUri);
  }

  function bindModel(ATab) {
    ATab.model.onDidChangeContent(refresh);
    ATab.model.onDidChangeContent(function (AEvent) {
      dropEditedErrorLines(ATab, AEvent);
    });
    ATab.model.onDidChangeContent(function () {
      scheduleLspChange(ATab);
    });
  }

  // Gives ATab a model for APath (Save As, a reused Untitled). The old
  // model's undo history goes with it: Monaco cannot change a model's URI.
  function retargetTab(ATab, APath, AText) {
    var LOld = ATab.model;
    var LView;

    clearTimeout(ATab.lspTimer);
    ATab.lspTimer = null;
    ATab.path = APath;
    ATab.untitledName = '';
    ATab.model = takeModel(documentUri(APath, ''), AText, APath);
    ATab.errorDecos = [];
    ATab.errorLines = [];
    bindModel(ATab);
    // Same text in the new model: keep cursor, selection and scroll
    if (gEditor.getModel() === LOld) {
      LView = gEditor.saveViewState();
      gEditor.setModel(ATab.model);
      gEditor.restoreViewState(LView);
    }
    LOld.dispose();
  }

  function addTab(APath, AText) {
    var LTab = {
      path: APath,
      untitledName: '',
      model: null,
      viewState: null,
      savedVersion: 0,
      // The text last loaded from or written to the file (null: none / the
      // file is gone) and '' | 'changed' | 'deleted' (handleDiskChange)
      diskText: APath ? AText : null,
      diskState: '',
      // Error-line tint decoration ids and their last known lines (applyErrorLines)
      errorDecos: [],
      errorLines: [],
      // URI the LSP server has this tab open under ('' = not open) and the
      // pending debounced didChange (syncLspDocs / scheduleLspChange)
      lspUri: '',
      lspTimer: null
    };
    if (!APath) {
      gUntitledCount++;
      LTab.untitledName = 'Untitled-' + gUntitledCount;
    }
    LTab.model = takeModel(documentUri(APath, LTab.untitledName), AText, APath);
    LTab.savedVersion = LTab.model.getAlternativeVersionId();
    bindModel(LTab);
    gTabs.push(LTab);
    // Problems from the last build that belong to this file
    applyMarkers(LTab);
    activateTab(gTabs.length - 1);
  }

  function openDocument(APath, AText) {
    var LIndex = findTab(APath);
    var LTab;

    if (LIndex >= 0) {
      activateTab(LIndex);
      return;
    }
    // A lone untouched Untitled tab is replaced instead of kept beside it
    if (gTabs.length === 1 && isPristineUntitled(gTabs[0])) {
      LTab = gTabs[0];
      retargetTab(LTab, APath, AText);
      gEditor.setPosition({ lineNumber: 1, column: 1 });
      markSaved(LTab);
      applyMarkers(LTab);
      gEditor.focus();
      return;
    }
    addTab(APath, AText);
  }

  function closeTab(AIndex) {
    var LTab = gTabs[AIndex];

    if (isDirty(LTab) && !window.confirm('Discard unsaved changes to ' + tabLabel(LTab) + '?')) {
      return;
    }
    removeTab(AIndex);
  }

  // Removes without asking. The editor is moved to another model before
  // the closed one is disposed; the last tab closing leaves a new Untitled.
  function removeTab(AIndex) {
    var LTab = gTabs[AIndex];

    gTabs.splice(AIndex, 1);
    if (gTabs.length === 0) {
      gActive = -1;
      addTab(null, '');
    } else if (AIndex === gActive) {
      gActive = -1;
      activateTab(Math.min(AIndex, gTabs.length - 1));
    } else {
      if (AIndex < gActive) {
        gActive--;
      }
      refresh();
    }
    LTab.model.dispose();
  }

  function showError(AAction, ARes) {
    if (ARes && !ARes.ok && !ARes.canceled) {
      window.alert(AAction + ' failed: ' + (ARes.error || 'unknown error'));
    }
  }

  async function doOpen() {
    var LRes = await window.host.openFile();
    if (LRes.ok) {
      openDocument(LRes.path, LRes.text);
    } else {
      showError('Open', LRes);
    }
  }

  // Explorer click: an open tab is just shown, otherwise the file is read
  async function openPath(APath) {
    var LIndex = findTab(APath);
    var LRes;

    if (LIndex >= 0) {
      activateTab(LIndex);
      return;
    }
    LRes = await window.host.readFile(APath);
    if (LRes.ok) {
      openDocument(LRes.path, LRes.text);
    } else {
      showError('Open', LRes);
    }
  }

  // Several files in turn (an open one is just shown); the last is active
  async function openPaths(APaths) {
    var LIndex;

    for (LIndex = 0; LIndex < APaths.length; LIndex++) {
      await openPath(APaths[LIndex]);
    }
  }

  // Adds a folder root; main.js returns the whole list either way
  async function doOpenFolder() {
    var LRes = await window.host.openFolder();
    if (LRes.ok) {
      AdamExplorer.setFolders(LRes.folders);
    }
  }

  // Open tabs stay open: they are files, not folders
  async function doCloseFolder(APath) {
    var LRes = await window.host.closeFolder(APath);
    AdamExplorer.setFolders(LRes.folders);
  }

  async function doCloseAllFolders() {
    var LRes = await window.host.closeAllFolders();
    AdamExplorer.setFolders(LRes.folders);
  }

  // AOn = true / false, or null = flip (File > Show Examples); main.js owns
  // the remembered setting and the menu tick
  async function doShowExamples(AOn) {
    var LRes = await window.host.showExamples(AOn);
    AdamExplorer.setExamples(LRes.ok ? LRes.path : '');
  }

  async function doSaveAs() {
    var LTab = activeTab();
    var LRes;
    var LOther;
    var LText;
    var LVersion;

    await formatBeforeSave(LTab);
    LText = LTab.model.getValue();
    LVersion = LTab.model.getAlternativeVersionId();
    LRes = await window.host.saveFileAs(LText, LTab.path || (LTab.untitledName + '.adam'));
    if (!LRes.ok) {
      showError('Save', LRes);
      return false;
    }
    // Another tab showing the file just overwritten is stale: drop it
    // first, its model holds the URI this tab's new model takes
    LOther = findOtherTab(LTab, LRes.path);
    if (LOther >= 0) {
      removeTab(LOther);
    }
    if (LTab.path !== LRes.path) {
      // A new model, so the version taken before the write means nothing
      // in it: it holds the tab's text as it is now, saved only if that is
      // the text written (-1 = never matches: an edit made during the write)
      retargetTab(LTab, LRes.path, LTab.model.getValue());
      LVersion = (LTab.model.getValue() === LText) ? LTab.model.getAlternativeVersionId() : -1;
    }
    markSaved(LTab, LText, LVersion);
    return true;
  }

  // Rename: the file is renamed (or moved) on disk and the tab follows it.
  // Unsaved edits are saved first so the renamed file matches the tab.
  async function doRename() {
    var LTab = activeTab();
    var LRes;
    var LOther;

    if (!LTab.path) {
      return false;
    }
    if (isDirty(LTab) && !(await doSave())) {
      return false;
    }
    LRes = await window.host.renameFile(LTab.path);
    if (!LRes.ok) {
      showError('Rename', LRes);
      return false;
    }
    if (samePath(LTab.path, LRes.path)) {
      return true;
    }
    // A tab showing the file just replaced is stale: drop it first, its
    // model holds the URI this tab's new model takes
    LOther = findOtherTab(LTab, LRes.path);
    if (LOther >= 0) {
      removeTab(LOther);
    }
    retargetTab(LTab, LRes.path, LTab.model.getValue());
    markSaved(LTab);
    return true;
  }

  function findOtherTab(ATab, APath) {
    var LIndex;
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (gTabs[LIndex] !== ATab && samePath(gTabs[LIndex].path, APath)) {
        return LIndex;
      }
    }
    return -1;
  }

  async function doSave() {
    var LTab = activeTab();
    var LRes;
    var LText;
    var LVersion;

    if (!LTab.path) {
      return await doSaveAs();
    }
    await formatBeforeSave(LTab);
    LText = LTab.model.getValue();
    LVersion = LTab.model.getAlternativeVersionId();
    LRes = await window.host.saveFile(LTab.path, LText);
    if (LRes.ok) {
      markSaved(LTab, LText, LVersion);
      return true;
    }
    showError('Save', LRes);
    return false;
  }

  // The compiler reads from disk: the active tab must be a saved .adam, and
  // every other dirty file-backed tab is saved too, or an edited unit open in
  // another tab would build stale. False = build must not start.
  // AWhat names the caller in its report ('Build', 'Run', 'Debug')
  async function saveForBuild(AWhat) {
    var LTab = activeTab();

    if (!LTab.path || isDirty(LTab)) {
      if (!(await doSave())) {
        return false;
      }
    }
    // Saved above, so the path is set; a file path must be an Adam source
    if (!LTab.path || !isSourcePath(LTab.path)) {
      AdamShell.showPanel('output');
      AdamShell.outputLine(AWhat + ': the active file is not a .adam source: ' + LTab.path);
      return false;
    }
    return await saveDirtyFileTabs(LTab);
  }

  // Writes every dirty tab that has a file, except ASkip (null = none).
  // False = a save failed (reported); the remaining tabs were not tried.
  async function saveDirtyFileTabs(ASkip) {
    var LIndex;
    var LTab;
    var LRes;
    var LText;
    var LVersion;

    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      LTab = gTabs[LIndex];
      if (LTab !== ASkip && LTab.path && isDirty(LTab)) {
        await formatBeforeSave(LTab);
        LText = LTab.model.getValue();
        LVersion = LTab.model.getAlternativeVersionId();
        LRes = await window.host.saveFile(LTab.path, LText);
        if (!LRes.ok) {
          showError('Save', LRes);
          return false;
        }
        markSaved(LTab, LText, LVersion);
      }
    }
    return true;
  }

  // Save All: file tabs are written in place, then each dirty Untitled tab
  // is shown and gets a Save As dialog (Cancel stops there). The tab that
  // was active is shown again at the end.
  async function doSaveAll() {
    var LActive = activeTab();
    var LUntitled = [];
    var LIndex;

    if (!(await saveDirtyFileTabs(null))) {
      return false;
    }
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (!gTabs[LIndex].path && isDirty(gTabs[LIndex])) {
        LUntitled.push(gTabs[LIndex]);
      }
    }
    for (LIndex = 0; LIndex < LUntitled.length; LIndex++) {
      // A Save As over another open file removes that tab: skip if gone
      if (gTabs.indexOf(LUntitled[LIndex]) < 0) {
        continue;
      }
      activateTab(gTabs.indexOf(LUntitled[LIndex]));
      if (!(await doSaveAs())) {
        return false;
      }
    }
    LIndex = gTabs.indexOf(LActive);
    if (LIndex >= 0) {
      activateTab(LIndex);
    }
    return true;
  }

  // True while adam.exe is building or packing (a Run is a DAP session:
  // src/debug.js)
  var gBuildActive = false;

  // Problems from the last build. adam's report line (Adam.Compiler.Diagnostics
  // Display, ADAM_MSG_DIAGNOSTICS_AT):
  //   <path>(<line>,<col>): <Hint|Warning|Error|Fatal> <CODE>: <message>
  // A report with no place or a whole-file one has no squiggle: not matched
  var ADAM_PROBLEM_RE = /^(.+)\((\d+),(\d+)\):\s+(Hint|Warning|Error|Fatal)\s+([A-Z]{2}\d{4}):\s+(.*)$/;
  // adam's severity word -> the problem list's code
  var ADAM_PROBLEM_SEV = { Hint: 'HINT', Warning: 'WARN', Error: 'ERROR', Fatal: 'FATAL' };
  var ADAM_MARKER_OWNER = 'adam-build';
  var gProblems = [];
  // Output text after the last newline, completed by the next chunk
  var gLineBuf = '';

  function parseProblemLine(ALine) {
    // A bare \r redraws the line: only the text after the last one is shown
    var LText = ALine.replace(/\r+$/, '');
    var LMatch;
    LText = LText.slice(LText.lastIndexOf('\r') + 1);
    LMatch = ADAM_PROBLEM_RE.exec(LText);
    if (!LMatch) {
      return;
    }
    gProblems.push({
      sev: ADAM_PROBLEM_SEV[LMatch[4]],
      // Tabs hold Windows paths; a '/' the compiler prints is made native
      path: LMatch[1].replace(/\//g, '\\'),
      line: parseInt(LMatch[2], 10),
      // adam's column counts UTF-8 bytes (RULES-ADAM): problemColumn turns it
      // into Monaco's UTF-16 units once the file's text is at hand
      col: parseInt(LMatch[3], 10),
      bytes: true,
      code: LMatch[5],
      msg: LMatch[6]
    });
  }

  // AByteCol (1-based, UTF-8 bytes) on line ALine of AModel as Monaco's
  // column (1-based, UTF-16 units); past the line's end: its end + 1
  function utf16Column(AModel, ALine, AByteCol) {
    var LText;
    var LBytes = 0;
    var LIndex = 0;
    var LCode;

    if (ALine < 1 || ALine > AModel.getLineCount()) {
      return AByteCol;
    }
    LText = AModel.getLineContent(ALine);
    while (LIndex < LText.length && LBytes < AByteCol - 1) {
      LCode = LText.charCodeAt(LIndex);
      if (LCode >= 0xD800 && LCode <= 0xDBFF && LIndex + 1 < LText.length) {
        // A surrogate pair: one code point of 4 UTF-8 bytes, two UTF-16 units
        LBytes += 4;
        LIndex += 2;
      } else {
        LBytes += LCode < 0x80 ? 1 : (LCode < 0x800 ? 2 : 3);
        LIndex += 1;
      }
    }
    return LIndex + 1;
  }

  // A problem's column in AModel's units: a build's (bytes) converted, an
  // LSP's (UTF-16 already) as it is
  function problemColumn(AModel, AItem) {
    return AItem.bytes ? utf16Column(AModel, AItem.line, AItem.col) : AItem.col;
  }

  function feedProblemText(AText) {
    var LLines = (gLineBuf + AText).split('\n');
    var LIndex;
    gLineBuf = LLines.pop();
    for (LIndex = 0; LIndex < LLines.length; LIndex++) {
      parseProblemLine(LLines[LIndex]);
    }
  }

  function markerSeverity(ASev) {
    if (ASev === 'ERROR' || ASev === 'FATAL') {
      return gMonaco.MarkerSeverity.Error;
    }
    if (ASev === 'WARN') {
      return gMonaco.MarkerSeverity.Warning;
    }
    return gMonaco.MarkerSeverity.Hint;
  }

  // Squiggles for one tab from gProblems. Called for every open tab after a
  // build and for each tab opened later, so a file opened after the build
  // still shows its problems.
  function applyMarkers(ATab) {
    var LMarkers = [];
    var LIndex;
    var LItem;

    for (LIndex = 0; LIndex < gProblems.length; LIndex++) {
      LItem = gProblems[LIndex];
      if (samePath(LItem.path, ATab.path)) {
        LMarkers.push({
          severity: markerSeverity(LItem.sev),
          message: LItem.code ? LItem.code + ': ' + LItem.msg : LItem.msg,
          startLineNumber: LItem.line,
          startColumn: problemColumn(ATab.model, LItem),
          endLineNumber: LItem.line,
          // Cover the word at the column; fall back to one character
          endColumn: markerEndColumn(ATab.model, LItem.line, problemColumn(ATab.model, LItem))
        });
      }
    }
    gMonaco.editor.setModelMarkers(ATab.model, ADAM_MARKER_OWNER, LMarkers);
    applyErrorLines(ATab);
  }

  // Delphi-style tint on every ERROR/FATAL line of this tab, plus a mark in
  // the scrollbar ruler. Model decorations, so inactive tabs keep theirs.
  // A tinted line clears when edited (dropEditedErrorLines) or on the next
  // build; the squiggle stays until the next build.
  function applyErrorLines(ATab) {
    var LDecos = [];
    var LSeen = {};
    var LIndex;
    var LItem;
    var LRuler = getComputedStyle(document.documentElement).getPropertyValue('--adam-error').trim();

    for (LIndex = 0; LIndex < gProblems.length; LIndex++) {
      LItem = gProblems[LIndex];
      if ((LItem.sev === 'ERROR' || LItem.sev === 'FATAL') && samePath(LItem.path, ATab.path) &&
          LItem.line >= 1 && LItem.line <= ATab.model.getLineCount() && !LSeen[LItem.line]) {
        // One decoration per line, however many errors share it
        LSeen[LItem.line] = true;
        LDecos.push({
          range: new gMonaco.Range(LItem.line, 1, LItem.line, 1),
          options: {
            isWholeLine: true,
            className: 'adam-error-line',
            stickiness: gMonaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            overviewRuler: { color: LRuler, position: gMonaco.editor.OverviewRulerLane.Right }
          }
        });
      }
    }
    ATab.errorDecos = ATab.model.deltaDecorations(ATab.errorDecos, LDecos);
    rememberErrorLines(ATab);
  }

  // Change events report ranges in PRE-edit line numbers, while decoration
  // ranges are already POST-edit. Each tint's line is recorded after every
  // update, so the next edit is compared against where the line was.
  function rememberErrorLines(ATab) {
    var LIndex;
    var LRange;
    ATab.errorLines = [];
    for (LIndex = 0; LIndex < ATab.errorDecos.length; LIndex++) {
      LRange = ATab.model.getDecorationRange(ATab.errorDecos[LIndex]);
      ATab.errorLines.push(LRange ? LRange.startLineNumber : -1);
    }
  }

  // Content-change listener: an edit touching a tinted line clears its tint
  function dropEditedErrorLines(ATab, AEvent) {
    var LKeep = [];
    var LDrop = [];
    var LIndex;
    var LChange;
    var LLine;
    var LHit;

    if (ATab.errorDecos.length === 0) {
      return;
    }
    for (LIndex = 0; LIndex < ATab.errorDecos.length; LIndex++) {
      LLine = ATab.errorLines[LIndex];
      LHit = LLine < 1;
      for (LChange = 0; !LHit && LChange < AEvent.changes.length; LChange++) {
        LHit = AEvent.changes[LChange].range.startLineNumber <= LLine &&
          AEvent.changes[LChange].range.endLineNumber >= LLine;
      }
      if (LHit) {
        LDrop.push(ATab.errorDecos[LIndex]);
      } else {
        LKeep.push(ATab.errorDecos[LIndex]);
      }
    }
    if (LDrop.length > 0) {
      ATab.model.deltaDecorations(LDrop, []);
      ATab.errorDecos = LKeep;
    }
    // Survivors may have moved (lines inserted/deleted above them)
    rememberErrorLines(ATab);
  }

  function markerEndColumn(AModel, ALine, ACol) {
    var LWord;
    if (ALine < 1 || ALine > AModel.getLineCount()) {
      return ACol + 1;
    }
    LWord = AModel.getWordAtPosition({ lineNumber: ALine, column: ACol });
    if (LWord && LWord.endColumn > ACol) {
      return LWord.endColumn;
    }
    return ACol + 1;
  }

  function countProblems(AList, ASevs) {
    var LCount = 0;
    var LIndex;
    for (LIndex = 0; LIndex < AList.length; LIndex++) {
      if (ASevs.indexOf(AList[LIndex].sev) >= 0) {
        LCount++;
      }
    }
    return LCount;
  }

  // PROBLEMS = build items + LSP items. A build item the LSP also reports
  // (same file, line, column, code) is listed once, as the live LSP item.
  function allProblems() {
    var LLsp = [];
    var LList = [];
    var LUri;
    var LIndex;
    var LOther;
    var LDup;

    for (LUri in gLspProblems) {
      LLsp = LLsp.concat(gLspProblems[LUri]);
    }
    for (LIndex = 0; LIndex < gProblems.length; LIndex++) {
      LDup = false;
      for (LOther = 0; !LDup && LOther < LLsp.length; LOther++) {
        LDup = samePath(LLsp[LOther].path, gProblems[LIndex].path) &&
          LLsp[LOther].line === gProblems[LIndex].line &&
          LLsp[LOther].col === gProblems[LIndex].col &&
          LLsp[LOther].code === gProblems[LIndex].code;
      }
      if (!LDup) {
        LList.push(gProblems[LIndex]);
      }
    }
    return LList.concat(LLsp);
  }

  function publishProblems() {
    var LAll = allProblems();
    var LIndex;
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      applyMarkers(gTabs[LIndex]);
      applyLspMarkers(gTabs[LIndex]);
    }
    AdamShell.setProblems(LAll, jumpToProblem);
    AdamShell.setCounts(countProblems(LAll, ['ERROR', 'FATAL']), countProblems(LAll, ['WARN']));
  }

  function clearProblems() {
    gProblems = [];
    gLineBuf = '';
    publishProblems();
  }

  // LSP documents: only tabs with a path (the server resolves imports from
  // the file's folder). Full sync, didChange debounced per tab.
  var ADAM_LSP_MARKER_OWNER = 'adam-lsp';
  var ADAM_LSP_CHANGE_DELAY = 300;
  // uri -> tab, for every document the server has open
  var gLspOpen = {};
  // uri -> [{ path, line, col, endLine, endCol, sev, code, msg }]
  var gLspProblems = {};

  function lspOpen(ATab, AUri) {
    ATab.lspUri = AUri;
    gLspOpen[AUri] = ATab;
    AdamLsp.notify('textDocument/didOpen', {
      textDocument: {
        uri: AUri,
        languageId: 'adam',
        version: ATab.model.getVersionId(),
        text: ATab.model.getValue()
      }
    });
  }

  function lspClose(AUri) {
    var LTab = gLspOpen[AUri];
    delete gLspOpen[AUri];
    if (LTab && LTab.lspUri === AUri) {
      LTab.lspUri = '';
      clearTimeout(LTab.lspTimer);
      LTab.lspTimer = null;
    }
    delete gLspProblems[AUri];
    AdamLsp.notify('textDocument/didClose', { textDocument: { uri: AUri } });
  }

  // Opens new/renamed tabs, closes documents whose tab is gone or renamed;
  // republishes PROBLEMS when a closed document took problems with it
  function syncLspDocs() {
    var LLive = {};
    var LIndex;
    var LTab;
    var LUri;
    var LDropped = false;

    if (!AdamLsp.isReady()) {
      return;
    }
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      LTab = gTabs[LIndex];
      // Only Pascal sources go to the server (isSourcePath)
      LUri = LTab.path && isSourcePath(LTab.path) ? AdamLsp.pathToUri(LTab.path) : '';
      if (LTab.lspUri !== LUri) {
        // Save As / a reused Untitled: the old document goes first
        if (LTab.lspUri) {
          LDropped = LDropped || !!gLspProblems[LTab.lspUri];
          lspClose(LTab.lspUri);
        }
        if (LUri) {
          lspOpen(LTab, LUri);
        }
      }
      if (LUri) {
        LLive[LUri] = true;
      }
    }
    for (LUri in gLspOpen) {
      if (!LLive[LUri]) {
        LDropped = LDropped || !!gLspProblems[LUri];
        lspClose(LUri);
      }
    }
    if (LDropped) {
      publishProblems();
    }
  }

  function scheduleLspChange(ATab) {
    if (!ATab.lspUri) {
      return;
    }
    clearTimeout(ATab.lspTimer);
    ATab.lspTimer = setTimeout(function () {
      ATab.lspTimer = null;
      sendLspChange(ATab);
    }, ADAM_LSP_CHANGE_DELAY);
  }

  function sendLspChange(ATab) {
    // The tab may have been closed or renamed while waiting
    if (!ATab.lspUri || gLspOpen[ATab.lspUri] !== ATab || ATab.model.isDisposed()) {
      return;
    }
    AdamLsp.notify('textDocument/didChange', {
      textDocument: { uri: ATab.lspUri, version: ATab.model.getVersionId() },
      contentChanges: [{ text: ATab.model.getValue() }]
    });
  }

  // Sends a pending debounced didChange now, so a request that follows
  // (hover, completion, ...) is answered against the text on screen
  function flushLspChange(AModel) {
    var LTab = tabOfModel(AModel);

    if (LTab && LTab.lspTimer) {
      clearTimeout(LTab.lspTimer);
      LTab.lspTimer = null;
      sendLspChange(LTab);
    }
  }

  // Every tab's pending didChange (for a request that belongs to no
  // single document: workspace symbols, call hierarchy)
  function flushAllLspChanges() {
    var LIndex;

    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      flushLspChange(gTabs[LIndex].model);
    }
  }

  function tabOfModel(AModel) {
    var LIndex;

    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      if (gTabs[LIndex].model === AModel) {
        return gTabs[LIndex];
      }
    }
    return null;
  }

  // The LSP document URI of a tab or background model ('' = none: untitled,
  // or a tab the server does not have open yet)
  function lspUriOfModel(AModel) {
    var LTab = tabOfModel(AModel);

    if (LTab) {
      return LTab.lspUri;
    }
    return gBackgroundModels[AModel.uri.toString()] || '';
  }

  function modelOfLspUri(ALspUri) {
    return gMonaco.editor.getModel(gMonaco.Uri.parse(ALspUri));
  }

  // Makes sure every LSP uri in AUris has a model (peek / references into
  // closed files): tabs already do, other files are read from disk into a
  // background model, refreshed from disk on every call
  async function loadModels(AUris) {
    var LIndex;
    var LUri;
    var LModel;
    var LRes;

    for (LIndex = 0; LIndex < AUris.length; LIndex++) {
      LUri = AUris[LIndex];
      LModel = modelOfLspUri(LUri);
      if (LModel && !gBackgroundModels[LModel.uri.toString()]) {
        continue;
      }
      LRes = await window.host.readFile(AdamLsp.uriToPath(LUri));
      if (!LRes.ok) {
        continue;
      }
      // A tab may have opened the file while the read was pending
      LModel = modelOfLspUri(LUri);
      if (LModel && !gBackgroundModels[LModel.uri.toString()]) {
        continue;
      }
      if (LModel) {
        if (LModel.getValue() !== LRes.text) {
          LModel.setValue(LRes.text);
        }
      } else {
        LModel = gMonaco.editor.createModel(LRes.text, 'adam', gMonaco.Uri.parse(LUri));
        gBackgroundModels[LModel.uri.toString()] = LUri;
      }
    }
  }

  // Opens every file in AUris as a tab (rename edits files as dirty tabs,
  // the user saves them), then returns to the tab that was active
  async function openTabs(AUris) {
    var LActive = activeTab();
    var LIndex;
    var LPath;

    for (LIndex = 0; LIndex < AUris.length; LIndex++) {
      LPath = AdamLsp.uriToPath(AUris[LIndex]);
      if (findTab(LPath) < 0) {
        await openPath(LPath);
      }
    }
    LIndex = gTabs.indexOf(LActive);
    if (LIndex >= 0) {
      activateTab(LIndex);
    }
  }

  // Editor opener: a definition / reference in another file opens (or
  // shows) its tab and reveals the target
  async function openAt(ALspUri, ASelection) {
    var LPath = AdamLsp.uriToPath(ALspUri);
    var LSel = ASelection;

    await openPath(LPath);
    if (findTab(LPath) !== gActive || !LSel) {
      return;
    }
    if (LSel.startLineNumber === undefined) {
      LSel = new gMonaco.Range(LSel.lineNumber, LSel.column, LSel.lineNumber, LSel.column);
    }
    gEditor.setSelection(LSel);
    gEditor.revealRangeInCenterIfOutsideViewport(LSel);
    gEditor.focus();
  }

  // Monaco resource -> LSP uri of the file it shows ('' = untitled / none).
  // Providers load a model for every target before returning it, so the
  // opener always finds one.
  function lspUriOfResource(AResource) {
    var LModel = gMonaco.editor.getModel(AResource);
    var LTab;

    if (!LModel) {
      return '';
    }
    LTab = tabOfModel(LModel);
    if (LTab) {
      return LTab.path && isSourcePath(LTab.path) ? AdamLsp.pathToUri(LTab.path) : '';
    }
    return gBackgroundModels[LModel.uri.toString()] || '';
  }

  function lspSeverity(ASeverity) {
    if (ASeverity === 1) {
      return 'ERROR';
    }
    if (ASeverity === 2) {
      return 'WARN';
    }
    return 'HINT';
  }

  // window/showMessage (a formatting refusal, say): the output panel, the
  // editor's own message area
  function onLspShowMessage(AType, AMessage) {
    AdamShell.showPanel('output');
    AdamShell.outputLine('LSP: ' + AMessage);
  }

  // Format on save (settings.json format.formatOnSave): a Pascal model is
  // formatted before its text is written
  async function formatBeforeSave(ATab) {
    if (gFormat && gFormat.formatOnSave && ATab.model.getLanguageId() === 'adam') {
      await AdamProviders.formatModel(ATab.model);
    }
  }

  function onLspDiagnostics(AUri, ADiagnostics) {
    var LTab = gLspOpen[AUri];
    var LList = [];
    var LIndex;
    var LDiag;

    // Late diagnostics for a document already closed
    if (!LTab) {
      if (gLspProblems[AUri]) {
        delete gLspProblems[AUri];
        publishProblems();
      }
      return;
    }
    for (LIndex = 0; LIndex < ADiagnostics.length; LIndex++) {
      LDiag = ADiagnostics[LIndex];
      // LSP is 0-based with an exclusive end; Monaco and PROBLEMS are 1-based
      LList.push({
        path: LTab.path,
        line: LDiag.range.start.line + 1,
        col: LDiag.range.start.character + 1,
        endLine: LDiag.range.end.line + 1,
        endCol: LDiag.range.end.character + 1,
        sev: lspSeverity(LDiag.severity),
        code: LDiag.code !== undefined ? String(LDiag.code) : '',
        msg: LDiag.message
      });
    }
    gLspProblems[AUri] = LList;
    publishProblems();
  }

  // Squiggles from the server, exact ranges, owner separate from the build
  function applyLspMarkers(ATab) {
    var LList = ATab.lspUri ? (gLspProblems[ATab.lspUri] || []) : [];
    var LMarkers = [];
    var LIndex;
    var LItem;
    var LEndCol;

    for (LIndex = 0; LIndex < LList.length; LIndex++) {
      LItem = LList[LIndex];
      LEndCol = LItem.endCol;
      // An empty range would draw nothing: widen it to the word
      if (LItem.endLine === LItem.line && LEndCol <= LItem.col) {
        LEndCol = markerEndColumn(ATab.model, LItem.line, LItem.col);
      }
      LMarkers.push({
        severity: markerSeverity(LItem.sev),
        message: LItem.code ? LItem.code + ': ' + LItem.msg : LItem.msg,
        startLineNumber: LItem.line,
        startColumn: LItem.col,
        endLineNumber: LItem.endLine,
        endColumn: LEndCol
      });
    }
    gMonaco.editor.setModelMarkers(ATab.model, ADAM_LSP_MARKER_OWNER, LMarkers);
  }

  // A (re)started server knows no documents: open every tab again, then
  // (re)register the providers from its capabilities - registering makes
  // Monaco ask again (semantic tokens, folding), so documents come first
  function onLspReady(ACaps) {
    var LIndex;
    gLspOpen = {};
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      gTabs[LIndex].lspUri = '';
    }
    syncLspDocs();
    AdamProviders.install(ACaps);
  }

  // Server gone: its documents and diagnostics are gone with it
  function onLspDown() {
    var LIndex;
    for (LIndex = 0; LIndex < gTabs.length; LIndex++) {
      clearTimeout(gTabs[LIndex].lspTimer);
      gTabs[LIndex].lspTimer = null;
      gTabs[LIndex].lspUri = '';
    }
    gLspOpen = {};
    gLspProblems = {};
    publishProblems();
  }

  // Open (or show) the problem's file and put the cursor on it
  async function jumpToProblem(AItem) {
    var LTab;
    await openPath(AItem.path);
    LTab = activeTab();
    if (!LTab || !samePath(LTab.path, AItem.path)) {
      return;
    }
    gEditor.setPosition({ lineNumber: AItem.line, column: problemColumn(LTab.model, AItem) });
    gEditor.revealPositionInCenter({ lineNumber: AItem.line, column: problemColumn(LTab.model, AItem) });
    gEditor.focus();
  }

  function firstError() {
    var LIndex;
    for (LIndex = 0; LIndex < gProblems.length; LIndex++) {
      if (gProblems[LIndex].sev === 'ERROR' || gProblems[LIndex].sev === 'FATAL') {
        return gProblems[LIndex];
      }
    }
    return null;
  }

  async function doBuild() {
    var LTab;
    var LRes;

    if (gBuildActive) {
      return;
    }
    // A debug or run session builds into the same output folder (main.js
    // refuses too); refused here before the session's output is cleared
    if (AdamDebug.isActive()) {
      AdamShell.outputLine('Build: a debug or run session is active: stop it first (Shift+F5).');
      return;
    }
    // Claimed before any await, so a second Build during the saves is a no-op
    gBuildActive = true;
    try {
      LRes = await saveForBuild('Build');
    } catch (AError) {
      AdamShell.outputLine('Build: save failed: ' + AError.message);
      LRes = false;
    }
    if (!LRes) {
      gBuildActive = false;
      return;
    }
    LTab = activeTab();
    AdamShell.clearOutput();
    clearProblems();
    AdamShell.showPanel('output');
    // Busy BEFORE the request: output and even build:exit (instant failure)
    // can arrive ahead of the invoke reply
    AdamShell.setBusy(true);
    AdamShell.setBuildState('building');
    LRes = await window.host.buildStart({
      file: LTab.path,
      mode: AdamShell.getBuildMode(),
      target: AdamShell.getTarget()
    });
    if (!LRes.ok) {
      buildRefused(LRes.error);
    }
  }

  // main.js refused to start a build / pack: nothing was spawned, so no
  // build:exit will follow
  function buildRefused(AError) {
    gBuildActive = false;
    AdamShell.setBusy(false);
    AdamShell.outputLine(AError);
    AdamShell.setBuildState('failed');
  }

  function doStop() {
    if (gBuildActive) {
      window.host.buildStop();
    }
  }

  // Build > Pack (Ctrl+Alt+B): adam pack on the active file's project
  // (main.js finds it and refuses a file outside one), shown as a build
  // is: OUTPUT, the build state, build:exit. Nothing is saved first: pack
  // reads assets\, never the open sources
  async function doPack() {
    var LTab = activeTab();
    var LRes;

    if (gBuildActive) {
      return;
    }
    if (AdamDebug.isActive()) {
      AdamShell.outputLine('Pack: a debug session is active: stop it first (Shift+F5).');
      return;
    }
    if (!LTab || !LTab.path) {
      AdamShell.showPanel('output');
      AdamShell.outputLine('Pack: the active file is not in a project.');
      return;
    }
    gBuildActive = true;
    AdamShell.clearOutput();
    clearProblems();
    AdamShell.showPanel('output');
    AdamShell.setBusy(true);
    AdamShell.setBuildState('packing');
    LRes = await window.host.buildStart({ file: LTab.path, pack: true });
    if (!LRes.ok) {
      buildRefused(LRes.error);
    }
  }

  // File > New Project: the dialog (src/newproject.js) takes the name, the
  // type and the folder, and main.js runs adam init; a failure stays in
  // the dialog. Made: the project folder opens in the explorer, its main
  // module in a tab (which reveals it in the tree), adam's lines in OUTPUT
  function doNewProject() {
    AdamNewProject.open(onProjectCreated, function () {
      gEditor.focus();
    });
  }

  async function onProjectCreated(ARes) {
    AdamExplorer.setFolders(ARes.folders);
    AdamShell.clearOutput();
    AdamShell.showPanel('output');
    if (ARes.output) {
      AdamShell.output(ARes.output);
    }
    // The starter module adam init wrote (main.js asked adam for it)
    if (ARes.main) {
      await openPath(ARes.main);
    } else {
      AdamShell.outputLine('New Project: ' + ARes.root + ' made, but adam named no main module.');
    }
  }

  function onBuildOutput(AText) {
    AdamShell.output(AText);
    feedProblemText(AText);
  }

  // The TERMINAL tab's keys and size: the debug or run session's program
  // (it ignores them without one)
  function onTerminalInput(AText) {
    AdamDebug.terminalInput(AText);
  }

  function onTerminalResize(ACols, ARows) {
    AdamDebug.terminalResize(ACols, ARows);
  }

  function showLspState(AState) {
    if (AState.detail) {
      AdamShell.setLspState(AState.state + ' (' + AState.detail + ')');
    } else {
      AdamShell.setLspState(AState.state);
    }
  }

  // The compiler's output has ended (a build, a debug session's build): a
  // last line without a trailing newline is still a line; then the markers
  function finishProblemText() {
    if (gLineBuf.length > 0) {
      parseProblemLine(gLineBuf);
      gLineBuf = '';
    }
    publishProblems();
  }

  // A build (Build, Run or a debug session's) writes files other open
  // documents' directives name (a dll's output, a library, an @outputpath
  // folder): the server checks every open buffer again, so its reports follow
  // the disk (a stale SM0105 / SM0106 after the dll was built)
  function notifyDiskChanged() {
    if (AdamLsp.isReady()) {
      AdamLsp.notify('workspace/didChangeWatchedFiles', { changes: [] });
    }
  }

  // The debugger's build ended: its problem text, then the disk refresh
  function finishDebugBuild() {
    finishProblemText();
    notifyDiskChanged();
  }

  function onBuildExit(AInfo) {
    var LState;
    var LError;

    gBuildActive = false;
    AdamShell.setBusy(false);
    finishProblemText();
    if (AInfo.stopped) {
      LState = 'stopped';
    } else if (AInfo.code === 0) {
      LState = 'ok';
    } else {
      LState = 'failed (exit ' + AInfo.code + ')';
    }
    AdamShell.setBuildState(LState);
    AdamShell.outputLine('[' + LState + ']');
    notifyDiskChanged();
    // A failed build takes you to its first error
    LError = firstError();
    if (!AInfo.stopped && AInfo.code !== 0 && LError) {
      jumpToProblem(LError);
    }
  }

  // Ctrl+T: pick a top-level symbol of the open documents (and the units
  // they import) and jump to it
  function doGotoSymbol() {
    AdamQuickPick.open({
      placeholder: 'Go to symbol in workspace',
      source: gotoSymbolSource,
      onPick: function (AEntry) {
        openAt(AEntry.uri, AEntry.range);
      },
      onClose: function () {
        gEditor.focus();
      }
    });
  }

  // Quick pick source: { entries } or { message }
  async function gotoSymbolSource(AQuery) {
    var LCaps = AdamLsp.capabilities();
    var LSymbols;
    var LEntries = [];
    var LIndex;

    if (!AdamLsp.isReady() || !LCaps || !LCaps.workspaceSymbolProvider) {
      return { message: 'Language server not ready' };
    }
    LSymbols = await AdamProviders.workspaceSymbols(AQuery);
    for (LIndex = 0; LIndex < LSymbols.length; LIndex++) {
      LEntries.push({
        label: LSymbols[LIndex].name,
        description: LSymbols[LIndex].container,
        uri: LSymbols[LIndex].uri,
        range: LSymbols[LIndex].range
      });
    }
    if (LEntries.length === 0) {
      return { message: AQuery ? 'No matching symbols' : 'No symbols in the open documents' };
    }
    return { entries: AdamQuickPick.rank(LEntries, AQuery) };
  }

  // Shift+Alt+H: call hierarchy of the routine at the cursor, in the panel
  async function doCallHierarchy() {
    var LTab = activeTab();
    var LCaps = AdamLsp.capabilities();
    var LNode;

    AdamShell.showPanel('calls');
    if (!AdamLsp.isReady() || !LCaps || !LCaps.callHierarchyProvider) {
      AdamCallTree.showMessage('Language server not ready');
      return;
    }
    if (!LTab || !lspUriOfModel(LTab.model)) {
      AdamCallTree.showMessage('The language server has no data for this tab');
      return;
    }
    LNode = await AdamProviders.prepareCallHierarchy(LTab.model, gEditor.getPosition());
    if (!LNode) {
      AdamCallTree.showMessage('No routine at the cursor');
      return;
    }
    AdamCallTree.show(LNode);
  }

  function runAction(AId) {
    var LAction = gEditor.getAction(AId);
    if (LAction) {
      LAction.run();
    }
  }

  // Format settings from main (settings.json 'format' section); null until boot
  var gFormat = null;

  // Indent settings are Monaco MODEL options: every Pascal model follows them
  function applyModelIndent(AModel) {
    if (gFormat && AModel.getLanguageId() === 'adam') {
      AModel.updateOptions({ tabSize: gFormat.indentSize, insertSpaces: !gFormat.useTabs });
    }
  }

  function applySettings(ASettings) {
    gFormat = ASettings && ASettings.format ? ASettings.format : null;
    gMonaco.editor.getModels().forEach(applyModelIndent);
  }

  // The format settings as LSP FormattingOptions keys (lsp-providers.js adds
  // tabSize / insertSpaces from the model)
  function formatOptions() {
    if (!gFormat) {
      return {};
    }
    return {
      trimTrailingWhitespace: gFormat.trimTrailingWhitespace,
      insertFinalNewline: gFormat.finalNewline,
      'adam.spaceAroundAssign': gFormat.spaceAroundAssign,
      'adam.spaceAroundOperators': gFormat.spaceAroundOperators,
      'adam.spaceAfterComma': gFormat.spaceAfterComma,
      'adam.spaceBeforeColon': gFormat.spaceBeforeColon,
      'adam.spaceAfterColon': gFormat.spaceAfterColon,
      'adam.maxBlankLines': gFormat.maxBlankLines,
      'adam.maxLineLength': gFormat.maxLineLength
    };
  }

  // Help > About: the box restores editor focus when it closes
  function doAbout() {
    AdamAbout.open(function () {
      gEditor.focus();
    });
  }

  function onMenu(ACommand) {
    if (ACommand === 'new') {
      addTab(null, '');
    } else if (ACommand === 'open') {
      doOpen();
    } else if (ACommand === 'openFolder') {
      doOpenFolder();
    } else if (ACommand === 'newProject') {
      doNewProject();
    } else if (ACommand === 'closeAllFolders') {
      doCloseAllFolders();
    } else if (ACommand === 'toggleExamples') {
      doShowExamples(null);
    } else if (ACommand === 'save') {
      doSave();
    } else if (ACommand === 'saveAs') {
      doSaveAs();
    } else if (ACommand === 'saveAll') {
      doSaveAll();
    } else if (ACommand === 'rename') {
      doRename();
    } else if (ACommand === 'find') {
      runAction('actions.find');
    } else if (ACommand === 'replace') {
      runAction('editor.action.startFindReplaceAction');
    } else if (ACommand === 'formatDocument') {
      runAction('editor.action.formatDocument');
    } else if (ACommand === 'build') {
      doBuild();
    } else if (ACommand === 'run') {
      // Run = a DAP session with noDebug (debug.js), its terminal the TERMINAL tab
      AdamDebug.command('run');
    } else if (ACommand === 'pack') {
      doPack();
    } else if (ACommand === 'stop') {
      // One Stop: the debug or run session's, else the build's
      if (AdamDebug.isActive()) {
        AdamDebug.command('debugStop');
      } else {
        doStop();
      }
    } else if (AdamDebug.command(ACommand)) {
      // debugStart / debugStepOver / debugStepIn / debugStepOut / debugPause / debugStop
      return;
    } else if (ACommand === 'gotoSymbol') {
      doGotoSymbol();
    } else if (ACommand === 'callHierarchy') {
      doCallHierarchy();
    } else if (ACommand === 'about') {
      doAbout();
    } else if (ACommand === 'reportIssue') {
      // Toolbar button: the reporter with no code (main owns the window)
      window.host.reportIssue('');
    }
  }

  // App shortcuts, bound on the editor as well as on the application menu
  // (main.js buildMenu - keep the two in step). While Monaco has focus it
  // may own a chord (Ctrl+B) and swallow it before the menu accelerator
  // sees it; binding here runs the command and consumes the key, so the
  // menu never double-fires. Outside the editor the menu handles it.
  var ADAM_APP_KEYS = [
    { cmd: 'new', ctrl: true, shift: false, key: 'KeyN' },
    { cmd: 'open', ctrl: true, shift: false, key: 'KeyO' },
    { cmd: 'save', ctrl: true, shift: false, key: 'KeyS' },
    { cmd: 'saveAs', ctrl: true, shift: true, key: 'KeyS' },
    { cmd: 'build', ctrl: true, shift: false, key: 'KeyB' },
    // F5 is the debugger's (W2); run without debugging = Ctrl+F5 (VS / VS Code)
    { cmd: 'run', ctrl: true, shift: false, key: 'F5' },
    { cmd: 'stop', ctrl: false, shift: true, key: 'F5' },
    // Pack: only a project's; main.js refuses outside one (the menu item
    // is disabled there, a key binding cannot be)
    { cmd: 'pack', ctrl: true, shift: false, alt: true, key: 'KeyB' },
    { cmd: 'debugStart', ctrl: false, shift: false, key: 'F5' },
    { cmd: 'debugStepOver', ctrl: false, shift: false, key: 'F10' },
    { cmd: 'debugStepIn', ctrl: false, shift: false, key: 'F11' },
    { cmd: 'debugStepOut', ctrl: false, shift: true, key: 'F11' },
    { cmd: 'debugPause', ctrl: false, shift: false, key: 'F6' },
    { cmd: 'gotoSymbol', ctrl: true, shift: false, key: 'KeyT' },
    // alt is optional: absent = false
    { cmd: 'callHierarchy', ctrl: false, shift: true, alt: true, key: 'KeyH' }
  ];

  function registerAppKeys() {
    var LIndex;
    for (LIndex = 0; LIndex < ADAM_APP_KEYS.length; LIndex++) {
      registerAppKey(ADAM_APP_KEYS[LIndex]);
    }
  }

  function registerAppKey(AEntry) {
    var LBinding = gMonaco.KeyCode[AEntry.key];
    if (AEntry.ctrl) {
      LBinding = LBinding | gMonaco.KeyMod.CtrlCmd;
    }
    if (AEntry.shift) {
      LBinding = LBinding | gMonaco.KeyMod.Shift;
    }
    if (AEntry.alt) {
      LBinding = LBinding | gMonaco.KeyMod.Alt;
    }
    gEditor.addCommand(LBinding, function () {
      onMenu(AEntry.cmd);
    });
  }

  async function start(AMonaco) {
    var LInitial;
    var LExplorerReady;

    gMonaco = AMonaco;
    // model: null - every document model comes from addTab
    gEditor = gMonaco.editor.create(document.getElementById('editor'), {
      model: null,
      theme: 'adam-dark',
      automaticLayout: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 14,
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      minimap: { enabled: true },
      // VS Code sizes; no shadow line under the scrolled top
      scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 10, useShadows: false },
      // LSP semantic tokens recolour Monarch's instant colouring (theme
      // rules in adam-lang.js); parameter-name inlay hints on
      'semanticHighlighting.enabled': true,
      inlayHints: { enabled: 'on' },
      // Completion is the server's alone: Monaco's words scraped from the
      // file (comments included) would fill the list where the server says
      // nothing fits (inside a string, a C/C++ name)
      wordBasedSuggestions: 'off'
    });

    // Definition / references / peek into another file: open its tab
    gMonaco.editor.registerEditorOpener({
      openCodeEditor: function (ASource, AResource, ASelection) {
        var LUri = lspUriOfResource(AResource);

        if (!LUri) {
          return false;
        }
        return openAt(LUri, ASelection).then(function () {
          return true;
        });
      }
    });

    gEditor.onDidChangeCursorPosition(function (AEvent) {
      AdamShell.setCursor(AEvent.position.lineNumber, AEvent.position.column);
    });
    // Toolbar buttons and the (hidden) application menu share one handler
    AdamShell.init(onMenu);
    // Saved layout + build mode / target (state.json), before any tab opens
    AdamShell.applyUiState(await window.host.getUiState());
    registerAppKeys();
    window.host.onMenu(onMenu);
    window.host.onBuildOutput(onBuildOutput);
    window.host.onBuildExit(onBuildExit);
    // The highlighter's words: Adam's keywords and types, packed into
    // package.json by adam --dev-editor (main.js app:info)
    AdamLang.setWords((await window.host.appInfo()).words);
    // Subscribe first, then ask: no state change can fall between the two
    window.host.onLspState(showLspState);
    window.host.lspState().then(showLspState);
    // Settings: subscribe first, then ask; models created later get the indent too
    gMonaco.editor.onDidCreateModel(applyModelIndent);
    window.host.onSettingsChanged(applySettings);
    window.host.onSettingsOpen(openPath);
    // files a second launch (editor.exe <files>) hands over, each in a tab
    window.host.onOpenFiles(openPaths);
    // an open tab's file changed on disk (main.js watches the tabs' files)
    window.host.onFileChanged(onDiskChanges);
    applySettings(await window.host.getSettings());
    // Providers register on onLspReady; tabs and models stay in this unit
    AdamProviders.init(gMonaco, {
      lspUriOf: lspUriOfModel,
      flush: flushLspChange,
      loadModels: loadModels,
      flushAll: flushAllLspChanges,
      openTabs: openTabs,
      formatOptions: formatOptions,
      modelUri: function (ALspUri) {
        return gMonaco.Uri.parse(ALspUri);
      }
    });
    // CALL HIERARCHY tab: data from the LSP, jumps through the opener
    AdamCallTree.init(AdamProviders.callChildren, openAt);
    AdamLsp.init({
      onReady: onLspReady,
      onDown: onLspDown,
      onDiagnostics: onLspDiagnostics,
      onShowMessage: onLspShowMessage
    });
    // The program's terminal (TERMINAL tab): the debug or run session's
    // program gets its keys and size
    AdamTerminal.init({
      onInput: onTerminalInput,
      onResize: onTerminalResize
    });
    // Debugger UI: breakpoints in the glyph margin of every file model
    // (debug.js subscribes to model creation itself) and the session
    AdamDebug.init(gMonaco, gEditor, {
      pathOfModel: function (AModel) {
        var LTab = tabOfModel(AModel);
        return (LTab && LTab.path) || '';
      },
      isSourcePath: isSourcePath,
      activeTab: activeTab,
      openPath: openPath,
      saveForBuild: function () { return saveForBuild(AdamDebug.isRun() ? 'Run' : 'Debug'); },
      output: onBuildOutput,
      outputLine: AdamShell.outputLine,
      clearOutput: AdamShell.clearOutput,
      clearProblems: clearProblems,
      finishProblems: finishDebugBuild,
      showPanel: AdamShell.showPanel,
      setStatus: AdamShell.setBuildState,
      setDebugState: AdamShell.setDebugState,
      buildBusy: function () { return gBuildActive; },
      getTarget: AdamShell.getTarget,
      getBuildMode: AdamShell.getBuildMode,
      // A dll source's host exe: main remembers and picks it (W4)
      debugHostFor: window.host.dapHostFor,
      pickDebugHost: window.host.dapPickHost,
      forgetDebugHost: window.host.dapForgetHost,
      debugProgramFor: window.host.projectDebugProgram,
      terminalWrite: AdamTerminal.write,
      terminalReset: AdamTerminal.reset,
      terminalSize: AdamTerminal.size
    });
    // Nothing is running at start: only Stop is disabled
    AdamShell.setBusy(false);
    // Runs alongside the tab restore; awaited before startup ends
    LExplorerReady = AdamExplorer.init(openPath, doOpenFolder, doCloseFolder, function () {
      doShowExamples(false);
    });

    addTab(null, '');
    await restoreSession();
    // Restored tabs leave the explorer as it was left; from here a newly
    // active tab (the command-line file included) is revealed
    await LExplorerReady;
    AdamExplorer.endRestore();
    // every command-line file opens; the last one is active
    LInitial = await window.host.initialFiles();
    LInitial.forEach(function (AFile) {
      openDocument(AFile.path, AFile.text);
    });
    gSessionReady = true;
    syncSession();
  }

  // Reopens the previous session's file tabs and its active tab. A file
  // that fails to read is skipped silently: it vanished or is locked.
  async function restoreSession() {
    var LSession = await window.host.loadSession();
    var LIndex;
    var LRes;

    for (LIndex = 0; LIndex < LSession.files.length; LIndex++) {
      LRes = await window.host.readFile(LSession.files[LIndex]);
      if (LRes.ok) {
        openDocument(LRes.path, LRes.text);
      }
    }
    LIndex = findTab(LSession.active);
    if (LIndex >= 0) {
      activateTab(LIndex);
    }
  }

  return { start: start };
})();
