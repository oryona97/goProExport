# Cloud saving TDD plan

Status: All three seams confirmed by the user and implemented through successive red → green behavior slices. The retained suite covers the HTTP batch seam, Google connector through external service fixtures, and visible browser controls. Live first-account/camera validation is documented in [Google setup](google-drive-setup.md).

The accepted feature is specified in [Cloud saving design](cloud-uploads-design.md). Existing architecture decisions and the glossary govern the behavior.

## Proposed seams

### 1. Batch saving through the app's HTTP API

Use the existing camera connection, media list, status, and download-job APIs, extending download jobs with the selected save destination and recording timezone. Add public pause, resume, retry-failed, discard, and recovery-list operations. Tests submit requests and observe job responses and the actual saved video at the chosen filesystem destination; they never inspect private job storage.

Critical behaviors:

- Original videos reach recording-date folders with their original names; photos and previews cannot be saved.
- Per-file dates, chosen timezone, Unknown date, confirmed duplicate skips, and conflict handling remain consistent.
- Incomplete source reads cannot become saved videos or successful cloud uploads.
- Recovery survives app restarts, preserves the original account and destination, and distinguishes isolated failures from batch-wide pauses.
- Pause, resume, retry, discard, and disk-space behavior follow the accepted rules.

### 2. Google account and destination operations through the app's HTTP API

Expose account status, connect, OAuth callback, disconnect, existing-folder selection, and default-folder creation through public routes. The application uses its real Google connector. Local HTTP services stand in for Google's external OAuth, Drive, and Picker responses; internal modules and collaborators are not mocked.

Critical behaviors:

- Connect starts the system-browser PKCE flow; callbacks must match the pending authorization request.
- Account status exposes identity and readiness without returning credentials.
- Existing authorized folders and the default folder work with My Drive.
- Uploads are resumable, content verification precedes cleanup, and an expired or uncertain session cannot produce an accidental duplicate.
- Reauthorization and switching cannot send an unfinished batch to another account.
- Remembered authorization remains protected for the Windows user and survives reopening.

### 3. The workspace's visible browser interface

Test user actions and visible results: choose a destination and recording timezone, connect an account, choose a folder, queue originals, start a batch, read transfer stages, and use recovery controls. Observe accessible controls and rendered text, not private browser variables or internal functions.

Critical behaviors:

- Saving controls show the selected destination and account before starting.
- Only original videos can enter the saving queue, while video previews remain available for browsing.
- Download, upload, verification, saved, skipped, failed, and paused states remain understandable.
- Recovered staged originals remain actionable even with the camera disconnected.

## Red then green

Use Node's built-in test runner for HTTP behavior and local external-service fixtures. Use browser interaction at the visible UI seam. Production code stays real; mocks are restricted to external systems, such as the camera, Google services, disk capacity, and OS credential protection when a deterministic failure is necessary.

Work one vertical slice at a time: write one behavior test at a confirmed seam, observe its failure, implement only enough to pass, and repeat. Do not write the entire suite before implementation or test private helpers.

The first tracer is an original video saved through the existing job API to its recording-date folder. Follow with source validation and video-only saving, timezone/date edge cases, duplicate/conflict behavior, durable recovery and controls, Google authorization, verified resumable uploads, and the visible workspace flow. Each successive test follows the preceding slice's findings.

Public Google OAuth registration and real-camera/real-account validation are release prerequisites. Deterministic tests can establish behavior without waiting for those external credentials.
