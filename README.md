# Cookie Viewer (DOZZY)

A simple Chrome Extension (Manifest V3) to list and export cookies for the current site. Designed for local debugging and personal use.

## Load in Chrome
1. Open `chrome://extensions`.
2. Enable "Developer mode" (top-right).
3. Click "Load unpacked" and select the `cookie-viewer` folder.
4. Pin the extension. Open a site, click the icon, then click **Refresh**.

## Files
- `manifest.json` — Extension manifest (MV3)
- `service_worker.js` — Background service worker: fetches and exports cookies
- `popup.html` — Popup UI
- `popup.js` — Popup logic (list, filter, copy, export)

## Permissions
- `cookies`, `activeTab`, `downloads`, `storage`, `tabs`
- `host_permissions: ["<all_urls>"]`

For production, narrow host permissions to required domains only.

## Notes
- Only use for your own sessions and with consent.
- No data leaves your machine; exports are saved locally.

## Icons
Generate placeholder icons with PowerShell (Windows):

1. Open PowerShell in the `cookie-viewer\tools` folder.
2. Run:
	- `./make-icons.ps1`

This creates `icon16.png`, `icon48.png`, `icon128.png` in the extension root.

## Package for Web Store (ZIP)
Chrome Web Store requires a ZIP of the extension files:

1. Ensure `manifest.json` is at the root of the folder and icons exist.
2. Create a ZIP of the folder contents (not the parent folder). For example in PowerShell:
	- `Compress-Archive -Path * -DestinationPath ..\cookie-viewer.zip -Force`
3. Upload the ZIP in the Chrome Web Store Developer Dashboard.

## Pack to .crx (local distribution)
To produce a `.crx` for local/org installation:

1. Run Chrome pack-extension command in PowerShell:
	- `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --pack-extension="e:\Users\Pentester\Desktop\WORK\New folder\cookie-viewer"`
2. This generates `cookie-viewer.crx` and `cookie-viewer.pem` in the same directory.
3. For updates with the same key:
	- `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --pack-extension="e:\Users\Pentester\Desktop\WORK\New folder\cookie-viewer" --pack-extension-key="e:\Users\Pentester\Desktop\WORK\New folder\cookie-viewer.pem"`
4. Install via `chrome://extensions` (Developer mode) by dragging the `.crx` file. If blocked, use "Load unpacked" instead or deploy via enterprise policies.

