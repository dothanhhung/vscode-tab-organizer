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
    ruleSkip: s.ruleSkip && typeof s.ruleSkip === 'object' ? s.ruleSkip : {},
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

let traceFn; // set by the integration tests only
function trace(step) {
  if (!traceFn) return;
  const groups = vscode.window.tabGroups.all.map(
    (g) => `${g.isActive ? '*' : ''}${g.viewColumn}:[${g.tabs.map((t) => t.label).join(',')}]`
  );
  traceFn(step + '  ' + groups.join(' '));
}
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
  for (const u of uris) {
    delete state.files[u.toString()];
    state.ruleSkip[u.toString()] = true; // auto rules won't put it back
  }
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
  const isFirst = (t) => {
    const u = t && tabUri(t);
    return !!u && u.toString() === first.toString();
  };
  // After an earlier group moved out, focus sits in that floating window, and opening a
  // file in a main-window column does not bring it back. Switch first, then open here.
  try {
    await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
  } catch {}
  await openUri(first, vscode.ViewColumn.Active);
  if (!(await waitFor(() => isFirst(vscode.window.tabGroups.activeTabGroup.activeTab), 3000))) {
    vscode.window.showWarningMessage(`Tab Organizer: could not focus ${path.basename(first.path)}, so "${g.name}" was not moved.`);
    return false;
  }
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
  trace('moved first to new window');
  for (const u of uris.slice(1)) {
    await openUri(u, vscode.ViewColumn.Active);
    trace('opened ' + path.basename(u.path));
  }
  await closeOutside(uris, vscode.window.tabGroups.activeTabGroup);
  trace('closed copies');
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

async function moveGroupsToWindows(groups) {
  groups = groups.filter((g) => filesOf(g).length);
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

const cmdMoveAllGroupsToWindows = () => moveGroupsToWindows(state.groups);

// ---------- grouping helpers (rules, AI, undo) ----------

let undoSnapshot;
const clone = (o) => JSON.parse(JSON.stringify(o));

function nextColor() {
  const used = new Set(state.groups.map((g) => g.color));
  const free = COLORS.find((c) => !used.has(c.id));
  return (free || COLORS[state.groups.length % COLORS.length]).id;
}

function findOrCreateGroup(name, color) {
  const clean = String(name || '').trim().slice(0, 40) || 'Other';
  let g = state.groups.find((x) => x.name.toLowerCase() === clean.toLowerCase());
  if (!g) {
    g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: clean, color: COLORS.some((c) => c.id === color) ? color : nextColor() };
    state.groups.push(g);
  }
  return g;
}

/** Regroup `uris` as [{name,color,uris}] (one Undo step). */
function applyGrouping(uris, assignments) {
  undoSnapshot = clone(state);
  const before = new Set(Object.values(state.files));
  for (const u of uris) delete state.files[u.toString()];
  for (const a of assignments) {
    if (!a.uris.length) continue;
    const g = findOrCreateGroup(a.name, a.color);
    for (const u of a.uris) state.files[u.toString()] = g.id;
  }
  const after = new Set(Object.values(state.files));
  state.groups = state.groups.filter((g) => after.has(g.id) || !before.has(g.id));
  changed();
}

function cmdUndo() {
  if (!undoSnapshot) return vscode.window.showInformationMessage('Tab Organizer: nothing to undo.');
  state = undoSnapshot;
  undoSnapshot = undefined;
  changed();
}

/** Open file tabs, one entry per file. */
function openFiles() {
  const seen = new Map();
  for (const t of allTabs()) {
    const u = tabUri(t);
    if (!u) continue;
    const k = u.toString();
    const prev = seen.get(k);
    seen.set(k, { uri: u, dirty: (prev && prev.dirty) || t.isDirty });
  }
  return [...seen.values()];
}

const relPath = (u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/');
const stemOf = (u) => path.basename(u.path).toLowerCase().replace(/\..*$/, '');

const TAB_RULES = [
  {
    id: 'folder',
    label: '$(folder) By folder',
    description: 'the folder each file is in',
    key: (f) => {
      const parts = relPath(f.uri).split('/');
      parts.pop();
      return [parts.length ? parts.slice(-2).join('/') : '(root)'];
    },
  },
  { id: 'type', label: '$(file-code) By file type', description: '.js / .html / .css / .md …', key: (f) => [(path.extname(f.uri.path).slice(1) || 'no extension').toUpperCase() + ' files'] },
  { id: 'workspace', label: '$(root-folder) By workspace folder', description: 'for multi-root workspaces', key: (f) => [(vscode.workspace.getWorkspaceFolder(f.uri) || { name: 'Outside the workspace' }).name] },
  { id: 'related', label: '$(link) Related files', description: 'same name: page.js + page.html + page.css', related: true },
  { id: 'unsaved', label: '$(circle-large-filled) Unsaved changes', description: 'tabs with unsaved edits vs saved', key: (f) => (f.dirty ? ['Unsaved changes', 'red'] : ['Saved', 'gray']) },
];

function groupTabsByRule(rule) {
  const files = openFiles();
  let assignments;
  if (rule.related) {
    const byStem = new Map();
    for (const f of files) {
      const s = stemOf(f.uri);
      if (!byStem.has(s)) byStem.set(s, []);
      byStem.get(s).push(f.uri);
    }
    assignments = [];
    const rest = [];
    for (const [s, list] of byStem) {
      if (list.length > 1) assignments.push({ name: s, uris: list });
      else rest.push(...list);
    }
    if (rest.length) assignments.push({ name: 'Other files', color: 'gray', uris: rest });
  } else {
    const buckets = new Map();
    for (const f of files) {
      const [name, color] = rule.key(f);
      if (!buckets.has(name)) buckets.set(name, { name, color, uris: [] });
      buckets.get(name).uris.push(f.uri);
    }
    assignments = [...buckets.values()];
  }
  applyGrouping(files.map((f) => f.uri), assignments);
  return { files: files.length, groups: assignments.length };
}

async function cmdRuleGroup() {
  const pick = await vscode.window.showQuickPick(TAB_RULES, { placeHolder: 'Group the open tabs by…' });
  if (!pick) return;
  const r = groupTabsByRule(pick);
  vscode.window.showInformationMessage(`Grouped ${r.files} tabs into ${r.groups} groups.`, 'Undo').then((b) => b && cmdUndo());
}

// ---------- auto rules: new tabs matching a pattern join a group ----------

function applyAutoRules(uris) {
  const rules = (vscode.workspace.getConfiguration('tabOrganizer').get('autoRules') || [])
    .map((r) => {
      try {
        return { re: new RegExp(r.pattern, 'i'), group: r.group, color: r.color };
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.group);
  if (!rules.length) return;
  let hit = false;
  for (const u of uris) {
    const k = u.toString();
    if (state.files[k] || state.ruleSkip[k]) continue;
    const r = rules.find((x) => x.re.test(relPath(u)));
    if (!r) continue;
    state.files[k] = findOrCreateGroup(r.group, r.color).id;
    hit = true;
  }
  if (hit) changed();
}

async function cmdAddAutoRule(arg, arg2) {
  const uris = resolveUris(arg, arg2);
  const pattern = await vscode.window.showInputBox({
    prompt: 'Files whose path matches this (regex, case-insensitive) join a group as soon as they open',
    placeHolder: 'e.g. ^public/juniors/|kids',
    value: uris[0] ? path.posix.dirname(relPath(uris[0])) + '/' : '',
  });
  if (!pattern) return;
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    return vscode.window.showErrorMessage('Not a valid pattern: ' + e.message);
  }
  const items = state.groups.map((g) => ({ label: `${colorInfo(g.color).emoji} ${g.name}`, g }));
  items.push({ label: '$(add) New group…', create: true });
  const p = await vscode.window.showQuickPick(items, { placeHolder: `Files matching /${pattern}/ go to…` });
  if (!p) return;
  const g = p.create ? await createGroup() : p.g;
  if (!g) return;
  const c = vscode.workspace.getConfiguration('tabOrganizer');
  const rules = (c.get('autoRules') || []).filter((r) => r.pattern !== pattern);
  rules.push({ pattern, group: g.name, color: g.color });
  await c.update('autoRules', rules, vscode.ConfigurationTarget.Global);
  applyAutoRules(openFiles().map((f) => f.uri));
}

// ---------- AI grouping (runs `claude -p` on your logged-in Claude plan, never an API key) ----------

function claudeCommand() {
  const custom = vscode.workspace.getConfiguration('tabOrganizer').get('claudePath');
  if (custom) return { cmd: custom, shell: /\.(cmd|bat|ps1)$/i.test(custom) || !path.isAbsolute(custom) };
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const p = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) return { cmd: p, shell: false };
  }
  return { cmd: 'claude', shell: true };
}

function runClaude(prompt, token) {
  const cp = require('child_process');
  const os = require('os');
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
    const { cmd, shell } = claudeCommand();
    const model = vscode.workspace.getConfiguration('tabOrganizer').get('aiModel') || 'haiku';
    let args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--system-prompt', 'You sort editor tabs into groups. You never use tools. You answer with one JSON object and nothing else.'];
    if (shell) args = args.map((a) => '"' + a.replace(/"/g, '\\"') + '"');
    const child = cp.spawn(shell ? `"${cmd}"` : cmd, args, { cwd: os.tmpdir(), env, shell, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude took longer than 4 minutes.'));
    }, 240000);
    const sub = token && token.onCancellationRequested(() => {
      child.kill();
      reject(new Error('Cancelled.'));
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('Could not start claude (install Claude Code, or set tabOrganizer.claudePath): ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (sub) sub.dispose();
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      }
      if (res.is_error) return reject(new Error('claude: ' + String(res.result || res.subtype).slice(0, 300)));
      resolve(String(res.result || ''));
    });
    child.stdin.end(prompt, 'utf8');
  });
}

async function cmdAiGroup() {
  const files = openFiles();
  if (!files.length) return vscode.window.showInformationMessage('Tab Organizer: no file tabs open.');
  const c = vscode.workspace.getConfiguration('tabOrganizer');
  const history = ctx.globalState.get('tabOrganizer.aiHistory', []);
  const items = [
    ...history.map((h) => ({ label: '$(history) ' + h, value: h })),
    ...(c.get('aiPresets') || []).map((p) => ({ label: '$(sparkle) ' + p, value: p })),
    { label: '$(edit) Write my own…', custom: true },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'How should AI group your open tabs?' });
  if (!pick) return;
  let instruction = pick.value;
  if (pick.custom) {
    instruction = await vscode.window.showInputBox({ prompt: 'Tell AI how to group the tabs', placeHolder: 'e.g. by feature: login, payments, reports' });
    if (!instruction || !instruction.trim()) return;
    instruction = instruction.trim();
  }
  await ctx.globalState.update('tabOrganizer.aiHistory', [instruction, ...history.filter((h) => h !== instruction)].slice(0, 8));
  const prompt = [
    'Group these open editor tabs the way I ask.',
    'MY INSTRUCTION: ' + instruction,
    state.groups.length ? 'Existing group names (reuse one when it fits): ' + JSON.stringify(state.groups.map((g) => g.name)) : '',
    'Colours you may use: ' + COLORS.map((x) => x.id).join(', ') + '.',
    'Files (id: workspace-relative path):',
    ...files.map((f, i) => `f${i + 1}: ${relPath(f.uri)}`),
    'Every file goes in exactly one group. Group names: 1-3 words. Different colour per group.',
    'Answer with ONLY this JSON: {"groups":[{"name":"…","color":"blue","files":["f1","f3"]}]}',
  ]
    .filter(Boolean)
    .join('\n');
  let text;
  try {
    text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Claude is grouping ${files.length} tabs…`, cancellable: true },
      (_p, token) => runClaude(prompt, token)
    );
  } catch (e) {
    if (e.message !== 'Cancelled.') vscode.window.showErrorMessage('Tab Organizer: AI grouping failed — ' + e.message);
    return;
  }
  let obj;
  try {
    obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return vscode.window.showErrorMessage('Tab Organizer: AI answer was not JSON.');
  }
  const seen = new Set();
  const assignments = (obj.groups || []).map((g) => ({
    name: g.name,
    color: g.color,
    uris: (g.files || [])
      .map((id) => files[parseInt(String(id).replace(/^f/i, ''), 10) - 1])
      .filter((f) => f && !seen.has(f.uri.toString()) && seen.add(f.uri.toString()))
      .map((f) => f.uri),
  }));
  const missed = files.filter((f) => !seen.has(f.uri.toString())).map((f) => f.uri);
  if (missed.length) assignments.push({ name: 'Other', color: 'gray', uris: missed });
  applyGrouping(files.map((f) => f.uri), assignments);
  vscode.window.showInformationMessage(`AI grouped ${files.length} tabs into ${assignments.filter((a) => a.uris.length).length} groups.`, 'Open each in its own window', 'Undo').then((b) => {
    if (b === 'Undo') cmdUndo();
    else if (b) cmdMoveAllGroupsToWindows();
  });
}

// ---------- window layouts ----------

async function cmdSaveLayout() {
  const groups = state.groups.filter((g) => filesOf(g).length);
  if (!groups.length) return vscode.window.showInformationMessage('Tab Organizer: no groups to save.');
  const picks = await vscode.window.showQuickPick(
    groups.map((g) => ({ label: `${colorInfo(g.color).emoji} ${g.name}`, picked: true, g })),
    { canPickMany: true, placeHolder: 'Which groups belong to this layout (each opens in its own window)?' }
  );
  if (!picks || !picks.length) return;
  const name = await vscode.window.showInputBox({ prompt: 'Layout name' });
  if (!name || !name.trim()) return;
  const layouts = ctx.workspaceState.get('tabOrganizer.layouts', []).filter((l) => l.name !== name.trim());
  layouts.push({ name: name.trim(), groups: picks.map((p) => p.g.id) });
  await ctx.workspaceState.update('tabOrganizer.layouts', layouts);
}

async function cmdRestoreLayout() {
  const layouts = ctx.workspaceState.get('tabOrganizer.layouts', []);
  if (!layouts.length) return vscode.window.showInformationMessage('Tab Organizer: no saved layouts yet.');
  const p = await vscode.window.showQuickPick(
    layouts.map((l) => ({ label: l.name, description: l.groups.map((id) => (groupById(id) || {}).name).filter(Boolean).join(' · '), l })),
    { placeHolder: 'Open which layout?' }
  );
  if (p) await moveGroupsToWindows(p.l.groups.map(groupById).filter(Boolean));
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
  if (e.opened.length) applyAutoRules(e.opened.map(tabUri).filter(Boolean));
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
  reg('tabOrganizer.ruleGroup', cmdRuleGroup);
  reg('tabOrganizer.aiGroup', cmdAiGroup);
  reg('tabOrganizer.undo', cmdUndo);
  reg('tabOrganizer.addAutoRule', cmdAddAutoRule);
  reg('tabOrganizer.saveLayout', cmdSaveLayout);
  reg('tabOrganizer.restoreLayout', cmdRestoreLayout);

  const decorations = {
    onDidChangeFileDecorations: decoEmitter.event,
    provideFileDecoration(uri) {
      const g = groupOf(uri);
      if (!g) return undefined;
      const badge = vscode.workspace.getConfiguration('tabOrganizer').get('showBadge') ? '●' : undefined;
      const d = new vscode.FileDecoration(badge, `Group: ${g.name}`, themeColor(g.color));
      d.propagate = false;
      return d;
    },
  };
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations),
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

  // used by the integration tests only
  return {
    __test: {
      state: () => state,
      createGroup,
      assign,
      sortAll,
      filesOf,
      decoration: (uri) => decorations.provideFileDecoration(uri),
      setTrace: (fn) => (traceFn = fn),
      groupTabsByRule: (id) => groupTabsByRule(TAB_RULES.find((r) => r.id === id)),
      applyAutoRules,
      undo: cmdUndo,
    },
  };
}

function deactivate() {
  clearTimeout(saveTimer);
  if (ctx && state) return ctx.workspaceState.update(STATE_KEY, state);
}

module.exports = { activate, deactivate };
