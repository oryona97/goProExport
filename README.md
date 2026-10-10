# GoPro USB Footage App

This local Windows app previews GoPro footage over USB-C and saves original videos to a local folder or your own Google Drive.

It was designed around the official Open GoPro docs before any code was written:

- Open GoPro HTTP API: [https://gopro.github.io/OpenGoPro/http](https://gopro.github.io/OpenGoPro/http)
- Camera media tutorial: [https://gopro.github.io/OpenGoPro/tutorials/camera-media-list](https://gopro.github.io/OpenGoPro/tutorials/camera-media-list)
- Supported-camera reference: [https://gopro.github.io/OpenGoPro/ble](https://gopro.github.io/OpenGoPro/ble)

## What the app does

- Detects likely GoPro USB IP addresses from your PC's network interfaces
- Lets you connect manually by camera IP or by the last 3 digits of the camera serial number
- Enables official wired USB control
- Sends keep-alive requests every 3 seconds so the camera does not go to sleep
- Reads the GoPro media list
- Streams lightweight video previews using GoPro proxy `.LRV` files when available
- Saves original videos only, preserving each filename and separate chapter
- Offers a local folder or Google Drive destination for each batch
- Organizes both destinations as `<chosen folder>/YYYY-MM-DD/<original filename>` using the recording date and chosen timezone
- Skips confirmed identical copies and preserves filename conflicts under `Conflicts-N`
- Shows camera download, cloud upload, and verification progress
- Remembers batches across restarts with Pause, Resume, Retry failed, and Discard unfinished controls
- Protects remembered Google authorization with Windows user-bound credential protection

## Important GoPro notes

- Open GoPro USB works over an HTTP connection on top of a USB network link (NCM), not by mounting the camera as a normal drive.
- The camera must support Open GoPro wired USB control for the full USB flow to work.
- The app uses these documented endpoints:
  - `/gopro/camera/control/wired_usb?p=1`
  - `/gopro/camera/keep_alive`
  - `/gopro/media/list`
  - `/videos/DCIM/{directory}/{filename}`
- GoPro documents the USB camera IP as `172.2X.1YZ.51`, where `XYZ` are the last three digits of the serial number.

## Run it

From this folder:

```powershell
npm.cmd install
npm.cmd start
```

Then open:

```text
http://127.0.0.1:4173
```

## Typical use

1. Connect the GoPro to the PC with a USB-C cable.
2. Power on the camera.
3. Open the app.
4. Click `Scan USB candidates`, or enter the camera IP / serial suffix manually.
5. Click `Connect to GoPro`.
6. Refresh the media list if needed.
7. Choose **Local folder** or **Google Drive**, then check the recording timezone. The default is your computer's timezone.
8. For Drive, click **Connect Google Drive**, sign in through your system browser, and choose an existing My Drive folder or **Create GoPro Exports folder**. The app maintainer configures the shared OAuth client once; see [Google setup](docs/google-drive-setup.md).
9. Queue selected originals or all videos, then click **Start queue**. Preference changes apply to the next batch.

Cloud saves temporarily store one complete original at a time under `%LOCALAPPDATA%\GoProExport\staging` unless you choose another temporary storage folder. Failed uploads retain their originals, so retained storage can grow beyond one video. Temporary originals are removed after Drive's size and checksum match.

After reopening, select an unfinished batch and resume when ready. Staged originals can finish uploading without the camera; interrupted camera downloads need the original camera. **Discard unfinished** clears temporary originals and pending work while preserving saved destination files and camera originals. Finish or discard all unfinished cloud work before switching Google accounts; **Reconnect original account** remains available for recovery.

Missing recording timestamps use an **Unknown date** folder. Chapters spanning midnight use each chapter's own date. Shared drives are outside this release.

## Google Drive setup

Local saving works immediately. Drive requires the maintainer's Desktop OAuth configuration in `google-oauth.json`, or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables. End users connect their own accounts through the UI. Follow [the setup and first-account checklist](docs/google-drive-setup.md) before distributing the app.

## Tests

Use Windows, Node 20.3 or newer, and installed Google Chrome:

```powershell
npm.cmd install
npm.cmd test
```

For installed Microsoft Edge instead:

```powershell
$env:PLAYWRIGHT_CHANNEL = "msedge"
npm.cmd test
```

Tests use the app's HTTP API and visible browser controls, with local HTTP camera/Google services standing in for external systems. They use actual Windows credential protection and isolated browser profiles; no real Google account or camera is needed. See [the confirmed TDD boundaries](docs/cloud-saving-tdd-plan.md).

## State and API

Batch metadata and protected authorization live in `%LOCALAPPDATA%\GoProExport`. Set `GOPRO_DATA_DIR` to relocate that app state, or `PORT` to change the default local port. Run one app instance per Windows user/data directory. Closing the app retains work; reopening offers recovery instead of automatically restarting transfers.

- `GET /api/download-jobs` lists saved and unfinished batches.
- `POST /api/download-jobs` starts a batch with `files`, `recordingTimezone`, `downloadRoot`, `stagingRoot`, and `destination` (`type: local` or `google-drive`; Drive also accepts the selected `accountId` and `folderId`).
- `GET /api/download-jobs/:id` reports per-file stages and results.
- `POST /api/download-jobs/:id/pause`, `/resume`, `/retry`, or `/discard` controls recovery.
- `GET /api/cloud/google/status` reports account/folder readiness without credentials; `POST /connect`, `/folder-picker`, `/folder`, and `/disconnect` on the same base manage Google access.

The legacy `POST /api/download` now starts the same durable batch and returns HTTP 202 with a job, rather than a synchronous file list.

## Current limitations

- This is a local offload tool, not a full GoPro control suite.
- Auto-detection is based on the USB IP pattern described in the docs and your machine's network interfaces, so manual IP entry is still available as a fallback.
- Automated camera and Google fixtures pass, but real-camera transfers, real-account uploads, and the desktop folder picker still need the first-account validation described in the setup guide.
