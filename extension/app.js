let label = document.title;
const status = document.getElementById("status");
const recovery = document.getElementById("recovery");

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
  }
});

chrome.runtime.sendMessage({command: "appInfo"}).then(({result}) => {
  if (!result) {
    showStopped("This tab has no attached app. Use Chamie to attach an open window.");
    return;
  }
  label = result.label;
  document.title = label;
  status.textContent = "Enlarge this Chrome window if part of the app is cropped.";
  if (!result.icon?.startsWith("data:image/png;base64,")) return;
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.type = "image/png";
  icon.href = result.icon;
  document.head.append(icon);
}).catch(() => showStopped("Chrome could not reconnect to this desktop app."));
