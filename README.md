# GoPro USB Footage App

This is a small local Node app for browsing and downloading GoPro media over a USB-C cable from your PC.

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
- Streams low-resolution previews before download:
  - videos use the GoPro proxy `.LRV` file when available
  - photos use the GoPro screennail / thumbnail endpoints
- Downloads selected footage to your PC
- Shows download progress for the whole queue and the current file

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
cmd /c npm start
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
7. Download selected files or everything.

## Current limitations

- This is a local offload tool, not a full GoPro control suite.
- Auto-detection is based on the USB IP pattern described in the docs and your machine's network interfaces, so manual IP entry is still available as a fallback.
- I could not verify against a real connected camera in this environment, so the live device path still needs on-hardware testing.
