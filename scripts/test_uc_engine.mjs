// Smoke-test the pure reconciliation logic of zen/uc/rss-sync.uc.mjs in Node,
// with stubs standing in for the Zen chrome APIs (gZenFolders, LiveFolders
// manager, provider, Services.prefs, fetch). Run: npm run test-uc

import assert from "node:assert";

let feeds = [
  { id: "feed-1", name: "Alpha Feed" },
  { id: "feed-2", name: "Beta Feed" },
];
let timerQueue = [];

const foldersById = new Map();

function makeFolder(label) {
  const folder = {
    id: `folder-${foldersById.size + 1}`,
    label,
    name: label,
    labelElement: null,
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    hasAttribute(k) {
      return k in this.attributes;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
  };
  foldersById.set(folder.id, folder);
  return folder;
}

const manager = {
  liveFolders: new Map(),
  registry: new Map(),
  window: null, // set below
  stateRestored: { promise: Promise.resolve() },
  saveState() {},
  getFolder(id) {
    return this.liveFolders.get(id) ?? null;
  },
  getFolderForLiveFolder(lf) {
    return foldersById.get(lf.id) ?? null;
  },
  deleteFolder(id, deleteFolder) {
    this.liveFolders.delete(id);
    if (deleteFolder) {
      foldersById.delete(id);
    }
  },
  // Emulates ZenLiveFoldersManager.createFolder("rss") with the URL prompt patched
  // away by the engine: asks the provider for a URL, creates the folder node,
  // constructs + registers the provider, starts it and saves state.
  async createFolder(type) {
    const [provider] = type.split(":");
    const ProviderClass = this.registry.get(provider);
    if (!ProviderClass) {
      return -1;
    }
    const url = await ProviderClass.promptForFeedUrl(this.window);
    if (!url) {
      return -1;
    }
    const folder = makeFolder("Feed");
    const liveFolder = new ProviderClass({
      id: folder.id,
      state: { url, interval: 30 * 60 * 1000, lastFetched: 0, options: {} },
      manager: this,
    });
    this.liveFolders.set(folder.id, liveFolder);
    liveFolder.start();
    this.saveState();
    return folder.id;
  },
};

class FakeProvider {
  constructor({ id, state }) {
    this.id = id;
    this.state = state;
    this._refreshingDuringFetch = false;
  }
  static promptForFeedUrl() {
    return null; // the engine patches this to supply the folder URL
  }
  static async getMetadata() {
    return { label: "Feed", icon: null };
  }
  start() {
    this.started = true;
  }
  async fetchItems() {
    // Record whether the engine's wrapper flagged the folder as refreshing mid-fetch.
    this._refreshingDuringFetch =
      this._refreshingDuringFetch ||
      foldersById.get(this.id)?.hasAttribute("rss-sync-refreshing");
    return [
      { id: "item-1", url: "https://example.com/1", title: "One", date: new Date() },
      { id: "item-2", url: "https://example.com/2", title: "Two", date: new Date() },
    ];
  }
}

globalThis.window = {
  gBrowser: {},
  gZenFolders: {
    createFolder(_tabs, options) {
      return makeFolder(options.label);
    },
    setFolderUserIcon() {},
  },
  setTimeout(fn) {
    timerQueue.push(fn);
    return timerQueue.length;
  },
};
manager.window = globalThis.window;
manager.registry.set("rss", FakeProvider);

globalThis.ChromeUtils = {
  importESModule() {
    return {
      ZenLiveFoldersManager: manager,
      nsRssLiveFolderProvider: FakeProvider,
    };
  },
};
globalThis.Services = {
  prefs: {
    getStringPref() {
      return "";
    },
    getBoolPref() {
      return true;
    },
  },
};
globalThis.fetch = async () => ({ ok: true, json: async () => feeds });

await import("../zen/uc/rss-sync.uc.mjs");
await new Promise((r) => setTimeout(r, 20)); // let the async bootstrap finish

// 1. Initial reconcile: one live folder per feed, subscribed with ?ttl=0.
assert.strictEqual(manager.liveFolders.size, 2, "two feeds -> two live folders");
const urls = [...manager.liveFolders.values()]
  .map((lf) => lf.state.url)
  .sort();
assert.deepStrictEqual(urls, [
  "http://localhost:3000/feeds/feed-1?ttl=0",
  "http://localhost:3000/feeds/feed-2?ttl=0",
]);
for (const lf of manager.liveFolders.values()) {
  assert.strictEqual(lf.state.maxItems, 50, "maxItems from config");
  assert.strictEqual(lf.state.interval, 30 * 60 * 1000, "folder refresh interval from config");
  assert.strictEqual(lf.started, true, "provider started");
}
const lf1 = [...manager.liveFolders.values()].find((lf) =>
  lf.state.url.includes("feed-1")
);
const folder1 = foldersById.get(lf1.id);
assert.strictEqual(
  folder1.getAttribute("data-rss-sync-name"),
  "Alpha Feed",
  "engine tracks the name it applied"
);

// 2. Refresh state surface: during fetch the folder is flagged refreshing, afterwards
//    it carries data-rss-sync-last-fetched.
await lf1.fetchItems();
assert.strictEqual(lf1._refreshingDuringFetch, true, "folder flagged refreshing during fetch");
assert.ok(
  folder1.hasAttribute("data-rss-sync-last-fetched"),
  "folder records last-fetch time after fetch"
);
assert.strictEqual(
  folder1.hasAttribute("rss-sync-refreshing"),
  false,
  "refreshing flag removed after fetch"
);

// 3. Server rename: engine-managed folder follows the server name.
feeds[0] = { id: "feed-1", name: "Alpha Feed Renamed" };
let tick = timerQueue.pop();
await tick();
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(folder1.name, "Alpha Feed Renamed", "folder renamed to match server");
assert.strictEqual(
  folder1.getAttribute("data-rss-sync-name"),
  "Alpha Feed Renamed",
  "applied name tracked after rename"
);

// 4. Manual rename is preserved (never clobbered).
folder1.name = "My Custom Folder";
folder1.label = "My Custom Folder";
tick = timerQueue.pop();
await tick();
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(
  folder1.name,
  "My Custom Folder",
  "manual rename must not be clobbered by the engine"
);

// 5. Window election: only the first synced window reconciles.
manager.window = {}; // not the elected window
const sizeBefore = manager.liveFolders.size;
tick = timerQueue.pop();
await tick();
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(
  manager.liveFolders.size,
  sizeBefore,
  "non-elected window must not reconcile"
);
manager.window = globalThis.window;

// 6. Delete: feed-2 removed; reconcile removes its folder.
feeds = [{ id: "feed-1", name: "Alpha Feed Renamed" }];
tick = timerQueue.pop();
await tick();
await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(manager.liveFolders.size, 1, "removed feed -> its folder is deleted");
assert.ok(
  [...manager.liveFolders.values()][0].state.url.includes("feed-1"),
  "remaining folder is the one for feed-1"
);

console.log("UC engine smoke test passed ✓");
process.exit(0);
