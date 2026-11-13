const label = new URL(location.href).hash.slice(1);
if (label) document.title = decodeURIComponent(label);

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
    if (label) document.title = decodeURIComponent(label);
  }
});

chrome.runtime.sendMessage({command: "tabIcon"}).then(({result}) => {
  if (!result?.startsWith("data:image/png;base64,")) return;
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.type = "image/png";
  icon.href = result;
  document.head.append(icon);
}).catch(() => {});
