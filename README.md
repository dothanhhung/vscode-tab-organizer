# Tab Organizer (VS Code extension)

Sort editor tabs by **date created**, mark them with **colours / groups**, and open **each group in its own window**.

## Features

- **Sort tabs** — every tab row (each editor group, every window) by
  - date created (file creation time)
  - date modified
  - date opened (when the tab was opened in this workspace)
  - name
  - group, then date created
  
  Oldest/newest first (A→Z / Z→A). Pinned tabs stay where they are.
- **Colours & groups** — right-click a tab → **Add to Group / Colour…**. Pick an existing group, make a new one (name + colour), or just a colour. The tab title (and the Explorer entry) turns that colour and gets a `●` badge.
- **Tab Groups view** (in the Explorer side bar) — lists each group and its files, plus your ungrouped open tabs.
  - **Open Group in New Window** — moves the group's files into a new floating window.
  - **Open Every Group in Its Own Window** (title-bar button) — one window per group.
  - **Open Group in a Split** — gathers the group into a new editor group on the right.
  - **Close Group's Tabs**, **Rename**, **Change Colour**, **Delete Group** (files are never touched).
- **Group by rule** (one click, no AI): by folder, by file type, by workspace folder, **related files** (same name: `page.js` + `page.html` + `page.css`), **unsaved changes**.
- **AI: Group Tabs…**: a preset or your own instruction ("by feature: login, payments, reports"). Runs `claude -p` with your Claude Code login (default model `haiku`). An `ANTHROPIC_API_KEY` is never used. Needs Claude Code installed.
- **Auto-group rules**: files whose path matches a pattern join a group as soon as their tab opens (`tabOrganizer.autoRules`, or right-click a tab → Add Auto-Group Rule…).
- **Undo Last Grouping** after any rule or AI grouping.
- **Save Window Layout… / Open Window Layout…**: a named set of groups, each opened in its own window.
- Groups are saved per workspace and follow files when you rename/move them.

## Commands

All under `Tab Organizer:` in the Command Palette:

| Command | What it does |
|---|---|
| Sort Tabs… | pick key + direction |
| Sort Tabs by Date Created | uses `tabOrganizer.sortDirection` |
| Add to Group / Colour… | also on the tab and Explorer right-click menus |
| Remove from Group | |
| New Group… / Rename / Change Colour / Delete | |
| Open Group in New Window / in a Split | |
| Open Every Group in Its Own Window | |
| Close Group's Tabs | |
| Group Tabs by Rule… | folder / file type / workspace folder / related files / unsaved |
| AI: Group Tabs… | uses your Claude Code login |
| Add Auto-Group Rule… | pattern → group, applied when tabs open |
| Undo Last Grouping | |
| Save / Open Window Layout… | |

## Settings

| Setting | Default | |
|---|---|---|
| `tabOrganizer.sortDirection` | `ascending` | oldest first |
| `tabOrganizer.autoSortOnOpen` | `false` | re-sort by date created whenever a tab opens |
| `tabOrganizer.showBadge` | `true` | `●` badge next to grouped tabs |
| `tabOrganizer.autoRules` | `[]` | `{ "pattern": "^src/api/", "group": "API", "color": "blue" }` |
| `tabOrganizer.aiModel` | `haiku` | model for AI grouping |
| `tabOrganizer.aiPresets` | 3 presets | ready-made AI instructions |
| `tabOrganizer.claudePath` | | path to `claude` if not found automatically |

The 9 colours are theme colours (`tabOrganizer.red`, `.blue`, …) — change them in `workbench.colorCustomizations`.

## Notes

- VS Code has no API to paint a tab's background, so the colour goes on the tab **title** (file decoration). If git also colours a file (modified/untracked), VS Code may show git's colour; the `●` badge and the Tab Groups view still show the group.
- Sorting works by activating each tab and moving it, so you'll see the tabs flick for a moment.
- Floating windows need VS Code 1.86+.

## Install

```
npx @vscode/vsce package
code --install-extension tab-organizer-0.2.0.vsix
```

## License

MIT
