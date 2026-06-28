# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **bootstrapped Zotero 7/8/9 extension** (not a WebExtension) that groups open reader/snapshot/note tabs by the Zotero collection each item belongs to, rendering Chrome-style collapsible group "chips" in the tab bar. There is no build step, no bundler, no test framework, and no dependencies — the entire plugin is plain JavaScript loaded directly into Zotero's privileged chrome environment.

## Build & install

```bash
bash build-xpi.sh          # zips the listed files into group-tabs-by-collection.xpi
```

There is no compile/lint/test tooling. To test changes you install the `.xpi` in Zotero (**Tools → Add-ons → gear → Install Add-on From File…**) and reload. For a faster iteration loop, use Zotero's bootstrapped-extension reload (e.g. a proxy-file pointing at this directory, or the Run Plugin in the developer tooling) so edits to `group-tabs.js` take effect without rebuilding the `.xpi`.

Runtime debugging: all logging goes through `Zotero.debug(...)` (prefixed `GTBC:` / "Group Tabs by Collection:"). View it in Zotero's **Help → Debug Output Logging** or the JS console. `manifest.json` `version` and the `updates.json` list must be bumped together when cutting a release.

## Architecture

The codebase is essentially one module. Read these in order:

- **`bootstrap.js`** — Zotero bootstrap entry points (`startup`, `shutdown`, `onMainWindowLoad/Unload`). `startup` loads `group-tabs.js` via `Services.scriptloader.loadSubScript` and calls `GroupTabsByCollection.init` + `.addToAllWindows`. There is no `background.js` — this is the old-style bootstrap lifecycle.
- **`group-tabs.js`** — the entire plugin: a single `GroupTabsByCollection` object literal (~1150 lines). All logic lives here.
- **`style.css`** — chip styling, tab-bar button, tints. Injected as a `<link>` per window.
- **`manifest.json` / `updates.json`** — Zotero addon metadata and self-update feed (served from the GitHub `main` branch raw URL).

### Key concepts in `group-tabs.js`

**Group identity is a stable `key`, never the display name.** See the "Group identity & labelling" helper block. A group key is `col:<collectionID>` (a collection in any library), `lib:<libraryID>` (catch-all for group-library items in *no* subcollection), or `custom:<…>` (user-created via "New group…"). Keying on name would silently merge same-named collections across libraries (a real hazard since most papers live in shared groups). A *descriptor* `{ key, libraryID, collectionID, name, path, libraryName, isGroupLibrary }` carries everything needed to render and sort a group; `_candidateDescriptors(item)` produces the candidate group(s) for a tab's item. **When adding any per-group lookup, key on `g.key`, not `g.name`.**

**Two parallel maps, keyed by `window`:**
- `_windows` — per-window UI bookkeeping (`addedElementIDs` to tear down, the contextmenu handler).
- `_state` — per-window grouping state: `{ groups: GroupEntry[], tabBarObs, debounceTimer, overrides: Map }`. A `GroupEntry` is a descriptor plus `{ color, tabIds: string[], collapsed }`. `overrides` is `Map<tabId, groupKey>`. Zotero is multi-window, so almost every method takes `window` and looks up its own state.

**The grouping flow** (`groupTabs`): first run builds tab infos (`_buildTabInfos` → resolves each tab's parent item to candidate group descriptors), resolves multi-collection conflicts (`_resolveConflicts`: prefer a candidate that already has a group, else ask once via `_handleConflicts` and remember the choice as an override), physically reorders tabs so each group is contiguous (`_applyGrouping` calls `Zotero_Tabs.move`), builds `_state` (`_buildGroupState`), then renders chips (`_renderGroupChips`). **Subsequent runs** are incremental (`_groupNewTabs`) — only ungrouped tabs are touched; existing groups/colors/order/overrides are preserved.

**Chip rendering (`_renderGroupChips`) is the hot path and is deliberately READ-ONLY with respect to `g.tabIds`.** It runs from the MutationObserver during tab creation, when `Zotero_Tabs._tabs` can be momentarily incomplete. Destructively filtering tab IDs here would permanently drop valid tabs. Stale IDs are skipped, never removed; real cleanup happens only in user-initiated `groupTabs()`. **Do not add `g.tabIds` mutation/filtering inside `_renderGroupChips`.**

**The MutationObserver (`_setupTabBarObserver`)** re-injects chips after React re-renders the tab bar and auto-assigns newly opened tabs to a matching group. It carefully distinguishes a genuine tab *close* (gone from DOM **and** from `Zotero_Tabs._tabs`) from Zotero's internal remove-and-re-add reordering during drag, to avoid spurious re-renders. **Every method that calls `Zotero_Tabs.move()` or otherwise mutates the tab-bar DOM must `disconnect()` the observer first and re-`observe()` after**, or it triggers recursive re-renders (see `_addTabToGroup`, `_closeGroupTabs`, `_autoAssignNewTabs`, the chip toggle). The callback is debounced (~60ms) and aborts if `_state` was replaced mid-flight.

**Manual overrides** (right-click "Move to group", or drag-to-chip): recorded in `st.overrides` and take precedence over collection-based assignment everywhere. Drag state is tracked via the module-level `_draggingTabId` (set on delegated `dragstart`), not `dataTransfer` type checks, which are unreliable in Gecko during `dragover`.

**Persistence & restore:** state is saved to `Zotero.Prefs` key `extensions.group-tabs-by-collection.state` on every change (`_saveState`). Each group is persisted as its **full descriptor** (not just a name) so `lib:`/`custom:` groups, which aren't re-derivable from a single collection, can be reconstructed. **Tab IDs are ephemeral across restarts, so overrides are stored keyed by `itemID → groupKey`**, and translated back to tab IDs on restore. `_restoreState` runs ~2s after window load, resolves conflicts silently (preferring a candidate whose key matches a saved group), and passes a `knownGroups` map (key → saved descriptor) into `_applyGrouping`/`_buildGroupState` so override targets can be resolved.

**Collection & library resolution:** `_getParentItem` follows attachments up to their parent item. `_filterToLeafCollections` drops ancestor collections so an item in `Neuroscience > Schizophrenia` isn't treated as a multi-collection conflict; genuine sibling membership still conflicts. `_libraryInfo(libraryID)` classifies a library as personal vs. group via `libraryID !== Zotero.Libraries.userLibraryID`. Chip labels (`_chipLabel`): personal collections show the leaf folder name; shared-library subcollections show a short library prefix + folder; full lineage (`Library › Parent › Leaf`) goes in the tooltip (`_descriptorDisplay`).

### Environment constraints

- This runs in **Zotero's privileged chrome**, not a web page. `Zotero`, `Services`, `Zotero_Tabs`, `ZoteroPane` are globals. XUL elements (menus, popups) must be created with `createElementNS(XUL, ...)` where `XUL` is the `there.is.only.xul` namespace; HTML elements use `createElement`.
- UI is injected by reaching into Zotero's own DOM (`tab-bar-container`, `menu_ToolsPopup`, `zotero-itemmenu`). These IDs and the `.tab[data-id]` structure are Zotero internals and can shift between Zotero versions — element lookups are defensively guarded and retried (`tryAdd` runs at 0/500/2000ms).
- Windows-specific workarounds exist for first-click focus (fire on `mousedown` with a `click` fallback flag) and title-bar drag regions (`dblclick` preventDefault). Preserve these when touching the button/chip event handlers.
