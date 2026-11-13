# Chameleon Tabs

Desktop App Tabs lets you attach an open Windows application to a tab in Chrome. Open the chameleon toolbar button and select an app. Use **Return all apps to desktop** to detach your apps without closing them.

The extension talks to a Python native messaging helper on the same Windows computer. The helper needs Python, Pillow, and pywin32. This repository contains the unpacked Chrome extension and the helper source.

## Restore an existing installation

In the existing Desktop App Tabs installation, replace the `extension` directory and the two Python source files, keeping the local native messaging registration and launcher. Reload Desktop App Tabs on the Chrome extensions page and reattach your apps.

The Chrome extension ID is `nonkpmheiinadgbgcflnmhlgmchblaco`. The native host is registered as `com.local.desktop_app_tabs` and its Chrome native messaging manifest should allow `chrome-extension://nonkpmheiinadgbgcflnmhlgmchblaco/`. The extension's manifest includes a public key to preserve its ID when loaded from a different folder.
