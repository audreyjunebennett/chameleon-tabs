let label = document.title;
const status = document.getElementById("status");
const recovery = document.getElementById("recovery");
const openApp = document.getElementById("open-app");

function showStopped(message) {
  status.textContent = message;
  recovery.hidden = false;
}

function reportViewport() {
  chrome.runtime.sendMessage({
    command: "viewport",
    width: Math.round(innerWidth * devicePixelRatio),
    height: Math.round(innerHeight * devicePixelRatio)
  }).catch(() => {});
}
window.addEventListener("resize", reportViewport);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reportViewport();
});
reportViewport();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.command === "identifyWindow") {
    const title = document.title;
    document.title = message.marker;
    setTimeout(() => {
      if (document.title === message.marker) document.title = title;
    }, 2000);
    respond(true);
  } else if (message.command === "restoreTitle") {
    document.title = label;
  } else if (message.command === "helperStopped") {
    showStopped("The Windows helper stopped. Your desktop app may still be open.");
  } else if (message.command === "attachmentFailed") {
    showStopped("Windows couldn’t display this window in Chrome. It was returned to the desktop.");
  } else if (message.command === "returnedToDesktop") {
    status.textContent = "This app has returned to the desktop.";
    openApp.hidden = true;
    recovery.hidden = true;
  }
});

async function loadApp(command) {
  const {result, error} = await chrome.runtime.sendMessage({command});
  if (error) throw new Error(error);
  if (!result) {
    status.textContent = "This tab has no saved app. Use Chamie to attach an open window.";
    return;
  }
  label = result.label;
  document.title = label;
  openApp.hidden = !result.canOpen;
  recovery.hidden = true;
  if (result.canOpen) {
    status.textContent = "The original window is unavailable. Open the app again?";
    return;
  }
  status.textContent = "Enlarge this Chrome window if part of the app is cropped.";
  if (!result.icon?.startsWith("data:image/png;base64,")) return;
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.type = "image/png";
  icon.href = result.icon;
  document.head.append(icon);
}

loadApp("appInfo").catch(error => showStopped(error.message));
openApp.addEventListener("click", async () => {
  openApp.disabled = true;
  status.textContent = "Opening the desktop app…";
  try {
    await loadApp("openApp");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    openApp.disabled = false;
  }
});
