# Cloud saving design

Status: Implemented at all three confirmed public TDD seams. Live first-account and camera validation remain release prerequisites; see [Google setup](google-drive-setup.md).

## Release scope

Each person runs the app locally on Windows with their GoPro connected. Users choose one save destination for each batch: a local folder or Google Drive. Google Drive is the first cloud provider, with a separable upload boundary for future providers.

Save original video files only, preserving each filename and each separate camera chapter. The saving workspace shows videos and retains lightweight video previews for browsing. Photos and previews are not saved. Camera originals remain untouched.

Support personal My Drive first. Users can select an existing destination folder or create the default GoPro Exports folder. One maintained OAuth app registration lets users connect their own Google accounts without configuring developer projects.

## Date folders

Use the same layout for local and cloud saving:

    <chosen destination>/YYYY-MM-DD/<original filename>

- Each file uses its own recording day in the chosen recording timezone. Use the camera-reported creation timestamp, not the import or upload time.
- Default to the PC's timezone, allow a recording-timezone override, and freeze the chosen timezone for the batch. Persist it so reopening on another day or after a PC timezone change cannot change the planned folders.
- Each chapter uses its own recording date. Chapters on opposite sides of midnight can go into different date folders.
- Missing or invalid recording dates go under Unknown date and are flagged in the results.
- Videos sit directly inside each date folder. There are no normal camera or batch subfolders.
- Reuse the applicable date folder for subsequent saves. Retain cloud folder IDs rather than treating names as unique identities.

## Originals, duplicates, and conflicts

When the same original is saved again through the app, skip it only after confirming that the matching destination copy still exists with the expected contents in the intended destination. A historical success record or matching filename alone is insufficient. Cloud comparisons cover files created by or explicitly authorized for the app; broad scanning of unrelated Drive files is outside this scope.

If different originals share a filename in a date folder, preserve both original filenames by putting the new video in a clearly marked conflict subfolder. Never overwrite automatically. Conflict subfolders are the exception to the flat date-folder layout.

## Transfer and temporary storage

Save one video at a time. For local saving, download the original to a partial file, validate completion, and finalize it without overwriting an existing destination file. For cloud saving:

1. Download the complete original to the staging folder.
2. Validate the received byte count against the expected original size before treating it as staged.
3. Upload the staged original to Drive using resumable uploads.
4. Confirm the destination file's size and checksum against the staged original.
5. Mark the video saved and remove its temporary original only after verification succeeds.

Show distinct camera download, cloud upload, and verification states. Upload completion alone does not mean the video has been saved successfully.

Use a dedicated staging folder under the current Windows user's AppData, with an option to select another drive. Check available space before each video and pause if it will not fit. A space check does not reserve storage: disk-write failures must also pause safely. Retained failed uploads can accumulate beyond one video's worth of space and remain available until retry or explicit discard.

## Recovery and failure behavior

- Persist batch progress and offer Resume after the app reopens. A restart must not silently begin new transfers.
- Fully staged originals can upload without the camera. Interrupted camera downloads may restart the affected file.
- Camera-dependent recovery must reconnect the original camera and validate expected source metadata. Missing or changed sources are reported as file failures rather than silently substituting another original.
- Retry transient upload failures. After an isolated file failure, attempt the remaining videos and offer Retry failed afterward.
- Pause for batch-wide problems, including invalid authorization, exhausted cloud storage, insufficient local disk space, or an inaccessible destination.
- Preserve unverified complete staged originals. A size or checksum mismatch cannot trigger successful-save cleanup.
- Persist upload session and destination file identities. If a session expires, recover from the retained original using a new session and reconcile uncertain prior completion to avoid an accidental duplicate.
- Pause / Resume retains recovery data. Discard batch removes that batch's temporary files and remaining work. Completed destination files and camera originals remain.
- A saved file moved, deleted, or made inaccessible by the user is not repaired in the background. An explicitly requested repeated save must re-confirm the intended destination copy.

## Accounts and authorization

Remember one Google account per Windows user, display its email, and provide Disconnect / Switch account controls. Unfinished cloud batches include paused work and failed files retained for recovery: those batches must be completed or discarded before switching accounts. Reauthorization must reconnect the original account, and recovery must retain the original destination folder identity.

Use Google's desktop OAuth flow with PKCE, a system browser, and a loopback callback. Request limited drive.file authorization and use Google's desktop folder-selection flow for existing folders. Account information and quota are available through the authorized Drive API.

Protect remembered credentials for the current Windows user. Access tokens, refresh tokens, and resumable-upload credentials stay out of logs and the browser UI. Disconnect stops cloud work and removes locally remembered authorization while retaining pending work under the existing recovery/discard rules.

## Implementation boundaries

The save coordinator owns durable batch state, source integrity, selected destinations, date grouping, temporary files, retries, and recovery. Cloud-provider adapters own provider authorization, folder/file identities, resumable upload operations, and destination verification. This keeps Google-specific behavior at the upload boundary.

Durable metadata must include original filename and directory, creation timestamp, expected size, original camera identity, chosen recording timezone, resolved date folder, destination type and root, cloud account identity when applicable, content identity, and file progress. Persist identities before operations whose completion may become uncertain after a crash.

The existing app needs changes beyond adding an upload call: current download jobs live in memory, discard creation timestamps when submitted, identify their source camera by IP, write directly to final paths, and do not compare completed download bytes with the expected original size.

## Verification and release prerequisites

Implementation verification must cover date conversion and timezone snapshots, midnight chapter separation, Unknown date, confirmed duplicate skips, filename conflicts, complete source reads, interrupted transfer recovery, expired sessions, isolated and batch-wide failures, disk exhaustion, and account-switch restrictions.

Before public release, configure the maintained Google OAuth registration for production and complete the applicable public verification requirements. Validate secure Windows credential storage, real-camera transfers, real-account resumable uploads and checksums, and existing-folder selection with limited authorization.

There are no unresolved product decisions. The confirmed public test boundaries and implementation slices are recorded in [the TDD plan](cloud-saving-tdd-plan.md).

## Architecture decisions and terminology

- [Glossary](../GLOSSARY.md)
- [0001: Run the app locally for each user](adr/0001-run-locally-per-user.md)
- [0002: Stage cloud videos locally and retain recovery state](adr/0002-stage-cloud-videos-and-retain-recovery-state.md)
- [0003: Organize both destinations by recording date](adr/0003-organize-by-recording-date.md)

## Sources

- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Picker for desktop and mobile apps](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)
- [Google Drive file metadata and checksums](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [OAuth verification requirements](https://support.google.com/cloud/answer/13464321)
- [Google Drive user information and quota](https://developers.google.com/workspace/drive/api/guides/user-info)
- [Google Drive error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [GoPro SDK camera information and media fields](https://gopro.github.io/OpenGoPro/python_sdk/api.html)
- [Windows user-bound credential protection](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

