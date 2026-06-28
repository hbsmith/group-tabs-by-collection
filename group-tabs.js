/**
 * Group Tabs by Collection
 *
 * After calling "Group Tabs", the plugin:
 *  1. Reorders reader/note tabs so each collection's tabs are contiguous.
 *  2. Injects a coloured chip before the first tab of each group.
 *  3. Click a chip to collapse/expand that group.
 *  4. Right-click a chip → "Close all tabs in …"
 *  5. Right-click a tab  → "Move to group" submenu (existing groups, "New
 *     group…", or "Remove from group").
 *  6. Right-click items in the item list → "Open in tab group(s)".
 *  7. A MutationObserver re-injects chips when React re-renders the tab bar,
 *     and auto-assigns any newly opened tabs to their matching group.
 *
 * Works across libraries: personal-library collections, shared/group-library
 * subcollections, and a catch-all group for group-library items that aren't in
 * any subcollection.  Groups are identified by a stable key (collection ID /
 * library ID), never by display name, so same-named collections in different
 * libraries stay distinct.  See the "Group identity & labelling" helper block.
 */
var GroupTabsByCollection = {
	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),
	// Tab ID currently being dragged; set on dragstart, cleared on dragend.
	// Used by chip drop targets instead of unreliable dataTransfer type checks.
	_draggingTabId: null,

	// Per-window grouping state.
	// { groups: GroupEntry[], tabBarObs: MutationObserver|null, debounceTimer: id|null }
	// GroupEntry: { name, color, tabIds: string[], collapsed: bool }
	_state: new Map(),

	COLORS: [
		"#4D6B8A", // blue   (Zotero brand)
		"#5B8A4D", // green
		"#C97C3F", // orange
		"#7B5EA7", // purple
		"#3F8A8A", // teal
		"#A7395E", // rose
		"#8A6D3F", // amber
		"#3F5CA7", // indigo
	],

	// ── Window lifecycle ─────────────────────────────────────────────────────

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (!win.closed) this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
	},

	addToWindow(window) {
		if (this._windows.has(window)) return;
		const doc = window.document;
		const data = { addedElementIDs: [], tabContextHandler: null };
		this._windows.set(window, data);

		const link = doc.createElement("link");
		link.id = "gtbc-style";
		link.rel = "stylesheet";
		link.href = this.rootURI + "style.css";
		doc.documentElement.appendChild(link);
		data.addedElementIDs.push(link.id);

		this._addMenuItem(window);
		this._addGroupButton(window);
		this._addItemContextMenu(window);
		this._setupTabContextMenuListener(window);

		// Restore previously saved group state after Zotero has had time
		// to fully rebuild its tab list from the last session.
		window.setTimeout(() => this._restoreState(window), 2000);
	},

	removeFromWindow(window) {
		const st = this._state.get(window);
		if (st) {
			if (st.tabBarObs) st.tabBarObs.disconnect();
			if (st.debounceTimer) window.clearTimeout(st.debounceTimer);
		}
		this._state.delete(window);
		// Leave saved state intact — it will be restored on the next startup.
		// Only clear it on a full uninstall (handled by shutdown/uninstall hooks).

		const data = this._windows.get(window);
		if (!data) return;
		const doc = window.document;

		for (const id of data.addedElementIDs) doc.getElementById(id)?.remove();

		if (data.tabContextHandler) {
			doc.removeEventListener("contextmenu", data.tabContextHandler, true);
		}

		for (const chip of doc.querySelectorAll(".gtbc-chip")) chip.remove();
		for (const el of doc.querySelectorAll(".tab[data-gtbc-group]")) {
			el.style.backgroundColor = "";
			el.removeAttribute("data-gtbc-group");
		}

		this._windows.delete(window);
	},

	// ── UI injection ─────────────────────────────────────────────────────────

	_addMenuItem(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

		const menu = doc.getElementById("menu_ToolsPopup");
		if (!menu) return;

		const sep = doc.createElementNS(XUL, "menuseparator");
		sep.id = "gtbc-menu-sep";
		menu.appendChild(sep);
		data.addedElementIDs.push(sep.id);

		const item = doc.createElementNS(XUL, "menuitem");
		item.id = "gtbc-menuitem";
		item.setAttribute("label", "Group Tabs by Collection");
		item.addEventListener("command", () => this.groupTabs(window));
		menu.appendChild(item);
		data.addedElementIDs.push(item.id);
	},

	_addGroupButton(window) {
		const doc = window.document;
		const data = this._windows.get(window);

		const tryAdd = () => {
			if (doc.getElementById("gtbc-group-btn")) return;
			const container =
				doc.getElementById("tab-bar-container") ||
				doc.querySelector(".tab-bar-container");
			if (!container) return;

			const btn = doc.createElement("button");
			btn.id = "gtbc-group-btn";
			btn.className = "gtbc-group-button";
			btn.title = "Group tabs by collection";
			btn.setAttribute("aria-label", "Group tabs by collection");
			btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
				<rect x="0.5" y="0.5" width="5" height="5" rx="1"/>
				<rect x="7.5" y="0.5" width="5" height="5" rx="1"/>
				<rect x="0.5" y="7.5" width="5" height="5" rx="1"/>
				<rect x="7.5" y="7.5" width="5" height="5" rx="1"/>
			</svg>`;

			// Flash the button on every confirmed activation so users get
			// immediate feedback even when no tabs are open yet.
			const flashBtn = () => {
				btn.classList.add("gtbc-group-button--active");
				window.setTimeout(
					() => btn.classList.remove("gtbc-group-button--active"),
					150
				);
			};

			// Handle both mousedown AND click as a fallback:
			// - mousedown fires before focus-management on Windows (first click works)
			// - click is kept as safety net in case mousedown is swallowed somewhere
			// A short-lived flag prevents both from firing in the same interaction.
			let _btnFiredFromMousedown = false;

			// Prevent a double-click on the button from triggering the OS
			// window-maximise behaviour (the tab bar sits in the title-bar drag
			// region on Windows; -moz-window-dragging:no-drag in CSS is the
			// primary fix, this is belt-and-suspenders).
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});

			// Use mousedown instead of click so the action fires on the first
			// interaction even when the Zotero window was not already focused
			// (Windows swallows the click event that brings the window forward).
			btn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				_btnFiredFromMousedown = true;
				flashBtn();
				this.groupTabs(window);
			});

			btn.addEventListener("click", (e) => {
				if (_btnFiredFromMousedown) {
					_btnFiredFromMousedown = false;
					return;
				}
				e.stopPropagation();
				flashBtn();
				this.groupTabs(window);
			});
			container.appendChild(btn);
			data.addedElementIDs.push(btn.id);
		};

		tryAdd();
		window.setTimeout(tryAdd, 500);
		window.setTimeout(tryAdd, 2000);
	},

	_addItemContextMenu(window) {
		const doc = window.document;
		const data = this._windows.get(window);
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

		const itemMenu =
			doc.getElementById("zotero-itemmenu") ||
			doc.getElementById("itemMenu");
		if (!itemMenu) return;

		const sep = doc.createElementNS(XUL, "menuseparator");
		sep.id = "gtbc-itemmenu-sep";
		itemMenu.appendChild(sep);
		data.addedElementIDs.push(sep.id);

		const item = doc.createElementNS(XUL, "menuitem");
		item.id = "gtbc-itemmenu-open";
		item.setAttribute("label", "Open in tab group(s)");
		item.addEventListener("command", () =>
			this._openSelectedItemsInGroups(window)
		);
		itemMenu.addEventListener("popupshowing", () => {
			const hasSelection =
				(window.ZoteroPane?.getSelectedItems?.()?.length ?? 0) > 0;
			item.setAttribute("disabled", hasSelection ? "false" : "true");
		});
		itemMenu.appendChild(item);
		data.addedElementIDs.push(item.id);
	},

	_setupTabContextMenuListener(window) {
		const doc = window.document;
		const data = this._windows.get(window);

		const handler = (e) => {
			const st = this._state.get(window);
			if (!st || st.groups.length === 0) return;

			const tabEl = e.target.closest?.(".tab[data-id]");
			if (!tabEl) return;

			e.preventDefault();
			e.stopPropagation();
			this._showTabContextMenu(doc, window, tabEl.dataset.id, tabEl);
		};

		doc.addEventListener("contextmenu", handler, true);
		data.tabContextHandler = handler;
	},

	// ── Core grouping logic ───────────────────────────────────────────────────

	async groupTabs(window) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) {
			Zotero.debug("GTBC: Zotero_Tabs not found");
			return;
		}

		const allTabs = ZoteroTabs._tabs || [];
		const readerTabs = allTabs.filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);

		if (readerTabs.length === 0) {
			Zotero.alert(
				window,
				"Group Tabs by Collection",
				"No reader or note tabs are currently open."
			);
			return;
		}

		// If groups already exist, only pull in tabs that aren't assigned yet.
		// This preserves manually moved tabs and existing group colours/order.
		const existingState = this._state.get(window);
		if (existingState && existingState.groups.length > 0) {
			await this._groupNewTabs(window, readerTabs, ZoteroTabs);
			return;
		}

		// No groups yet — full initial grouping.
		const tabInfos = await this._buildTabInfos(readerTabs);
		const overrides = new Map(existingState?.overrides ?? []);

		this._resolveConflicts(window, tabInfos, overrides, existingState);

		this._applyGrouping(window, tabInfos, ZoteroTabs, overrides);
		this._buildGroupState(window, tabInfos, overrides);
		this._renderGroupChips(window, "groupTabs");
		this._setupTabBarObserver(window);
		this._saveState(window);
	},

	// Resolve multi-collection (sibling) conflicts silently, in place:
	//   1. Skip tabs that already have a manual override.
	//   2. Prefer a candidate collection that already has a group, minimising
	//      fragmentation.
	//   3. Otherwise pick the first candidate by the standard ordering.
	// No prompt — a tab can only live in one group, and the user can always
	// re-home it afterwards via right-click or drag.
	_resolveConflicts(window, tabInfos, overrides, existingState) {
		const existingKeys = new Set(
			(existingState?.groups ?? []).map((g) => g.key)
		);
		for (const ti of tabInfos) {
			if (ti.selected || ti.descriptors.length <= 1) continue;
			if (overrides.has(ti.tab.id)) continue;
			ti.selected =
				ti.descriptors.find((d) => existingKeys.has(d.key)) ??
				ti.descriptors.slice().sort((a, b) => this._compareGroups(a, b))[0];
		}
	},

	// Incremental grouping: called when groups already exist.
	// Creates group entries for any new collections, then re-renders.
	// Already-grouped tabs are untouched; their order and overrides are preserved.
	async _groupNewTabs(window, readerTabs, ZoteroTabs) {
		const st = this._state.get(window);
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const newTabs = readerTabs.filter((t) => !groupedIds.has(t.id));

		if (newTabs.length === 0) return;

		const tabInfos = await this._buildTabInfos(newTabs);
		if (!st.overrides) st.overrides = new Map();
		this._resolveConflicts(window, tabInfos, st.overrides, st);

		// Create an (empty) group entry for any group key not yet represented;
		// _autoAssignNewTabs then assigns and physically positions the tabs.
		const existingKeys = new Set(st.groups.map((g) => g.key));
		const usedColors = new Set(st.groups.map((g) => g.color));
		let ci = 0;
		for (const ti of tabInfos) {
			const key = st.overrides.get(ti.tab.id) ?? ti.selected?.key;
			if (!key || existingKeys.has(key)) continue;
			const desc = ti.descriptors.find((d) => d.key === key) ?? ti.selected;
			if (!desc) continue;
			existingKeys.add(key);
			while (usedColors.has(this.COLORS[ci % this.COLORS.length])) ci++;
			const color = this.COLORS[ci++ % this.COLORS.length];
			usedColors.add(color);
			st.groups.push({
				...this._descriptorFromGroup(desc),
				color,
				tabIds: [],
				collapsed: true,
			});
		}
		st.groups.sort((a, b) => this._compareGroups(a, b));

		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._autoAssignNewTabs(window);
		this._reflowTabs(window);
		this._renderGroupChips(window, "groupTabs");
		const tabBar = window.document.getElementById("tab-bar-container");
		if (st.tabBarObs && tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		this._saveState(window);
	},

	async _buildTabInfos(tabs) {
		const infos = [];
		for (const tab of tabs) {
			const item = this._getParentItem(tab.data?.itemID);
			// Candidate group descriptors, ancestor collections already dropped.
			// A single candidate is unambiguous; >1 is a genuine sibling conflict.
			const descriptors = this._candidateDescriptors(item);
			infos.push({
				tab,
				item,
				descriptors,
				selected: descriptors.length === 1 ? descriptors[0] : null,
			});
		}
		return infos;
	},

	_applyGrouping(window, tabInfos, ZoteroTabs, overrides = new Map(), knownGroups = new Map()) {
		// Build groups by stable key (override key if any, else the tab's single
		// candidate) so manually-moved tabs end up physically next to their group.
		const groups = new Map();
		const uncollected = [];

		for (const ti of tabInfos) {
			const key = overrides.get(ti.tab.id) ?? ti.selected?.key;
			if (!key) { uncollected.push(ti); continue; }
			const desc =
				ti.descriptors.find((d) => d.key === key) ??
				knownGroups.get(key) ??
				ti.selected;
			if (!desc) { uncollected.push(ti); continue; }
			if (!groups.has(key)) groups.set(key, { descriptor: desc, items: [] });
			groups.get(key).items.push(ti);
		}

		const sorted = Array.from(groups.values()).sort((a, b) =>
			this._compareGroups(a.descriptor, b.descriptor)
		);

		let idx = 1;
		for (const g of sorted) {
			for (const ti of g.items) {
				try { ZoteroTabs.move(ti.tab.id, idx++); }
				catch (e) { Zotero.debug(`GTBC: move failed: ${e}`); }
			}
		}
		for (const ti of uncollected) {
			try { ZoteroTabs.move(ti.tab.id, idx++); }
			catch (e) { Zotero.debug(`GTBC: move failed: ${e}`); }
		}
	},

	// ── Group state & chip rendering ──────────────────────────────────────────

	_buildGroupState(window, tabInfos, overrides = new Map(), knownGroups = new Map()) {
		// Cancel any in-flight debounce timer from the old state before
		// replacing it, so the old observer callback cannot fire after we set
		// up the new state and inadvertently reconnect a dead observer.
		const existing = this._state.get(window);
		if (existing) {
			if (existing.tabBarObs) existing.tabBarObs.disconnect();
			if (existing.debounceTimer) window.clearTimeout(existing.debounceTimer);
		}

		// Preserve colour and collapsed state for groups that already existed,
		// keyed by stable group key (not name — names can collide across libraries).
		const existingByKey = new Map(
			(existing?.groups ?? []).map((g) => [g.key, g])
		);

		const groups = [];
		const byKey = new Map();

		// Assign each tab to its effective group (manual override wins over the
		// tab's own single candidate).  Build the group entry on first sight,
		// resolving its descriptor from the tab's candidates, the caller-supplied
		// known groups (saved/custom), or the previous state.
		for (const ti of tabInfos) {
			const key = overrides.get(ti.tab.id) ?? ti.selected?.key;
			if (!key) continue;
			let entry = byKey.get(key);
			if (!entry) {
				const prev = existingByKey.get(key);
				const desc =
					ti.descriptors.find((d) => d.key === key) ??
					knownGroups.get(key) ??
					(prev ? this._descriptorFromGroup(prev) : null) ??
					ti.selected;
				if (!desc) continue; // unresolvable override target → leave ungrouped
				entry = {
					...this._descriptorFromGroup(desc),
					color: prev?.color ?? null,         // filled in below for new groups
					collapsed: prev?.collapsed ?? null, // filled in below for new groups
					tabIds: [],
				};
				byKey.set(key, entry);
				groups.push(entry);
			}
			if (!entry.tabIds.includes(ti.tab.id)) entry.tabIds.push(ti.tab.id);
		}

		groups.sort((a, b) => this._compareGroups(a, b));

		// Assign colours to new groups, skipping colours already in use so
		// re-grouping doesn't change existing groups' colours.
		const usedColors = new Set(
			groups.filter((g) => g.color).map((g) => g.color)
		);
		let ci = 0;
		for (const g of groups) {
			if (!g.color) {
				while (usedColors.has(this.COLORS[ci % this.COLORS.length])) ci++;
				g.color = this.COLORS[ci++ % this.COLORS.length];
				usedColors.add(g.color);
			}
		}

		// New groups always start collapsed so the user gets an overview first.
		// Existing groups keep whatever state the user last set.
		for (const g of groups) {
			if (g.collapsed === null) g.collapsed = true;
		}

		// Prune stale overrides (tab closed, or target group no longer exists).
		const openTabIdSet = new Set(tabInfos.map((ti) => ti.tab.id));
		const groupKeySet = new Set(groups.map((g) => g.key));
		for (const [tabId, key] of overrides) {
			if (!openTabIdSet.has(tabId) || !groupKeySet.has(key)) {
				overrides.delete(tabId);
			}
		}

		this._state.set(window, { groups, tabBarObs: null, debounceTimer: null, overrides });
	},

	_renderGroupChips(window, source) {
		const st = this._state.get(window);
		if (!st) return;

		const doc = window.document;
		const ZoteroTabs = window.Zotero_Tabs;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		// 1. Remove stale chips.
		for (const chip of tabBar.querySelectorAll(".gtbc-chip")) chip.remove();

		// 2. Build the set of currently-open tab IDs.
		//    READ-ONLY — do NOT mutate g.tabIds here.  The observer fires during tab
		//    creation when Zotero._tabs can be momentarily incomplete; a destructive
		//    filter at that instant would permanently drop valid tabs from their groups.
		//    Stale IDs are simply skipped in steps 5 and 6; actual cleanup happens only
		//    in groupTabs() which runs at a stable, user-initiated moment.
		const openTabIds = new Set((ZoteroTabs?._tabs || []).map((t) => t.id));

		// 3. Auto-assign newly opened tabs that belong to an existing group.
		//    Manual overrides take precedence over collection-based assignment.
		const overrides = st.overrides ?? new Map();
		const groupByKey = new Map(st.groups.map((g) => [g.key, g]));
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const allReaderTabs = (ZoteroTabs?._tabs || []).filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);
		for (const tab of allReaderTabs) {
			if (groupedIds.has(tab.id)) continue;
			// Honour manual override first.
			const overrideKey = overrides.get(tab.id);
			if (overrideKey) {
				const target = groupByKey.get(overrideKey);
				if (target) {
					target.tabIds.push(tab.id);
					groupedIds.add(tab.id);
				}
				continue;
			}
			// Fall back to collection/library-based assignment.
			const item = this._getParentItem(tab.data?.itemID);
			const match = this._candidateDescriptors(item)
				.map((d) => groupByKey.get(d.key))
				.find(Boolean);
			if (match) {
				match.tabIds.push(tab.id);
				groupedIds.add(tab.id);
			}
		}

		// 4. Clear previous tints so stale colour doesn't linger.
		for (const el of tabBar.querySelectorAll(".tab[data-gtbc-group]")) {
			el.style.backgroundColor = "";
			el.removeAttribute("data-gtbc-group");
		}

		// 5. Apply collapse state + tint to each tab element.
		for (const g of st.groups) {
			const tint = this._hexToRgba(g.color, 0.25);
			for (const tabId of g.tabIds) {
				if (!openTabIds.has(tabId)) continue; // skip stale IDs without dropping them
				const el = tabBar.querySelector(`.tab[data-id="${tabId}"]`);
				if (!el) continue;
				el.style.display = g.collapsed ? "none" : "";
				el.style.backgroundColor = tint;
				el.dataset.gtbcGroup = g.key;
				el.setAttribute("draggable", "true");
			}
		}

		// 5b. Make every reader/note tab draggable (grouped tabs already are from
		//     step 5) so any tab — including ungrouped ones — can be dragged into
		//     a group.
		for (const tab of allReaderTabs) {
			const el = tabBar.querySelector(`.tab[data-id="${tab.id}"]`);
			if (el) el.setAttribute("draggable", "true");
		}

		// 6. Insert a chip before each group's physically-leftmost open tab, so the
		//    group-name chip always sits at the left edge of its run even if the
		//    tabId order and DOM order have momentarily diverged.
		const liveOrder = new Map(
			(ZoteroTabs?._tabs || []).map((t, i) => [t.id, i])
		);
		for (const g of st.groups) {
			let leftmostId = null;
			let leftmostIdx = Infinity;
			for (const id of g.tabIds) {
				if (!openTabIds.has(id)) continue;
				const i = liveOrder.has(id) ? liveOrder.get(id) : Infinity;
				if (i < leftmostIdx) { leftmostIdx = i; leftmostId = id; }
			}
			if (leftmostId == null) continue;
			const anchorEl = tabBar.querySelector(`.tab[data-id="${leftmostId}"]`);
			if (!anchorEl) continue;
			anchorEl.parentNode.insertBefore(
				this._makeChip(doc, g, window),
				anchorEl
			);
		}
	},

	// Assigns ungrouped tabs to existing matching groups and physically moves them
	// into position.  Must be called with the tab-bar observer disconnected so the
	// DOM mutations from ZoteroTabs.move() don't trigger a recursive re-render.
	_autoAssignNewTabs(window) {
		const st = this._state.get(window);
		if (!st) return;
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;

		const overrides = st.overrides ?? new Map();
		const groupByKey = new Map(st.groups.map((g) => [g.key, g]));
		const groupedIds = new Set(st.groups.flatMap((g) => g.tabIds));
		const allReaderTabs = (ZoteroTabs._tabs || []).filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);

		for (const tab of allReaderTabs) {
			if (groupedIds.has(tab.id)) continue;

			// Manual override takes precedence over collection matching.
			const overrideKey = overrides.get(tab.id);
			let match = null;
			if (overrideKey) {
				match = groupByKey.get(overrideKey);
			} else {
				const item = this._getParentItem(tab.data?.itemID);
				match = this._candidateDescriptors(item)
					.map((d) => groupByKey.get(d.key))
					.find(Boolean);
			}
			if (!match) continue;

			match.tabIds.push(tab.id);
			groupedIds.add(tab.id);

			// Physically move the tab to follow the group's last existing member.
			const priorIds = match.tabIds.slice(0, -1);
			const liveTabs = ZoteroTabs._tabs || [];
			let afterIdx = -1;
			for (let i = 0; i < liveTabs.length; i++) {
				if (priorIds.includes(liveTabs[i].id)) afterIdx = i;
			}
			if (afterIdx >= 0) {
				try { ZoteroTabs.move(tab.id, afterIdx + 1); }
				catch (e) { Zotero.debug(`GTBC: auto-assign move failed: ${e}`); }
			}
		}
	},

	_makeChip(doc, group, window) {
		const chip = doc.createElement("div");
		chip.className = "gtbc-chip";
		chip.dataset.gtbcGroup = group.key;
		chip.style.setProperty("--gtbc-color", group.color);

		const n = group.tabIds.length;
		// Personal collections show just the folder name; shared-library
		// subcollections show a short library prefix + folder (full lineage in
		// the tooltip).
		const nameText = this._escapeHtml(this._chipLabel(group));

		chip.className = `gtbc-chip${group.collapsed ? "" : " gtbc-chip--expanded"}`;
		chip.innerHTML =
			`<span class="gtbc-chip-dot"></span>` +
			`<span class="gtbc-chip-name">${nameText}</span>` +
			`<span class="gtbc-chip-count">(${n})</span>`;

		chip.title = this._chipTooltip(group);

		const _toggleCollapse = () => {
			group.collapsed = !group.collapsed;
			const st = this._state.get(window);
			if (st?.tabBarObs) st.tabBarObs.disconnect();
			this._renderGroupChips(window, "toggle");
			if (st?.tabBarObs) {
				const tabBar = window.document.getElementById("tab-bar-container");
				if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}
			this._saveState(window);
		};

		let _chipFiredFromMousedown = false;

		chip.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			_chipFiredFromMousedown = true;
			_toggleCollapse();
		});

		chip.addEventListener("click", (e) => {
			if (_chipFiredFromMousedown) {
				_chipFiredFromMousedown = false;
				return;
			}
			e.stopPropagation();
			_toggleCollapse();
		});

		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._showChipContextMenu(doc, window, group, chip);
		});

		// Drop target: accept a tab dragged from the tab bar.
		chip.addEventListener("dragover", (e) => {
			if (!this._draggingTabId) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			chip.classList.add("gtbc-chip--drop-target");
		});
		chip.addEventListener("dragleave", () => {
			chip.classList.remove("gtbc-chip--drop-target");
		});
		chip.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			chip.classList.remove("gtbc-chip--drop-target");
			const tabId = this._draggingTabId;
			this._draggingTabId = null;
			if (tabId && !group.tabIds.includes(tabId)) {
				this._addTabToGroup(window, tabId, group);
			}
		});

		return chip;
	},

	// ── Chip context menu ─────────────────────────────────────────────────────

	_showChipContextMenu(doc, window, group, anchorEl) {
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
		doc.getElementById("gtbc-chip-popup")?.remove();

		const popup = doc.createElementNS(XUL, "menupopup");
		popup.id = "gtbc-chip-popup";

		const closeAll = doc.createElementNS(XUL, "menuitem");
		closeAll.setAttribute(
			"label",
			`Close all tabs in "${this._truncate(
				this._descriptorDisplay(this._descriptorFromGroup(group)),
				30
			)}"`
		);
		closeAll.addEventListener("command", () =>
			this._closeGroupTabs(window, group)
		);
		popup.appendChild(closeAll);

		doc.documentElement.appendChild(popup);
		popup.openPopup(anchorEl, "after_start", 0, 0, true, false);
		popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
	},

	_closeGroupTabs(window, group) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;
		const st = this._state.get(window);
		if (st?.tabBarObs) st.tabBarObs.disconnect();
		ZoteroTabs.close([...group.tabIds]);
		if (st) st.groups = st.groups.filter((g) => g !== group);
		this._renderGroupChips(window, "closeGroup");
		this._setupTabBarObserver(window);
		this._saveState(window);
	},

	// ── Tab context menu ──────────────────────────────────────────────────────

	_showTabContextMenu(doc, window, tabId, anchorEl) {
		const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
		const st = this._state.get(window);
		if (!st) return;

		doc.getElementById("gtbc-tab-popup")?.remove();

		const popup = doc.createElementNS(XUL, "menupopup");
		popup.id = "gtbc-tab-popup";

		const currentGroup = this._findGroupForTab(window, tabId);

		const addMenu = doc.createElementNS(XUL, "menu");
		addMenu.setAttribute("label", "Move to group");
		const addPopup = doc.createElementNS(XUL, "menupopup");

		for (const g of st.groups) {
			const mi = doc.createElementNS(XUL, "menuitem");
			const isCurrent = g === currentGroup;
			mi.setAttribute(
				"label",
				(isCurrent ? "\u2713 " : "") +
					this._truncate(
						this._descriptorDisplay(this._descriptorFromGroup(g)),
						35
					)
			);
			if (isCurrent) mi.setAttribute("disabled", "true");
			mi.addEventListener("command", () =>
				this._addTabToGroup(window, tabId, g)
			);
			addPopup.appendChild(mi);
		}

		// Let the user spin the tab off into a brand-new group.
		addPopup.appendChild(doc.createElementNS(XUL, "menuseparator"));
		const newGroup = doc.createElementNS(XUL, "menuitem");
		newGroup.setAttribute("label", "New group\u2026");
		newGroup.addEventListener("command", () =>
			this._createGroupFromTab(window, tabId)
		);
		addPopup.appendChild(newGroup);

		if (currentGroup) {
			addPopup.appendChild(doc.createElementNS(XUL, "menuseparator"));
			const remove = doc.createElementNS(XUL, "menuitem");
			remove.setAttribute("label", "Remove from group");
			remove.addEventListener("command", () =>
				this._removeTabFromGroup(window, tabId)
			);
			addPopup.appendChild(remove);
		}

		addMenu.appendChild(addPopup);
		popup.appendChild(addMenu);

		doc.documentElement.appendChild(popup);
		popup.openPopup(anchorEl, "after_start", 0, 0, true, false);
		popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
	},

	_findGroupForTab(window, tabId) {
		const st = this._state.get(window);
		return st?.groups.find((g) => g.tabIds.includes(tabId)) ?? null;
	},

	// Physically reorder grouped tabs so each group is a contiguous run, in the
	// same order as `st.groups` (and each group's `tabIds`), placed right after
	// the library tab.  Ungrouped tabs keep their relative order and end up after
	// all groups.  This keeps the group-name chip anchorable to the leftmost
	// member and re-heals groups that a stray native drag tried to split.
	// Caller MUST have the tab-bar observer disconnected.
	_reflowTabs(window) {
		const ZoteroTabs = window.Zotero_Tabs;
		const st = this._state.get(window);
		if (!ZoteroTabs || !st) return;
		let idx = 1; // leave the library tab at index 0
		for (const g of st.groups) {
			for (const tabId of g.tabIds) {
				const live = ZoteroTabs._tabs || [];
				if (!live.some((t) => t.id === tabId)) continue;
				try { ZoteroTabs.move(tabId, idx); }
				catch (e) { Zotero.debug(`GTBC: reflow move failed: ${e}`); }
				idx++;
			}
		}
	},

	_addTabToGroup(window, tabId, targetGroup) {
		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;
		const st = this._state.get(window);
		if (!st) return;

		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => id !== tabId);
		}
		targetGroup.tabIds.push(tabId);
		// Record manual override so this assignment survives re-grouping.
		if (!st.overrides) st.overrides = new Map();
		st.overrides.set(tabId, targetGroup.key);

		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._reflowTabs(window);
		this._renderGroupChips(window, "addToGroup");
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
		this._saveState(window);
	},

	_removeTabFromGroup(window, tabId) {
		const st = this._state.get(window);
		if (!st) return;
		for (const g of st.groups) {
			g.tabIds = g.tabIds.filter((id) => id !== tabId);
		}
		st.overrides?.delete(tabId);
		if (st.tabBarObs) st.tabBarObs.disconnect();
		this._reflowTabs(window);
		this._renderGroupChips(window, "removeFromGroup");
		if (st.tabBarObs) {
			const tabBar = window.document.getElementById("tab-bar-container");
			if (tabBar) st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
		}
		this._saveState(window);
	},

	// Prompt for a name and move the tab into a fresh, user-named group.  Custom
	// groups carry no collection identity (key "custom:…") and live alongside the
	// personal-library groups in the ordering.
	_createGroupFromTab(window, tabId) {
		const st = this._state.get(window);
		if (!st) return;

		const input = { value: "" };
		const ok = Services.prompt.prompt(
			window,
			"New Tab Group",
			"Name for the new group:",
			input,
			null,
			{ value: false }
		);
		const label = ok ? input.value.trim() : "";
		if (!label) return;

		const used = new Set(st.groups.map((g) => g.color));
		let ci = 0;
		while (used.has(this.COLORS[ci % this.COLORS.length])) ci++;
		const color = this.COLORS[ci % this.COLORS.length];

		const group = {
			key: "custom:" + Date.now() + ":" + Math.random().toString(36).slice(2, 7),
			libraryID: null,
			collectionID: null,
			name: label,
			path: [label],
			libraryName: "",
			isGroupLibrary: false,
			color,
			tabIds: [],
			collapsed: false,
		};
		st.groups.push(group);
		st.groups.sort((a, b) => this._compareGroups(a, b));
		// _addTabToGroup records the override, repositions, re-renders, and saves.
		this._addTabToGroup(window, tabId, group);
	},

	// ── Item context menu: "Open in tab group(s)" ────────────────────────────

	async _openSelectedItemsInGroups(window) {
		const pane = window.ZoteroPane;
		if (!pane) return;

		const items = pane.getSelectedItems?.() ?? [];
		if (items.length === 0) return;

		try {
			await pane.viewItems(items);
		} catch (e) {
			Zotero.debug(`GTBC: viewItems failed: ${e}`);
			return;
		}

		// Brief settle so Zotero finishes registering the new tabs.
		await new Promise((r) => window.setTimeout(r, 300));
		await this.groupTabs(window);
	},

	// ── Tab-bar MutationObserver ──────────────────────────────────────────────

	_setupTabBarObserver(window) {
		const st = this._state.get(window);
		if (!st) return;
		if (st.tabBarObs) st.tabBarObs.disconnect();

		const doc = window.document;
		const tabBar = doc.getElementById("tab-bar-container");
		if (!tabBar) return;

		st.tabBarObs = new window.MutationObserver((mutations) => {
			const chipRemoved = mutations.some((m) =>
				Array.from(m.removedNodes).some(
					(n) => n.classList?.contains?.("gtbc-chip")
				)
			);
			// Fire when a tab is genuinely added (auto-assign to existing group).
			const tabAdded = mutations.some((m) =>
				Array.from(m.addedNodes).some(
					(n) => n.classList?.contains?.("tab") && n.dataset?.id
				)
			);
			// Fire when a tab is genuinely closed — i.e. removed from the DOM and
			// also absent from Zotero_Tabs._tabs.  Zotero internally reorders tabs
			// by removing and re-adding them, which would also look like a removal;
			// we skip those to avoid spurious re-renders during DnD reordering.
			const liveTabs = window.Zotero_Tabs?._tabs || [];
			const tabClosed = mutations.some((m) =>
				Array.from(m.removedNodes).some((n) => {
					if (!n.classList?.contains?.("tab") || !n.dataset?.id) return false;
					return !liveTabs.some((t) => t.id === n.dataset.id);
				})
			);
			if (!chipRemoved && !tabAdded && !tabClosed) return;

			if (st.debounceTimer) window.clearTimeout(st.debounceTimer);
			st.debounceTimer = window.setTimeout(() => {
				st.debounceTimer = null;
				// Abort if a new grouping run has replaced the state.
				if (this._state.get(window) !== st) return;
				st.tabBarObs.disconnect();
				// Assign any new tabs to existing groups and physically move them
				// BEFORE rendering, so the DOM is stable when tints/chips are applied.
				this._autoAssignNewTabs(window);
				this._reflowTabs(window);
				this._renderGroupChips(window, "observer");
				st.tabBarObs.observe(tabBar, { childList: true, subtree: true });
			}, 60);
		});

		st.tabBarObs.observe(tabBar, { childList: true, subtree: true });

		// Delegated drag handlers: track which tab is being dragged so chip and
		// tab drop targets can accept it without relying on dataTransfer type
		// checks, which are unreliable in Gecko during dragover.
		tabBar.addEventListener("dragstart", (e) => {
			const tabEl = e.target.closest?.(".tab[data-id]");
			if (!tabEl) return;
			// Only reader/note tabs may be dragged into groups — never the
			// library tab or other special tabs.
			const tabId = tabEl.dataset.id;
			const t = (window.Zotero_Tabs?._tabs || []).find((x) => x.id === tabId);
			if (!t || !(t.type === "reader" || t.type === "reader-unloaded" || t.type === "note")) {
				return;
			}
			this._draggingTabId = tabId;
			e.dataTransfer.setData("text/plain", tabId);
			e.dataTransfer.effectAllowed = "move";
		});
		tabBar.addEventListener("dragend", () => {
			this._draggingTabId = null;
			for (const el of tabBar.querySelectorAll(".gtbc-drop-into")) {
				el.classList.remove("gtbc-drop-into");
			}
		});

		// Make a group's whole tab-region a drop target, not just its chip:
		// dropping a dragged tab onto any tab that belongs to a group adds the
		// dragged tab to that same group.
		tabBar.addEventListener("dragover", (e) => {
			if (!this._draggingTabId) return;
			const overEl = e.target.closest?.(".tab[data-gtbc-group]");
			if (!overEl || overEl.dataset.id === this._draggingTabId) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			if (!overEl.classList.contains("gtbc-drop-into")) {
				for (const el of tabBar.querySelectorAll(".gtbc-drop-into")) {
					el.classList.remove("gtbc-drop-into");
				}
				overEl.classList.add("gtbc-drop-into");
			}
		});
		tabBar.addEventListener("drop", (e) => {
			if (!this._draggingTabId) return;
			const overEl = e.target.closest?.(".tab[data-gtbc-group]");
			if (!overEl) return;
			e.preventDefault();
			e.stopPropagation();
			overEl.classList.remove("gtbc-drop-into");
			const key = overEl.dataset.gtbcGroup;
			const draggedId = this._draggingTabId;
			this._draggingTabId = null;
			const group = this._state.get(window)?.groups.find((g) => g.key === key);
			if (group && draggedId && !group.tabIds.includes(draggedId)) {
				this._addTabToGroup(window, draggedId, group);
			}
		});
	},

	// ── State persistence ─────────────────────────────────────────────────────

	_saveState(window) {
		const st = this._state.get(window);
		if (!st || st.groups.length === 0) {
			try { Zotero.Prefs.clear("extensions.group-tabs-by-collection.state"); } catch (e) {}
			return;
		}

		const ZoteroTabs = window.Zotero_Tabs;
		const allTabs = ZoteroTabs?._tabs || [];

		// Tab IDs are ephemeral — translate overrides to itemId keys for storage.
		const itemOverrides = {};
		for (const [tabId, groupKey] of (st.overrides ?? new Map())) {
			const tab = allTabs.find((t) => t.id === tabId);
			const itemID = tab?.data?.itemID;
			if (itemID) itemOverrides[String(itemID)] = groupKey;
		}

		// Persist the full group descriptor (keyed by stable key) so library-root
		// and custom groups — which aren't re-derivable from a single collection —
		// can be reconstructed on restore.
		const data = {
			groups: st.groups.map((g) => ({
				key: g.key,
				libraryID: g.libraryID,
				collectionID: g.collectionID,
				name: g.name,
				path: g.path,
				libraryName: g.libraryName,
				isGroupLibrary: g.isGroupLibrary,
				color: g.color,
				collapsed: g.collapsed,
			})),
			overrides: itemOverrides,
		};

		try {
			Zotero.Prefs.set(
				"extensions.group-tabs-by-collection.state",
				JSON.stringify(data)
			);
		} catch (e) {
			Zotero.debug(`GTBC: failed to save state: ${e}`);
		}
	},

	async _restoreState(window) {
		// Don't clobber a grouping the user has already set up this session.
		if ((this._state.get(window)?.groups.length ?? 0) > 0) return;

		let data;
		try {
			const raw = Zotero.Prefs.get("extensions.group-tabs-by-collection.state");
			if (!raw) return;
			data = JSON.parse(raw);
		} catch (e) {
			Zotero.debug(`GTBC: failed to load saved state: ${e}`);
			return;
		}

		if (!data?.groups?.length) return;

		const ZoteroTabs = window.Zotero_Tabs;
		if (!ZoteroTabs) return;

		const allTabs = ZoteroTabs._tabs || [];
		const readerTabs = allTabs.filter(
			(t) => t.type === "reader" || t.type === "reader-unloaded" || t.type === "note"
		);
		if (readerTabs.length === 0) return;

		// Saved groups keyed by their stable key; also used to resolve descriptors
		// for override targets that aren't re-derivable from a tab's collections.
		const savedByKey = new Map(data.groups.map((g) => [g.key, g]));
		const savedKeys = new Set(savedByKey.keys());
		const knownGroups = new Map(
			data.groups.map((g) => [g.key, this._descriptorFromGroup(g)])
		);

		const tabInfos = await this._buildTabInfos(readerTabs);
		// Auto-resolve multi-collection conflicts silently on restore: prefer a
		// candidate that maps to a saved group, else fall back to the first by
		// the standard ordering.
		for (const ti of tabInfos.filter((ti) => ti.descriptors.length > 1 && !ti.selected)) {
			ti.selected =
				ti.descriptors.find((d) => savedKeys.has(d.key)) ??
				ti.descriptors.slice().sort((a, b) => this._compareGroups(a, b))[0];
		}

		// Translate saved itemId overrides back to current tab IDs.
		const overrides = new Map();
		for (const ti of tabInfos) {
			const itemID = ti.tab.data?.itemID;
			const savedKey = itemID && data.overrides?.[String(itemID)];
			if (savedKey) overrides.set(ti.tab.id, savedKey);
		}

		this._applyGrouping(window, tabInfos, ZoteroTabs, overrides, knownGroups);
		this._buildGroupState(window, tabInfos, overrides, knownGroups);

		// Overlay the saved colours and collapsed states.  _buildGroupState
		// assigns defaults for "new" groups; we want the user's last-seen values.
		const st = this._state.get(window);
		if (st) {
			for (const g of st.groups) {
				const saved = savedByKey.get(g.key);
				if (saved) {
					g.color = saved.color;
					g.collapsed = saved.collapsed;
				}
			}
		}

		this._renderGroupChips(window, "restore");
		this._setupTabBarObserver(window);
	},

	// ── Helpers ───────────────────────────────────────────────────────────────

	/**
	 * Return the parent item for an attachment, or the item itself otherwise.
	 * This ensures collection lookups reflect where the paper lives, not the
	 * attachment filename.
	 */
	_getParentItem(itemID) {
		if (!itemID) return null;
		const item = Zotero.Items.get(itemID);
		if (!item) return null;
		if (item.isAttachment() && item.parentID) {
			return Zotero.Items.get(item.parentID) || item;
		}
		return item;
	},

	/**
	 * Given a list of collections an item belongs to, remove any that are
	 * ancestors of another collection in the same list.
	 *
	 * Example: item in [Neuroscience, Schizophrenia] where Schizophrenia ⊂
	 * Neuroscience → returns [Schizophrenia]. No conflict is raised.
	 *
	 * If the item is in two sibling collections (e.g. [Schizophrenia,
	 * Depression], both children of Neuroscience) both are kept and the caller
	 * must handle the conflict.
	 */
	_filterToLeafCollections(collections) {
		if (collections.length <= 1) return collections;

		// Collect IDs of every ancestor of every collection in the list.
		const ancestorIds = new Set();
		for (const c of collections) {
			let cur = c;
			while (cur.parentID) {
				const parent = Zotero.Collections.get(cur.parentID);
				if (!parent) break;
				ancestorIds.add(parent.id);
				cur = parent;
			}
		}

		// Keep only collections that are NOT an ancestor of another in the list.
		const leaves = collections.filter((c) => !ancestorIds.has(c.id));
		return leaves.length > 0 ? leaves : collections;
	},

	// ── Group identity & labelling ────────────────────────────────────────────
	//
	// A group is identified by a stable `key`, NOT by its display name — two
	// collections in different libraries can share a name (e.g. a "Reading"
	// folder in both My Library and a shared group), and keying on the name
	// would silently merge them.  Keys:
	//   "col:<collectionID>"  — a collection (personal or group library)
	//   "lib:<libraryID>"     — the catch-all for group-library items that are
	//                            in the library but in no subcollection
	//   "custom:<…>"          — a user-created group (via "New group…")
	//
	// A *descriptor* carries everything needed to render and sort a group:
	//   { key, libraryID, collectionID, name, path, libraryName, isGroupLibrary }
	// where `name` is the leaf label, `path` is the collection-name chain from
	// top-level down to the leaf, and `isGroupLibrary` is true for shared groups.

	_libraryInfo(libraryID) {
		let lib = null;
		try { lib = Zotero.Libraries.get(libraryID); } catch (e) {}
		const userID = Zotero.Libraries.userLibraryID;
		return {
			name: lib?.name ?? "Library",
			// Anything that isn't the personal library is treated as "shared" for
			// labelling purposes (group libraries, and the harmless edge cases of
			// feeds / My Publications, which simply get their name shown).
			isGroupLibrary: libraryID !== userID,
		};
	},

	_descriptorForCollection(col) {
		// Walk up to build the full name path (top-level → leaf).
		const path = [];
		const seen = new Set();
		let cur = col;
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			path.unshift(cur.name);
			cur = cur.parentID ? Zotero.Collections.get(cur.parentID) : null;
		}
		const { name: libraryName, isGroupLibrary } = this._libraryInfo(col.libraryID);
		return {
			key: "col:" + col.id,
			libraryID: col.libraryID,
			collectionID: col.id,
			name: col.name,
			path,
			libraryName,
			isGroupLibrary,
		};
	},

	_descriptorForLibraryRoot(libraryID) {
		const { name: libraryName, isGroupLibrary } = this._libraryInfo(libraryID);
		return {
			key: "lib:" + libraryID,
			libraryID,
			collectionID: null,
			name: libraryName,
			path: [libraryName],
			libraryName,
			isGroupLibrary,
		};
	},

	// Candidate group descriptors for an item, in priority order.
	//  - Items in one or more (leaf) collections → one descriptor per collection.
	//  - Group-library items in NO subcollection → a single library-root group.
	//  - Personal-library items in no collection → [] (left ungrouped).
	_candidateDescriptors(item) {
		if (!item) return [];
		const raw = item
			.getCollections()
			.map((id) => Zotero.Collections.get(id))
			.filter(Boolean);
		const leaves = this._filterToLeafCollections(raw);
		if (leaves.length > 0) {
			return leaves.map((c) => this._descriptorForCollection(c));
		}
		const { isGroupLibrary } = this._libraryInfo(item.libraryID);
		if (isGroupLibrary) return [this._descriptorForLibraryRoot(item.libraryID)];
		return [];
	},

	_descriptorFromGroup(g) {
		return {
			key: g.key,
			libraryID: g.libraryID,
			collectionID: g.collectionID,
			name: g.name,
			path: g.path,
			libraryName: g.libraryName,
			isGroupLibrary: g.isGroupLibrary,
		};
	},

	// Stable ordering: personal-library groups first, then each shared library
	// (grouped together), and within a library by collection path.
	_compareGroups(a, b) {
		const ax = a?.isGroupLibrary ? 1 : 0;
		const bx = b?.isGroupLibrary ? 1 : 0;
		if (ax !== bx) return ax - bx;
		const al = (a?.libraryName ?? "").toLowerCase();
		const bl = (b?.libraryName ?? "").toLowerCase();
		if (al !== bl) return al < bl ? -1 : 1;
		const ap = (a?.path ?? [a?.name ?? ""]).join(" ").toLowerCase();
		const bp = (b?.path ?? [b?.name ?? ""]).join(" ").toLowerCase();
		if (ap !== bp) return ap < bp ? -1 : 1;
		return 0;
	},

	// Compact chip label (~20 char budget):
	//  - Personal collection / shared-library root / custom group → leaf name.
	//  - Shared-library subcollection → short library prefix + leaf folder, e.g.
	//    "Neuro·Schizophreni…" (full lineage lives in the tooltip).
	_chipLabel(group) {
		const BUDGET = 20;
		if (group.isGroupLibrary && group.collectionID !== null) {
			const libPart = (group.libraryName || "").slice(0, 5);
			const leafBudget = Math.max(5, BUDGET - libPart.length - 1);
			return libPart + "·" + this._truncate(group.name, leafBudget);
		}
		return this._truncate(group.name, BUDGET);
	},

	// Full, untruncated lineage for tooltips / menus: "Library › Parent › Leaf"
	// for shared subcollections; the plain path otherwise.
	_descriptorDisplay(d) {
		const path =
			d.isGroupLibrary && d.collectionID !== null
				? [d.libraryName, ...d.path]
				: d.path;
		return path.join(" › ");
	},

	_chipTooltip(group) {
		const n = group.tabIds.length;
		const lineage = this._descriptorDisplay(this._descriptorFromGroup(group));
		const verb = group.collapsed ? "Expand" : "Collapse";
		return `${verb} “${lineage}” — ${n} tab${n === 1 ? "" : "s"}`;
	},

	_hexToRgba(hex, alpha) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	},

	_escapeHtml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},

	_truncate(s, n) {
		return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
	},
};
