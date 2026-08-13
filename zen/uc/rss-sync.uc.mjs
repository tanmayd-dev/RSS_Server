// ==UserScript==
// @name           RSS Sync — RSS Aggregator ↔ Zen Live Folders
// @description    Mirrors feeds from the local RSS Aggregator server into Zen Live Folders (one folder per feed).
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

/**
 * RSS Sync engine.
 *
 * Watches GET /api/feeds on the RSS Aggregator server and reconciles Zen's native
 * Live Folders to match: one live folder per feed, subscribed to
 * `{server}/feeds/{feedId}?ttl=0` so every Zen folder refresh forces a server refresh
 * (Option A: no x+y staleness, no server-side auto-refresh needed for Zen-only feeds).
 *
 * Install:
 *   1. Set up fx-autoconfig (MrOtherGuy/fx-autoconfig) or Sine in Zen.
 *   2. Copy this file + import.uc.mjs into <profile>/chrome/JS/.
 *   3. Restart Zen.
 *
 * Config: read from the "RSS Sync" mod's preferences (Services.prefs) when installed,
 * otherwise from the CONFIG defaults below. You can also set prefs manually in
 * about:config (e.g. mod.rsssync.server_url).
 *
 * Robustness notes:
 * - Multi-window: the reconcile loop runs only in Zen's "first synced window"
 *   (ZenWindowSync.firstSyncedWindow), re-elected on every tick, so it takes over
 *   automatically when windows open/close. Live folders themselves sync across
 *   windows natively via ZenWindowSync.
 * - Manual renames are preserved: the engine only renames a folder when the folder's
 *   current name is the one the engine last applied (tracked via data-rss-sync-name).
 *   After a restart (attribute gone) a folder is re-adopted only if its name still
 *   matches the server; otherwise it's treated as user-owned and left alone.
 * - Refresh state: folders get `rss-sync-refreshing` while a fetch is in flight and
 *   `data-rss-sync-last-fetched` afterwards (the mod's chrome.css styles the former).
 *
 * This relies on Zen internal APIs (ZenLiveFoldersManager, gZenFolders,
 * nsRssLiveFolderProvider) which are not a public SDK and may change between Zen
 * releases. Every call is guarded; if an API is missing the script logs and idles
 * instead of crashing the browser.
 */

const CONFIG = {
  serverUrl: "http://localhost:3000",
  pollIntervalMs: 15_000, // how often we diff server feeds vs live folders
  folderIntervalMs: 30 * 60_000, // Zen's native folder refresh interval (30 min)
  maxItems: 50, // items shown per folder (server emits up to 50)
  autoSync: true,
};

(() => {
  const win = window;
  // Only browser windows have gBrowser/gZenFolders.
  if (!win.gBrowser || !win.gZenFolders) {
    return;
  }

  let manager = null;

  try {
    ({ ZenLiveFoldersManager: manager } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
    ));
  } catch (e) {
    console.error("[rss-sync] Zen Live Folders API unavailable:", e);
    return;
  }

  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));

  // Wait for the manager to restore its state, with a timeout so we never hang.
  async function waitForManager() {
    try {
      await Promise.race([manager.stateRestored.promise, sleep(5000)]);
    } catch {
      /* ignore */
    }
  }

  // --- Config (mod preferences with fallbacks) ---
  function pref(name, fallback) {
    try {
      return Services.prefs.getStringPref(name, "");
    } catch {
      return "";
    }
  }
  function prefBool(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch {
      return fallback;
    }
  }

  const getConfig = () => ({
    serverUrl: (pref("mod.rsssync.server_url") || CONFIG.serverUrl).replace(/\/+$/, ""),
    autoSync: prefBool("mod.rsssync.auto_sync", CONFIG.autoSync),
    pollIntervalMs: Number(pref("mod.rsssync.poll_interval")) || CONFIG.pollIntervalMs,
    folderIntervalMs: Number(pref("mod.rsssync.folder_interval")) || CONFIG.folderIntervalMs,
    maxItems: Number(pref("mod.rsssync.max_items")) || CONFIG.maxItems,
  });

  async function fetchFeeds(serverUrl) {
    const res = await fetch(`${serverUrl}/api/feeds`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Server responded ${res.status}`);
    }
    return res.json();
  }

  // A live folder belongs to us if its feed URL points at our server.
  function feedIdOf(liveFolder, serverUrl) {
    const url = liveFolder?.state?.url || "";
    if (!url.startsWith(serverUrl)) {
      return null;
    }
    const m = url.match(/\/feeds\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // feedId -> { folderId, liveFolder } for folders we manage.
  function buildMapping(serverUrl) {
    const map = new Map();
    for (const [folderId, liveFolder] of manager.liveFolders) {
      const feedId = feedIdOf(liveFolder, serverUrl);
      if (feedId) {
        map.set(feedId, { folderId, liveFolder });
      }
    }
    return map;
  }

  async function createLiveFolder(feed, cfg) {
    // Drive Zen's own native creation flow (ZenLiveFoldersManager.createFolder("rss"))
    // instead of hand-rolling the provider, so the folder is guaranteed to be a real
    // live folder (registered with the manager, live-folder UI, context menu, etc.).
    // We only supply the folder URL in place of the URL prompt.
    const ProviderClass = manager.registry?.get("rss");
    if (!ProviderClass || typeof manager.createFolder !== "function") {
      console.warn(
        "[rss-sync] Native live-folder API unavailable (manager.registry or createFolder missing); skipping create."
      );
      return null;
    }

    const url = `${cfg.serverUrl}/feeds/${feed.id}?ttl=0`;
    const origPrompt = ProviderClass.promptForFeedUrl;
    let folderId = -1;
    try {
      ProviderClass.promptForFeedUrl = async () => url;
      folderId = await manager.createFolder("rss");
    } finally {
      ProviderClass.promptForFeedUrl = origPrompt;
    }

    if (!folderId || folderId === -1) {
      return null;
    }

    const liveFolder = manager.getFolder(folderId);
    if (!liveFolder) {
      return null;
    }

    // Apply engine config on top of Zen's native creation defaults.
    liveFolder.state.maxItems = cfg.maxItems;
    liveFolder.state.timeRange = 0;
    if (liveFolder.state.interval !== cfg.folderIntervalMs) {
      liveFolder.state.interval = cfg.folderIntervalMs;
      liveFolder.stop();
      liveFolder.start();
    }
    manager.saveState();

    // Name the folder after the feed and mark it as engine-managed.
    const folder = manager.getFolderForLiveFolder(liveFolder);
    if (folder) {
      folder.label = feed.name || "Feed";
      folder.setAttribute("rss-sync-feed-id", feed.id);
      folder.setAttribute("data-rss-sync-name", feed.name || "");
    }

    // Surface per-folder refresh state for the mod's CSS.
    const origFetchItems = liveFolder.fetchItems.bind(liveFolder);
    liveFolder.fetchItems = async () => {
      if (folder) {
        folder.setAttribute("rss-sync-refreshing", "");
      }
      try {
        const result = await origFetchItems();
        if (folder) {
          folder.setAttribute("data-rss-sync-last-fetched", String(Date.now()));
        }
        return result;
      } finally {
        if (folder) {
          folder.removeAttribute("rss-sync-refreshing");
        }
      }
    };

    console.info(`[rss-sync] Created live folder "${feed.name}" (feed ${feed.id})`);
    return liveFolder;
  }

  /**
   * Rename a folder to match the server feed name, unless the user renamed it.
   *
   * - `data-rss-sync-name` records the last name the engine applied.
   * - If the current label matches the server name: (re)adopt, nothing to do.
   * - If the label differs and matches the engine's last applied name: server renamed,
   *   apply the new name.
   * - If the label differs from both (or there's no record after a restart and the name
   *   doesn't match the server): the user owns the folder — never clobber it.
   */
  function renameLiveFolder(feed, liveFolder) {
    const folder = manager.getFolderForLiveFolder(liveFolder);
    if (!folder) {
      return;
    }
    const appliedName = folder.getAttribute("data-rss-sync-name");
    const label = folder.label;

    if (label === feed.name) {
      if (appliedName !== feed.name) {
        folder.setAttribute("data-rss-sync-name", feed.name);
      }
      return;
    }

    if (appliedName === null) {
      // No record (e.g. after a restart). A name that doesn't match the server is
      // assumed to be user-owned; adopt it and leave it alone from now on.
      folder.setAttribute("data-rss-sync-name", label);
      return;
    }

    if (appliedName !== label) {
      // User renamed it after the engine applied its name — leave it alone.
      return;
    }

    // Engine last set this name and the server changed → rename to match.
    folder.name = feed.name;
    folder.label = feed.name;
    if (folder.labelElement) {
      folder.labelElement.textContent = feed.name;
    }
    folder.setAttribute("data-rss-sync-name", feed.name);
    console.info(`[rss-sync] Renamed live folder to "${feed.name}"`);
  }

  async function reconcile(cfg) {
    const feeds = await fetchFeeds(cfg.serverUrl);
    const mapping = buildMapping(cfg.serverUrl);
    const seen = new Set();

    for (const feed of feeds) {
      if (!feed || !feed.id) {
        continue;
      }
      seen.add(feed.id);
      const entry = mapping.get(feed.id);
      if (entry) {
        renameLiveFolder(feed, entry.liveFolder);
      } else {
        await createLiveFolder(feed, cfg);
      }
    }

    for (const [feedId, { folderId }] of mapping) {
      if (!seen.has(feedId)) {
        manager.deleteFolder(folderId, true);
        console.info(`[rss-sync] Removed live folder for deleted feed ${feedId}`);
      }
    }
  }

  async function run() {
    const cfg = getConfig();
    // Window election: only the first synced window reconciles, re-checked every tick
    // so it takes over automatically when windows open/close.
    if (cfg.autoSync && manager.window === win) {
      try {
        await reconcile(cfg);
      } catch (e) {
        console.warn("[rss-sync] reconcile failed (server down?):", e.message || e);
      }
    }
    win.setTimeout(run, cfg.pollIntervalMs);
  }

  (async () => {
    await waitForManager();
    console.info(
      `[rss-sync] Engine ready (window ${win === manager.window ? "is" : "is not"} the synced window).`
    );
    await run();
  })();
})();
