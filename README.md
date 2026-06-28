# Group Tabs by Collection

A [Zotero](https://www.zotero.org/) plugin that groups open reader/snapshot tabs by collection, with collapsible group chips — similar to Chrome's tab groups.

<img width="835" height="68" alt="image" src="https://github.com/user-attachments/assets/11b42988-ab90-43d8-9be4-899f35b26370" />

I decided to implement this after realizing this was a common complaint about Zotero, and a [long-standing feature request](https://forums.zotero.org/discussion/110657/feature-request-improved-tab-navigation-tab-search-tab-grouping-cycle-last-used-tab). If Zotero releases an official feature, this plugin should probably not be used.

## What it does

When you have many PDFs or snapshots open at once, the Zotero tab bar becomes a flat, unorganised list. This plugin lets you group those tabs by the Zotero collection each item belongs to:

- A coloured **group chip** appears before each collection's first tab, labelled with the collection name.
- **Click a chip** to collapse the group — the tabs fold away and the chip shows a count badge. Click again to expand.
- **Right-click a chip** for a context menu with **"Close all tabs in …"**.
- **Right-click a tab** for a **"Move to group"** submenu to reassign it to any existing group, start a **"New group…"** for it, or **"Remove from group"** to ungroup it entirely.
- **Drag a tab** onto a group chip to move it into that group.
- Manual assignments (via right-click or drag) **persist** — they survive the button being clicked again and Zotero restarts.
- **Right-click items** in the item list for an **"Open in tab group(s)"** option that opens and groups them in one step.
- When there are multiple groups, all start **collapsed** so you get an instant overview. When everything belongs to one collection the group starts expanded (collapsing it would leave nothing visible).
- Opening a PDF from a collection that already has a group **automatically slots it in** — the group chip and tint appear without any action needed.
- Up to 8 distinct colours are assigned automatically (blue, green, orange, purple, teal, rose, amber, indigo).
- Tabs within a group are tinted with that group's colour.
- **Shared / group libraries are supported.** Papers in a shared group are grouped by their subcollection just like your personal library; those that sit in a shared library but in no subcollection are gathered into one group named after the library. Group chips for shared collections are prefixed with a short form of the library name (e.g. `Neuro·Schizophrenia`) so collections that share a name across libraries stay distinct; the full path appears in the chip's tooltip.
- Items in your personal library with no collection are placed at the end, ungrouped.
- **Group state is restored automatically** after a Zotero restart — groups, colours, collapsed state, and manual assignments all come back within a couple of seconds of opening Zotero.

## Usage

1. Select papers in the item list and right-click → **"Open in tab group(s)"** to open and group them in one step, or open PDFs/snapshots manually and then click the **four-box button** in the tab bar (or **Tools → Group Tabs by Collection**).
2. Tabs are reordered and coloured group chips appear in the tab bar.
3. Click a chip to collapse or expand that group; right-click for close-all.
4. Any PDF you open from a grouped collection is automatically slotted in — no need to click the button again.

### The four-box button: first run vs. subsequent runs

**First run** (no groups exist yet): all open reader tabs are sorted by collection, chips are created, and tabs are physically reordered in the tab bar.

**Subsequent runs** (groups already exist): the button only processes tabs that are not yet assigned to any group. Already-grouped tabs — including any you have manually moved — are left exactly where they are. If an ungrouped tab belongs to a collection that already has a group, it is added to that group. If it belongs to a new collection, a new group is created for it. This means you can open a handful of new papers, click the button once, and only those new papers are slotted in, without disturbing anything else.

If a tab's item belongs to **multiple (sibling) collections**, the plugin first tries to avoid asking: if one of those collections **already has a group**, the tab is slotted there automatically. Only when none of them does:
- **Via the button**: a confirmation dialog lists each remaining conflict and its suggested collection. If you proceed, the choice is **remembered** (stored as a manual assignment) so you are never prompted for that paper again. You can still move it afterwards via right-click or drag.
- **Via auto-assign** (tab opened directly from the library while groups are active): the tab is silently placed into the first matching group, with no prompt.
- **On restart restore**: conflicts are resolved silently, preferring a collection that matches a saved group.

(A paper can only live in one group at a time, since a group is a contiguous run of tabs and a tab can't be in two places at once.)

## Installation

Download the latest `group-tabs-by-collection.xpi` from the [Releases](../../releases) page.

In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**

Requires Zotero 7, 8, or 9.

## Building from source

**macOS / Linux**
```bash
git clone https://github.com/ppavlidis/group-tabs-by-collection.git
cd group-tabs-by-collection
bash build-xpi.sh
```

**Windows** (PowerShell, no WSL required)
```powershell
git clone https://github.com/ppavlidis/group-tabs-by-collection.git
cd group-tabs-by-collection
Compress-Archive -Path manifest.json,bootstrap.js,group-tabs.js,style.css,updates.json,content -DestinationPath group-tabs-by-collection.zip -Force
Rename-Item group-tabs-by-collection.zip group-tabs-by-collection.xpi
```

Then install the resulting `group-tabs-by-collection.xpi` as above.

## Notes

- **Restart behaviour:** group state is saved to Zotero's preferences store whenever it changes, and restored automatically on the next startup. Your tabs reopen as normal (Zotero's own behaviour), and within a couple of seconds the plugin re-applies groups, colours, collapsed state, and any manual assignments. No action required.
- If a group cannot be restored — for example because all its tabs were closed before the restart — it is silently dropped.
- Multi-collection conflicts that arise on restore are resolved automatically using the same first-alphabetically default as the manual dialog; no prompt is shown.
