# Chameleon Tabs

Desktop App Tabs lets you attach an open Windows application to a tab in Chrome. Open the chameleon toolbar button and select an app. Use **Return all apps to desktop** to detach your apps without closing them.

The extension talks to a Python native messaging helper on the same Windows computer. The helper needs Python, Pillow, and pywin32. This repository contains the unpacked Chrome extension and the helper source.

The Windows x64 installer in [Releases](https://github.com/audreyjunebennett/chameleon-tabs/releases) includes its own Python runtime. If the helper stops, use **Return all apps to desktop** in the picker. If that fails, close Chrome and use **Restore Chameleon Windows** from the Start menu.

For the Chrome Web Store edition, build the helper-only ZIP from `packaging/store`. Put the dashboard's 32-character Item ID in `store-item-id.txt` at the package root. Include the bundled `ChameleonTabsHost.exe` and `Restore Chameleon Windows.cmd` under `payload`, along with the runtime notices under `licenses`. Upload the ZIP to the release linked from Chamie's picker.

See the [privacy policy](PRIVACY.md) for how the extension handles tab and window information.

## Restore an existing installation

In the existing Desktop App Tabs installation, replace the `extension` directory and the two Python source files, keeping the local native messaging registration and launcher. Reload Desktop App Tabs on the Chrome extensions page and reattach your apps.

The Chrome extension ID is `nonkpmheiinadgbgcflnmhlgmchblaco`. The native host is registered as `com.local.desktop_app_tabs` and its Chrome native messaging manifest should allow `chrome-extension://nonkpmheiinadgbgcflnmhlgmchblaco/`. The extension's manifest includes a public key to preserve its ID when loaded from a different folder.
