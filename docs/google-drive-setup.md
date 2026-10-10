# Google Drive setup

One maintainer-owned Google project supplies the Desktop OAuth client for every installation. Each person runs the app locally and authorizes their own My Drive. A paid Drive plan supplies storage; it does not replace the app's OAuth registration.

## Configure the app once

1. In your Google Cloud project, enable **Google Drive API** and **Google Picker API**.
2. Configure Google Auth platform branding and audience for the app. For your first account, keep the app in Testing and add your Google email as a test user.
3. Create an OAuth client with the **Desktop app** application type. Download its client JSON.
4. Save the downloaded JSON as `google-oauth.json` in the app's root directory, alongside `server.js`. The expected shape is shown in [`google-oauth.example.json`](../google-oauth.example.json). Do not use a Web application client or enter user access/refresh tokens in this file.
5. Restart the app. **Google Drive** should now offer **Connect Google Drive**.

For another configuration location, set `GOPRO_GOOGLE_CONFIG` to the JSON file's path. Environment variables `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` take priority when a client ID is supplied. The app does not read `.env` files.

```powershell
$env:GOPRO_GOOGLE_CONFIG = "C:\path\to\desktop-client.json"
npm.cmd start
```

The app opens Windows' default browser, uses PKCE and a one-time state value, and receives the callback at `http://127.0.0.1:<app port>/oauth/google/callback`. The folder picker runs as part of Google's consent flow. No separate browser API key or web Picker widget is used. Google's [desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [desktop Picker guide](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker) describe these flows.

The only requested scope is `https://www.googleapis.com/auth/drive.file`. Duplicate checks cover app-created files and files explicitly authorized for the app; unrelated Drive files and all descendants of a selected existing folder are not assumed to be visible. See [Google's scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Validate your Drive first

1. Connect your account and create **GoPro Exports**, then save one short original video from the camera. Check the account email and chosen folder before starting.
2. Confirm that the video appears directly under its recording-date folder with the original name, opens correctly in Drive, and reaches **Save complete**. Check that its temporary original was removed.
3. Save it again and confirm **Skipped**. Select an existing writable My Drive folder and verify the same date-folder layout there.
4. Upload a larger video, pause it during upload, reopen the app, disconnect the camera, and resume from the retained original. Confirm there is one final video rather than two.
5. Test a pair of chapters across midnight with the correct recording timezone. Check missing dates, a repeated filename with different contents, and Retry failed after an interrupted source read.
6. Disconnect Google with unfinished work. Reconnect the original account and resume. Confirm switching to another account is rejected until all unfinished cloud work is completed or discarded.

The automated tests exercise these behaviors using external service fixtures. They do not establish compatibility with your live Google project or GoPro firmware. Windows credential protection is exercised directly by the tests; saved credentials and upload sessions are bound to the Windows user and machine.

## Distribute to other users

Supply the shared Desktop OAuth client configuration with the installation so users only need to click Connect. Desktop clients cannot keep a client value confidential; user authorization tokens are separate and are protected locally. The runtime JSON is ignored by Git to avoid accidentally publishing your project configuration in this checkout.

Before public distribution, finish the production audience/branding configuration and any applicable Google verification requirements. Testing authorization can have user and token-lifetime limits; do not distribute a Testing-only registration as a production experience. Follow [Google's verification guidance](https://support.google.com/cloud/answer/13464321).

This version supports My Drive on Windows. It does not upload photos or preview files, use shared drives, or delete camera originals. Recoverable staged videos remain on disk until successful verification or explicit discard.
