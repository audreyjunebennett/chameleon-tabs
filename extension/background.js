const appUrl = chrome.runtime.getURL("app.html");
const appKey = url => url?.startsWith(appUrl + "#") && /^[a-f0-9]{24}$/.test(url.slice(appUrl.length + 1))
  ? url.slice(appUrl.length + 1) : null;
const attached = new Map();
const viewports = new Map();
const reconnecting = new Map();
let bridge;
let nextId = 0;
const pending = new Map();
let operations = Promise.resolve();

function helperError(message) {
  const missing = /native messaging host.*(?:not found|not registered)|access.*native messaging host.*forbidden/i.test(message);
  return Object.assign(new Error(message), {code: missing ? "helperSetup" : "helperStopped"});
}

function reportFailedAttachments(failed = []) {
  for (const id of failed) {
    attached.delete(id);
    chrome.tabs.sendMessage(id, {command: "attachmentFailed"}).catch(() => {});
  }
}

function request(command, data = {}) {
  if (!bridge) {
    const port = chrome.runtime.connectNative("com.local.desktop_app_tabs");
    bridge = port;
    port.onMessage.addListener(({id, result, error, failed, closed, since}) => {
      if (failed) reportFailedAttachments(failed);
      if (Number.isInteger(closed)) reconnectClosedWindow(closed, since);
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
      reconnecting.clear();
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
  const failed = await request("active", {windowId, tab: tab?.windowId === windowId ? active.id : null, panes});
  reportFailedAttachments(failed ?? []);
  return failed;
}

async function detach(tabId, minimize = false, showDesktop = false) {
  if (!attached.has(tabId)) return;
  if (bridge) await request("detach", {tab: tabId, minimize, showDesktop});
  attached.delete(tabId);
  viewports.delete(tabId);
}

async function attachWindow(tab, key, item, remember = false) {
  const windowId = tab.windowId;
  const {handle, pid, thread, label, started} = item;
  const icon = await request("attach", {tab: tab.id, windowId, handle, pid, thread, started});
  attached.set(tab.id, {windowId, handle, label, icon, key});
  if (remember) {
    const identity = await request("appIdentity", {tab: tab.id});
    if ((identity?.path || identity?.appId) && identity.started) {
      await chrome.storage.local.set({[key]: {handle, pid, thread, label, ...identity}});
    }
  }
  const viewport = viewports.get(tab.id);
  if (viewport) await request("viewport", {tab: tab.id, ...viewport});
  const failed = await sync(windowId);
  if (failed?.includes(tab.id) || !attached.has(tab.id)) {
    throw new Error("Windows couldn’t display this window in Chrome. It was returned to the desktop.");
  }
  return {label, icon};
}

function reconnectClosedWindow(tabId, since) {
  const app = attached.get(tabId);
  if (!app) return;
  attached.delete(tabId);
  reconnecting.set(tabId, app);
  chrome.tabs.sendMessage(tabId, {command: "reconnecting"}).catch(() => {});
  const deadline = Date.now() + 25000;
  async function check() {
    if (reconnecting.get(tabId) !== app) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (appKey(tab?.url) !== app.key) {
      reconnecting.delete(tabId);
      return;
    }
    const saved = (await chrome.storage.local.get(app.key))[app.key];
    if (saved && Date.now() < deadline) {
      const target = {path: saved.path, appId: saved.appId};
      await request("list", {windowId: tab.windowId, reconnect: true});
      const candidates = await request("findApp", {windowId: tab.windowId, ...target, since, originalStarted: saved.started});
      const otherKeys = [...reconnecting].filter(([id]) => id !== tabId).map(([, other]) => other.key);
      const otherApps = Object.values(await chrome.storage.local.get(otherKeys));
      const ambiguous = otherApps.some(other => target.appId ? other.appId === target.appId : other.path === target.path);
      if (candidates?.length === 1 && !ambiguous) {
        const currentTab = await chrome.tabs.get(tabId).catch(() => null);
        if (appKey(currentTab?.url) === app.key && currentTab.windowId === tab.windowId) {
          const result = await attachWindow(currentTab, app.key, candidates[0], true);
          reconnecting.delete(tabId);
          chrome.tabs.sendMessage(tabId, {command: "reconnected", result}).catch(() => {});
          return;
        }
      }
      setTimeout(schedule, 1000);
      return;
    }
    reconnecting.delete(tabId);
    chrome.tabs.sendMessage(tabId, {command: "reconnected", result: {label: app.label, canOpen: !!saved}}).catch(() => {});
  }
  function schedule() {
    serialize(check).catch(error => {
      reconnecting.delete(tabId);
      chrome.tabs.sendMessage(tabId, {command: "reconnectError", message: error.message}).catch(() => {});
    });
  }
  setTimeout(schedule, 1000);
}

async function restoreApp(tab, key, launch) {
  const current = attached.get(tab.id);
  if (current) return {label: current.label, icon: current.icon};
  const waiting = reconnecting.get(tab.id);
  if (waiting && !launch) return {label: waiting.label, reconnecting: true};
  if (launch) reconnecting.delete(tab.id);
  const saved = (await chrome.storage.local.get(key))[key];
  if (!saved) return;
  const {windowId} = tab;
  const windows = await request("list", {windowId});
  const exact = windows.find(item => item.handle === saved.handle && item.pid === saved.pid && item.thread === saved.thread);
  if (exact) {
    try {
      return await attachWindow(tab, key, {...exact, started: saved.started});
    } catch (error) {
      if (error.message !== "The original window is no longer available.") throw error;
    }
  }
  if (!launch) return {label: saved.label, canOpen: true};
  const target = {path: saved.path, appId: saved.appId};
  const before = await request("findApp", {windowId, ...target});
  if (before?.length === 1) return attachWindow(tab, key, before[0], true);
  await request("launchApp", target);
  const exclude = before?.map(item => item.handle) ?? [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const candidates = await request("findApp", {windowId, ...target, exclude});
    if (candidates?.length === 1) {
      const currentTab = await chrome.tabs.get(tab.id);
      if (appKey(currentTab.url) === key && currentTab.windowId === windowId) {
        return attachWindow(currentTab, key, candidates[0], true);
      }
      return;
    }
  }
  throw new Error("Chamie couldn’t identify the app’s window. If it opened, select it from the picker.");
}

async function choose(sender, message) {
  const key = appKey(sender.url);
  if (message.command === "viewport" && key && sender.tab) {
    const {width, height} = message;
    if (!Number.isInteger(width) || !Number.isInteger(height)) return;
    viewports.set(sender.tab.id, {width, height});
    if (bridge && attached.has(sender.tab.id)) {
      await request("viewport", {tab: sender.tab.id, width, height});
    }
    return;
  }
  if ((message.command === "appInfo" || message.command === "openApp") && key && sender.tab) {
    return restoreApp(sender.tab, key, message.command === "openApp");
  }
  if (message.command === "appInfo" && sender.url === appUrl) {
    return;
  }
  if (sender.url !== chrome.runtime.getURL("picker.html")) throw new Error("Invalid picker.");
  if (message.command === "detachAll") {
    reconnecting.clear();
    if (!bridge) await request("recover");
    for (const [id, app] of attached) {
      await detach(id);
      await chrome.storage.local.remove(app.key);
      chrome.tabs.sendMessage(id, {command: "returnedToDesktop"}).catch(() => {});
    }
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
  const newKey = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const tab = await chrome.tabs.create({windowId, url: appUrl + "#" + newKey});
  try {
    await attachWindow(tab, newKey, message, true);
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
  reconnecting.delete(tabId);
  viewports.delete(tabId);
  if (attached.has(tabId)) {
    const {closeBehavior} = await chrome.storage.local.get("closeBehavior");
    await detach(tabId, closeBehavior !== "desktop", closeBehavior === "desktop");
  }
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
  if (change.url && appKey(change.url) !== reconnecting.get(tabId)?.key) reconnecting.delete(tabId);
  if (change.url && appKey(change.url) !== attached.get(tabId)?.key) serialize(() => detach(tabId, true));
  if (change.splitViewId !== undefined && [...attached.values()].some(app => app.windowId === tab.windowId)) {
    serialize(() => sync(tab.windowId));
  }
});

