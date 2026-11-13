# Desktop App Tabs privacy policy

Desktop App Tabs and its Windows helper exchange information locally through Chrome Native Messaging to attach and restore the windows you select.

The helper reads eligible window titles and icons for the picker. A title can contain a document name. The extension uses the title as the Chrome tab label. Chrome may retain tab labels through its normal browser features. App tab addresses include a random identifier. The extension stores the corresponding title, executable path, Windows package identifier when available, and window and process identifiers in local Chrome extension storage for tab restoration. Removing the extension clears its local storage. Clicking Open app on a restored tab lets the helper start the saved app on your PC.

The extension uses tab identifiers and observes URL changes to detect when you leave an attached app tab. The helper uses window identifiers, positions and window state to attach and restore windows. A local recovery file may contain window details while apps are attached. It is removed when all tracked windows have been returned or recovered.

The close-tab preference is saved in local Chrome extension storage. The extension and helper do not read document contents or webpage contents. They do not transmit window information or browsing activity to the developer or use it for advertising or analytics. The helper download link opens GitHub in Chrome when you click it.

For privacy questions, contact the developer through the [project repository](https://github.com/audreyjunebennett/chameleon-tabs).
