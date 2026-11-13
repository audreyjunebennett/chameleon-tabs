const windows = document.getElementById("windows");
const status = document.getElementById("status");
const detach = document.getElementById("detach");
const setup = document.getElementById("setup");

function showError(error) {
  setup.hidden = error.code !== "helperSetup";
  if (error.code === "helperSetup") {
    status.textContent = "Install the Windows helper once, then reopen Chamie.";
  } else if (error.code === "helperStopped") {
    status.textContent = "The Windows helper stopped. Try Return all apps to desktop. If that fails, close Chrome and run Restore Chameleon Windows from the Start menu.";
  } else {
    status.textContent = error.message;
  }
}

async function send(command, fields = {}) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const response = await chrome.runtime.sendMessage({command, windowId: tab?.windowId, ...fields});
  if (response.error) throw Object.assign(new Error(response.error), {code: response.code});
  return response.result;
}

async function attach(item) {
  windows.inert = true;
  detach.disabled = true;
  status.textContent = "Attaching…";
  try {
    await send("attach", item);
    window.close();
  } catch (error) {
    showError(error);
    windows.inert = false;
    detach.disabled = false;
  }
}

windows.addEventListener("keydown", event => {
  const rows = Array.from(windows.querySelectorAll("button"));
  const index = rows.indexOf(event.target);
  if (index === -1) return;
  const next = {
    ArrowDown: Math.min(index + 1, rows.length - 1),
    ArrowUp: Math.max(index - 1, 0),
    Home: 0,
    End: rows.length - 1
  }[event.key];
  if (!Number.isInteger(next)) return;
  event.preventDefault();
  rows[next].focus();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") window.close();
});

detach.addEventListener("click", async () => {
  windows.inert = true;
  detach.disabled = true;
  try {
    await send("detachAll");
    window.close();
  } catch (error) {
    showError(error);
    windows.inert = false;
    detach.disabled = false;
  }
});

send("list").then(async items => {
  status.textContent = items.length ? "" : "No available windows. Open a desktop app, then reopen this picker.";
  const rows = items.map(({handle, pid, thread, label}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "window";
    button.title = label;
    const icon = document.createElement("span");
    icon.className = "window-icon";
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "window-label";
    title.textContent = label;
    button.append(icon, title);
    button.addEventListener("click", () => attach({handle, pid, thread, label}));
    windows.append(button);
    return {identity: {handle, pid, thread}, icon};
  });
  const batchSize = 6;
  for (let start = 0; start < rows.length && !windows.inert; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const icons = await send("windowIcons", {windows: batch.map(row => row.identity)}).catch(() => null);
    if (!icons) break;
    for (const {identity, icon} of batch) {
      const source = icons[identity.handle];
      if (!source?.startsWith("data:image/png;base64,")) continue;
      const image = new Image();
      image.alt = "";
      image.addEventListener("load", () => {
        icon.append(image);
        icon.classList.add("has-icon");
      }, {once: true});
      image.src = source;
    }
  }
}).catch(showError);


