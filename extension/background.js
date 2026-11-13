const appUrl = chrome.runtime.getURL("app.html");
const attached = new Map();
const viewports = new Map();
let bridge;
let nextId = 0;
const pending = new Map();
let operations = Promise.resolve();

function helperError(message) {
  const missing = /native messaging host.*(?:not found|not registered)|access.*native messaging host.*forbidden/i.test(message);
  return Object.assign(new Error(message), {code: missing ? "helperSetup" : "helperStopped"});
}

function request(command, data = {}) {
  if (!bridge) {
    const port = chrome.runtime.connectNative("com.local.desktop_app_tabs");
    bridge = port;
    port.onMessage.addListener(({id, result, error}) => {
      const reply = pending.get(id);
      if (!reply) return;
      pending.delete(id);
      clearTimeout(reply.timer);
      if (error) reply.reject(new Error(error));
      else reply.resolve(result);
    });
    port.onDisconnect.addListener(() => {
      const error = helperError(chrome.runtime.lastError?.message ?? "Native helper stopped");
      if (bridge !== port) return;
      bridge = null;
      for (const id of attached.keys()) {
        chrome.tabs.sendMessage(id, {command: "helperStopped"}).catch(() => {});
      }
      attached.clear();
      viewports.clear();
      for (const reply of pending.values()) {
        clearTimeout(reply.timer);
        reply.reject(error);
      }
      pending.clear();
    });
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(helperError("The native helper did not respond."));
      bridge?.disconnect();
    }, 5000);
    pending.set(id, {resolve, reject, timer});
    bridge.postMessage({id, command, ...data});
  });
}

function serialize(operation) {
  const result = operations.then(operation);
  operations = result.catch(error => console.error(error.message));
  return result;
}

async function sync(windowId) {
  const [active] = await chrome.tabs.query({active: true, windowId});
  if (!bridge) return;
  const tab = attached.get(active?.id);
  if (tab?.windowId === windowId && tab.needsWindow) {
    const marker = "DesktopAppTabs-" + crypto.randomUUID();
    try {
      await chrome.tabs.sendMessage(active.id, {command: "identifyWindow", marker});
      await request("move", {tab: active.id, windowId, marker});
      tab.needsWindow = false;
    } finally {
      await chrome.tabs.sendMessage(active.id, {command: "restoreTitle"}).catch(() => {});
    }
  }
  const split = Number.isInteger(active?.splitViewId) && active.splitViewId >= 0;
  const panes = split
    ? (await chrome.tabs.query({windowId, splitViewId: active.splitViewId}))
        .sort((a, b) => a.index - b.index)
        .map(pane => attached.get(pane.id)?.windowId === windowId ? pane.id : null)
    : null;
  await request("active", {windowId, tab: tab?.windowId === windowId ? active.id : null, panes});
}

async function detach(tabId, minimize = false) {
  if (!attached.has(tabId)) return;
  if (bridge) await request("detach", {tab: tabId, minimize});
  attached.delete(tabId);
  viewports.delete(tabId);
}

async function choose(sender, message) {
  if (message.command === "viewport" && sender.url === appUrl && sender.tab) {
    const {width, height} = message;
    if (!Number.isInteger(width) || !Number.isInteger(height)) return;
    viewports.set(sender.tab.id, {width, height});
    if (bridge && attached.has(sender.tab.id)) {
      await request("viewport", {tab: sender.tab.id, width, height});
    }
    return;
  }
  if (message.command === "appInfo" && sender.url === appUrl && sender.tab) {
    const tab = attached.get(sender.tab.id);
    return tab && {label: tab.label, icon: tab.icon};
  }
  if (sender.url !== chrome.runtime.getURL("picker.html")) throw new Error("Invalid picker.");
  if (message.command === "detachAll") {
    if (!bridge) await request("recover");
    for (const id of attached.keys()) await detach(id);
    return;
  }
  const windowId = message.windowId;
  if (!Number.isInteger(windowId)) throw new Error("Open the picker from a Chrome tab.");
  if (message.command === "windowIcons") {
    return request("windowIcons", {windowId, windows: message.windows});
  }
  if (message.command === "list") {
    const available = await request("list", {windowId});
    // A window back in the native picker is no longer attached, even if its old tab survived.
    const handles = new Set(available.map(window => window.handle));
    for (const [id, tab] of attached) {
      if (handles.has(tab.handle)) attached.delete(id);
    }
    return available;
  }
  if (message.command !== "attach") throw new Error("Unknown command.");
  const existing = [...attached].find(([, tab]) => tab.handle === message.handle);
  if (existing) {
    await chrome.tabs.update(existing[0], {active: true});
    return;
  }
  const tab = await chrome.tabs.create({windowId, url: appUrl});
  try {
    const icon = await request("attach", {tab: tab.id, windowId, handle: message.handle, pid: message.pid, thread: message.thread});
    attached.set(tab.id, {windowId, handle: message.handle, label: message.label, icon});
    const viewport = viewports.get(tab.id);
    if (viewport) await request("viewport", {tab: tab.id, ...viewport});
    await sync(windowId);
  } catch (error) {
    await detach(tab.id).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serialize(() => choose(sender, message)).then(
    result => respond({result}),
    error => respond({error: error.message, code: error.code})
  );
  return true;
});
chrome.tabs.onActivated.addListener(({windowId}) => {
  serialize(async () => {
    if ([...attached.values()].some(tab => tab.windowId === windowId)) await sync(windowId);
  });
});
chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
  viewports.delete(tabId);
  await detach(tabId, true);
}));
chrome.tabs.onDetached.addListener(tabId => serialize(async () => {
  const tab = attached.get(tabId);
  if (!tab) return;
  tab.windowId = null;
  tab.needsWindow = true;
  await request("suspend", {tab: tabId});
}));
chrome.tabs.onAttached.addListener((tabId, {newWindowId}) => serialize(async () => {
  const tab = attached.get(tabId);
  if (!tab) return;
  tab.windowId = newWindowId;
  tab.needsWindow = true;
  await sync(newWindowId);
}));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url && change.url !== appUrl) serialize(() => detach(tabId, true));
  if (change.splitViewId !== undefined && [...attached.values()].some(app => app.windowId === tab.windowId)) {
    serialize(() => sync(tab.windowId));
  }
});

