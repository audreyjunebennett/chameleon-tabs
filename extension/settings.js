const fieldset = document.querySelector("fieldset");
const status = document.getElementById("save-status");
const radios = [...fieldset.querySelectorAll("input")];

function selectBehavior(value) {
  for (const radio of radios) radio.checked = radio.value === value;
}

chrome.storage.local.get("closeBehavior").then(({closeBehavior}) => {
  selectBehavior(closeBehavior === "desktop" ? "desktop" : "minimize");
  fieldset.disabled = false;
}).catch(() => {
  status.textContent = "Couldn’t load settings. Reopen this page to try again.";
});

fieldset.addEventListener("change", async event => {
  fieldset.disabled = true;
  status.textContent = "";
  try {
    await chrome.storage.local.set({closeBehavior: event.target.value});
    status.textContent = "Saved";
  } catch {
    status.textContent = "Couldn’t save. Try selecting the option again.";
  } finally {
    fieldset.disabled = false;
    event.target.focus();
  }
});
