## Import And Export Plugin Settings By QR Code

It's often verbose or inconvenient to type settings — and especially OneDrive login credentials — on a mobile device. (On desktop computers, it's trivial to copy `data.json` across devices instead.)

So the plugin exports your setup as **two separate QR codes**. On the other device you scan the matching code (or paste its URI) to transfer the setup.

### The two QR codes

The export modal offers two independent codes:

1. **Plugin preferences (share-safe).** Your sync settings only — **no passwords or login tokens**. This code is safe to screenshot or share.
2. **OneDrive login credentials (sensitive).** Your OneDrive `refreshToken`, vault password, username, and the app's client ID / authority. **Anyone who has it can access your OneDrive — never share or post it.** Kept separate so the preferences QR stays small and share-safe. This code is only available when the current device is already connected to OneDrive.

### Steps

1. Configure the plugin on one device and make sure sync works (e.g. you can sync notes over OneDrive).
2. Open the plugin settings page, scroll to the **Import & Export** section, and click **Export**. A modal opens showing both QR codes.
3. On a second device, make sure the vault name matches the first device's.
4. On that second device, scan the QR code with the camera app or any QR-code reader. (On recent iOS the built-in camera works. On Android, the open-source [BinaryEye](https://github.com/markusfisch/BinaryEye) app is tested as working.) If the payload is too large to render as a QR code, use the **copy URI** button under it and paste the URI into the **Import** field instead.
5. The scan / import app opens a link that redirects into Obsidian. A notice confirms which export landed — *"new settings imported"* for the preferences code, or *"OneDrive login credentials imported"* for the credentials code.
6. Reopen the plugin settings so the new preferences take effect. After importing the credentials code, the OneDrive connection should already be active on the new device.

> Tip: You can transfer just the preferences code to share your sync configuration without exposing any credentials, then have the new device sign in to OneDrive on its own.
