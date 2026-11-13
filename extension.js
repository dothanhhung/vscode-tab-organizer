// Tab Organizer — sort tabs by date created, colour them into groups,
// open each group in its own window.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const STATE_KEY = 'tabOrganizer.state';

const COLORS = [
  { id: 'red', label: 'Red', emoji: '🔴' },
  { id: 'orange', label: 'Orange', emoji: '🟠' },
  { id: 'yellow', label: 'Yellow', emoji: '🟡' },
  { id: 'green', label: 'Green', emoji: '🟢' },
  { id: 'teal', label: 'Teal', emoji: '🩵' },
  { id: 'blue', label: 'Blue', emoji: '🔵' },
  { id: 'purple', label: 'Purple', emoji: '🟣' },
  { id: 'pink', label: 'Pink', emoji: '🩷' },
  { id: 'gray', label: 'Gray', emoji: '⚪' },
];
const colorInfo = (id) => COLORS.find((c) => c.id === id) || COLORS[COLORS.length - 1];
const themeColor = (id) => new vscode.ThemeColor('tabOrganizer.' + colorInfo(id).id);

/** @type {vscode.ExtensionContext} */
let ctx;
/** { groups: [{id,name,color}], files: {uri: groupId}, opened: {uri: ms} } */
let state;
let busy = false; // true while we move tabs ourselves
let saveTimer, refreshTimer, autoSortTimer;

const decoEmitter = new vscode.EventEmitter();
const treeEmitter = new vscode.EventEmitter();

// ---------- state ----------

function loadState() {
  const s = ctx.workspaceState.get(STATE_KEY) || {};
  state = {
    groups: Array.isArray(s.groups) ? s.groups : [],
    files: s.files && typeof s.files === 'object' ? s.files : {},
    opened: s.opened && typeof s.opened === 'object' ? s.opened : {},
  };
  // drop assignments that point at a deleted group
  const ids = new Set(state.groups.map((g) => g.id));
  for (const k of Object.keys(state.files)) if (!ids.has(state.files[k])) delete state.files[k];
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ctx.workspaceState.update(STATE_KEY, state), 300);
}

function changed() {
  save();
  decoEmitter.fire(undefined);
  refreshTree();
}

function refreshTree() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => treeEmitter.fire(undefined), 100);
}

const groupById = (id) => state.groups.find((g) => g.id === id);
const groupOf = (uri) => groupById(state.files[uri.toString()]);
const filesOf = (group) =>
  Object.keys(state.files)
    .filter((k) => state.files[k] === group.id)
    .map((k) => vscode.Uri.parse(k));

// ---------- tabs ----------

function tabUri(tab) {
  const i = tab && tab.input;
  if (!i) return undefined;
  if (i instanceof vscode.TabInputText || i instanceof vscode.TabInputCustom || i instanceof vscode.TabInputNotebook) return i.uri;
  return undefined;
}

function allTabs() {
  const out = [];
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) out.push(t);
  return out;
}

function tabsFor(uriStrSet) {
  return allTabs().filter((t) => {
    const u = tabUri(t);
    return u && uriStrSet.has(u.toString());
  });
}

const isOpen = (uri) => tabsFor(new Set([uri.toString()])).length > 0;

function openUri(uri, viewColumn) {
  return vscode.commands.executeCommand('vscode.open', uri, { viewColumn, preview: false, preserveFocus: false });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

/** Turn whatever a command was called with into a list of Uris. */
function resolveUris(arg, arg2) {
  if (Array.isArray(arg2) && arg2.length && arg2[0] instanceof vscode.Uri) return arg2;
  if (arg instanceof vscode.Uri) return [arg];
  if (arg && arg.kind === 'file') return [arg.uri];
  const u = tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
  return u ? [u] : [];
}

function resolveGroup(arg) {
  if (arg && arg.kind === 'group') return groupById(arg.group.id);
  return undefined;
}

async function pickGroup(placeHolder) {
  if (!state.groups.length) {
    vscode.window.showInformationMessage('Tab Organizer: no groups yet. Right-click a tab → "Add to Group / Colour…".');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    state.groups.map((g) => ({ label: `${colorInfo(g.color).emoji} ${g.name}`, description: `${filesOf(g).length} files`, g })),
    { placeHolder }
  );
  return pick && pick.g;
}

// ---------- sorting ----------

const SORT_KEYS = [
  { id: 'created', label: '$(calendar) Date created', desc: 'file creation time' },
  { id: 'modified', label: '$(history) Date modified', desc: 'last saved on disk' },
  { id: 'opened', label: '$(eye) Date opened', desc: 'when the tab was opened here' },
  { id: 'name', label: '$(symbol-text) Name', desc: 'file name A–Z' },
  { id: 'group', label: '$(symbol-color) Group', desc: 'by group, then date created' },
];

async function fileTimes(uri) {
  try {
    if (uri.scheme === 'file') {
      const st = await fs.promises.stat(uri.fsPath);
      return { created: st.birthtimeMs || st.ctimeMs, modified: st.mtimeMs };
    }
    const st = await vscode.workspace.fs.stat(uri);
    return { created: st.ctime, modified: st.mtime };
  } catch {
    return { created: NaN, modified: NaN }; // untitled / missing → end of the row
  }
}

async function sortValue(uri, key) {
  const k = uri.toString();
  if (key === 'name') return [path.basename(uri.path).toLowerCase()];
  if (key === 'opened') return [state.opened[k] ?? NaN];
  const t = await fileTimes(uri);
  if (key === 'modified') return [t.modified];
  if (key === 'group') {
    const idx = state.groups.findIndex((g) => g.id === state.files[k]);
    return [idx < 0 ? Infinity : idx, t.created];
  }
  return [t.created];
}

function cmpOne(a, b, desc) {
  const aBad = typeof a === 'number' && Number.isNaN(a);
  const bBad = typeof b === 'number' && Number.isNaN(b);
  if (aBad || bBad) return aBad === bBad ? 0 : aBad ? 1 : -1; // unknown always last
  if (a === b) return 0;
  const r = typeof a === 'string' ? a.localeCompare(b) : a < b ? -1 : 1;
  return desc ? -r : r;
}

async function sortTabGroup(tg, key, desc) {
  const pinned = tg.tabs.filter((t) => t.isPinned).length;
  const entries = [];
  tg.tabs.forEach((t, i) => {
    const uri = tabUri(t);
    if (uri && !t.isPinned) entries.push({ uri, i });
  });
  if (entries.length < 2) return;
  for (const e of entries) e.v = await sortValue(e.uri, key);
  const sorted = [...entries].sort((a, b) => {
    for (let j = 0; j < a.v.length; j++) {
      // group index is always ascending; only the date part follows the direction
      const c = cmpOne(a.v[j], b.v[j], key === 'group' && j === 0 ? false : desc);
      if (c) return c;
    }
    return a.i - b.i;
  });
  const already = sorted.every((e, i) => e.i === pinned + i);
  if (already) return;
  for (let i = 0; i < sorted.length; i++) {
    await openUri(sorted[i].uri, tg.viewColumn);
    await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: pinned + i + 1 });
  }
}

async function sortAll(key, desc) {
  if (busy) return;
  busy = true;
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const activeUri = tabUri(activeGroup.activeTab);
  const activeCol = activeGroup.viewColumn;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Sorting tabs…' }, async () => {
      for (const tg of [...vscode.window.tabGroups.all]) await sortTabGroup(tg, key, desc);
    });
    if (activeUri) await openUri(activeUri, activeCol);
  } catch (err) {
    vscode.window.showErrorMessage('Tab Organizer: sort failed — ' + (err && err.message ? err.message : err));
  } finally {
    busy = false;
  }
}

const configDesc = () => vscode.workspace.getConfiguration('tabOrganizer').get('sortDirection') === 'descending';

async function cmdSortTabs() {
  const key = await vscode.window.showQuickPick(
    SORT_KEYS.map((k) => ({ label: k.label, description: k.desc, id: k.id })),
    { placeHolder: 'Sort every tab row by…' }
  );
  if (!key) return;
  const isName = key.id === 'name';
  const dir = await vscode.window.showQuickPick(
    [
      { label: isName ? 'A → Z' : 'Oldest first', desc: false },
      { label: isName ? 'Z → A' : 'Newest first', desc: true },
    ],
    { placeHolder: 'Direction' }
  );
  if (!dir) return;
  await sortAll(key.id, dir.desc);
}

// ---------- groups ----------

async function pickColor(placeHolder = 'Colour') {
  const p = await vscode.window.showQuickPick(
    COLORS.map((c) => ({ label: `${c.emoji} ${c.label}`, id: c.id })),
    { placeHolder }
  );
  return p && p.id;
}

async function createGroup(name, color) {
  if (!name) {
    name = await vscode.window.showInputBox({ prompt: 'Group name', placeHolder: 'e.g. Server, Reading tests, Review' });
    if (!name || !name.trim()) return undefined;
    name = name.trim();
  }
  if (!color) {
    color = await pickColor(`Colour for "${name}"`);
    if (!color) return undefined;
  }
  const g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color };
  state.groups.push(g);
  changed();
  return g;
}

function assign(uris, group) {
  for (const u of uris) state.files[u.toString()] = group.id;
  changed();
}

async function cmdAssignGroup(arg, arg2) {
  const uris = resolveUris(arg, arg2);
  if (!uris.length) {
    vscode.window.showInformationMessage('Tab Organizer: this tab has no file to group.');
    return;
  }
  const items = state.groups.map((g) => ({
    label: `${colorInfo(g.color).emoji} ${g.name}`,
    description: `${filesOf(g).length} files`,
    g,
  }));
  items.push({ label: '$(add) New group…', newGroup: true });
  const usedNames = new Set(state.groups.map((g) => g.name.toLowerCase()));
  const quick = COLORS.filter((c) => !usedNames.has(c.label.toLowerCase()));
  if (quick.length) {
    items.push({ label: 'Just a colour', kind: vscode.QuickPickItemKind.Separator });
    for (const c of quick) items.push({ label: `${c.emoji} ${c.label}`, color: c });
  }
  const what = uris.length === 1 ? path.basename(uris[0].path) : `${uris.length} files`;
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Group / colour for ${what}` });
  if (!pick) return;
  let g = pick.g;
  if (pick.newGroup) g = await createGroup();
  if (pick.color) g = await createGroup(pick.color.label, pick.color.id);
  if (g) assign(uris, g);
}

function cmdRemoveFromGroup(arg, arg2) {
  const uris = resolveUris(arg, arg2);
  for (const u of uris) delete state.files[u.toString()];
  changed();
}

async function cmdRenameGroup(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Rename which group?'));
  if (!g) return;
  const name = await vscode.window.showInputBox({ prompt: 'New name', value: g.name });
  if (!name || !name.trim()) return;
  g.name = name.trim();
  changed();
}

async function cmdSetGroupColor(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Change the colour of which group?'));
  if (!g) return;
  const c = await pickColor(`Colour for "${g.name}"`);
  if (!c) return;
  g.color = c;
  changed();
}

async function cmdDeleteGroup(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Delete which group? (files and tabs are kept)'));
  if (!g) return;
  state.groups = state.groups.filter((x) => x.id !== g.id);
  for (const k of Object.keys(state.files)) if (state.files[k] === g.id) delete state.files[k];
  changed();
}

async function cmdCloseGroup(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Close the tabs of which group?'));
  if (!g) return;
  const tabs = tabsFor(new Set(filesOf(g).map((u) => u.toString())));
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

/** Close copies of these files that sit outside `keep` (the group we just filled). */
async function closeOutside(uris, keep) {
  const set = new Set(uris.map((u) => u.toString()));
  const extra = [];
  for (const tg of vscode.window.tabGroups.all) {
    if (tg === keep) continue;
    for (const t of tg.tabs) {
      const u = tabUri(t);
      if (u && set.has(u.toString())) extra.push(t);
    }
  }
  if (extra.length) await vscode.window.tabGroups.close(extra, true);
}

/** Gather a group's files into a new split (same window). */
async function cmdOpenGroup(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Open which group in a split?'));
  if (!g) return;
  const uris = filesOf(g);
  if (!uris.length) return vscode.window.showInformationMessage(`"${g.name}" has no files.`);
  busy = true;
  try {
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    for (const u of uris) await openUri(u, vscode.ViewColumn.Active);
    await closeOutside(uris, vscode.window.tabGroups.activeTabGroup);
  } catch (err) {
    vscode.window.showErrorMessage('Tab Organizer: ' + (err && err.message ? err.message : err));
  } finally {
    busy = false;
  }
}

/** Move a group's files into a new (floating) VS Code window. */
async function moveGroupToWindow(g) {
  const uris = filesOf(g);
  if (!uris.length) {
    vscode.window.showInformationMessage(`"${g.name}" has no files.`);
    return false;
  }
  const first = uris[0];
  const existing = tabsFor(new Set([first.toString()]))[0];
  const startCol = existing ? existing.group.viewColumn : vscode.window.tabGroups.all[0].viewColumn;
  await openUri(first, startCol);
  const before = vscode.window.tabGroups.activeTabGroup;
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch (err) {
    vscode.window.showErrorMessage('Tab Organizer: this VS Code cannot open floating windows (needs 1.86+). ' + (err && err.message ? err.message : ''));
    return false;
  }
  const hasFirst = (tg) => tg.tabs.some((t) => {
    const u = tabUri(t);
    return u && u.toString() === first.toString();
  });
  await waitFor(() => vscode.window.tabGroups.activeTabGroup !== before && hasFirst(vscode.window.tabGroups.activeTabGroup), 4000);
  for (const u of uris.slice(1)) await openUri(u, vscode.ViewColumn.Active);
  await closeOutside(uris, vscode.window.tabGroups.activeTabGroup);
  return true;
}

async function cmdMoveGroupToWindow(arg) {
  const g = resolveGroup(arg) || (await pickGroup('Open which group in a new window?'));
  if (!g) return;
  busy = true;
  try {
    await moveGroupToWindow(g);
  } finally {
    busy = false;
  }
}

async function cmdMoveAllGroupsToWindows() {
  const groups = state.groups.filter((g) => filesOf(g).length);
  if (!groups.length) return vscode.window.showInformationMessage('Tab Organizer: no groups with files yet.');
  busy = true;
  try {
    for (const g of groups) {
      if (!(await moveGroupToWindow(g))) break;
      await sleep(300);
    }
  } finally {
    busy = false;
  }
}

// ---------- tree view ----------

const treeProvider = {
  onDidChangeTreeData: treeEmitter.event,
  getChildren(node) {
    if (!node) {
      const roots = state.groups.map((group) => ({ kind: 'group', group }));
      const loose = ungroupedOpen();
      if (loose.length) roots.push({ kind: 'ungrouped' });
      return roots;
    }
    if (node.kind === 'group') return filesOf(node.group).map((uri) => ({ kind: 'file', uri, grouped: true }));
    if (node.kind === 'ungrouped') return ungroupedOpen().map((uri) => ({ kind: 'file', uri, grouped: false }));
    return [];
  },
  getTreeItem(node) {
    if (node.kind === 'group') {
      const n = filesOf(node.group).length;
      const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'g:' + node.group.id;
      item.description = `${n} file${n === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('circle-filled', themeColor(node.group.color));
      item.contextValue = 'group';
      return item;
    }
    if (node.kind === 'ungrouped') {
      const item = new vscode.TreeItem('Ungrouped open tabs', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'ungrouped';
      item.iconPath = new vscode.ThemeIcon('circle-outline');
      item.contextValue = 'ungrouped';
      return item;
    }
    const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
    item.id = (node.grouped ? 'f:' : 'u:') + node.uri.toString();
    item.description = isOpen(node.uri) ? vscode.workspace.asRelativePath(node.uri, false).replace(/[^/\\]*$/, '') : 'not open';
    item.command = { command: 'tabOrganizer.openFile', title: 'Open', arguments: [node.uri] };
    item.contextValue = node.grouped ? 'groupFile' : 'openFile';
    return item;
  },
};

function ungroupedOpen() {
  const seen = new Set();
  const out = [];
  for (const t of allTabs()) {
    const u = tabUri(t);
    if (!u) continue;
    const k = u.toString();
    if (seen.has(k) || state.files[k]) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

// ---------- tab events ----------

function onTabsChanged(e) {
  const now = Date.now();
  for (const t of e.opened) {
    const u = tabUri(t);
    if (u) state.opened[u.toString()] = now;
  }
  for (const t of e.closed) {
    const u = tabUri(t);
    if (u && !isOpen(u)) delete state.opened[u.toString()];
  }
  if (e.opened.length || e.closed.length) save();
  refreshTree();

  if (!busy && e.opened.length && vscode.workspace.getConfiguration('tabOrganizer').get('autoSortOnOpen')) {
    clearTimeout(autoSortTimer);
    autoSortTimer = setTimeout(() => sortAll('created', configDesc()), 400);
  }
}

function seedOpened() {
  // tabs already open when the extension starts keep their current order
  const tabs = allTabs();
  let t = Date.now() - tabs.length;
  for (const tab of tabs) {
    const u = tabUri(tab);
    t++;
    if (u && state.opened[u.toString()] == null) state.opened[u.toString()] = t;
  }
  save();
}

function onRename(e) {
  let hit = false;
  for (const { oldUri, newUri } of e.files) {
    const o = oldUri.toString();
    const n = newUri.toString();
    for (const k of Object.keys(state.files)) {
      if (k === o || k.startsWith(o + '/')) {
        state.files[n + k.slice(o.length)] = state.files[k];
        delete state.files[k];
        hit = true;
      }
    }
  }
  if (hit) changed();
}

// ---------- activate ----------

function activate(context) {
  ctx = context;
  loadState();
  seedOpened();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('tabOrganizer.sortTabs', cmdSortTabs);
  reg('tabOrganizer.sortByCreated', () => sortAll('created', configDesc()));
  reg('tabOrganizer.assignGroup', cmdAssignGroup);
  reg('tabOrganizer.removeFromGroup', cmdRemoveFromGroup);
  reg('tabOrganizer.newGroup', () => createGroup());
  reg('tabOrganizer.renameGroup', cmdRenameGroup);
  reg('tabOrganizer.setGroupColor', cmdSetGroupColor);
  reg('tabOrganizer.deleteGroup', cmdDeleteGroup);
  reg('tabOrganizer.openGroup', cmdOpenGroup);
  reg('tabOrganizer.moveGroupToWindow', cmdMoveGroupToWindow);
  reg('tabOrganizer.moveAllGroupsToWindows', cmdMoveAllGroupsToWindows);
  reg('tabOrganizer.closeGroup', cmdCloseGroup);
  reg('tabOrganizer.openFile', (uri) => vscode.commands.executeCommand('vscode.open', uri, { preview: false }));

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoEmitter.event,
      provideFileDecoration(uri) {
        const g = groupOf(uri);
        if (!g) return undefined;
        const badge = vscode.workspace.getConfiguration('tabOrganizer').get('showBadge') ? '●' : undefined;
        const d = new vscode.FileDecoration(badge, `Group: ${g.name}`, themeColor(g.color));
        d.propagate = false;
        return d;
      },
    }),
    vscode.window.createTreeView('tabOrganizer.groups', { treeDataProvider: treeProvider, showCollapseAll: true }),
    vscode.window.tabGroups.onDidChangeTabs(onTabsChanged),
    vscode.window.tabGroups.onDidChangeTabGroups(refreshTree),
    vscode.workspace.onDidRenameFiles(onRename),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tabOrganizer.showBadge')) decoEmitter.fire(undefined);
    }),
    decoEmitter,
    treeEmitter
  );
}

function deactivate() {
  clearTimeout(saveTimer);
  if (ctx && state) return ctx.workspaceState.update(STATE_KEY, state);
}

module.exports = { activate, deactivate };
