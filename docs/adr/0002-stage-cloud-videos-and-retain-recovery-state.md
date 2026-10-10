---
status: accepted
---

# Stage cloud videos locally and retain recovery state

Cloud saving stages complete original video files locally before upload, persists batch progress, and retains unverified staged originals for recovery after the app restarts. The user accepts the local disk cost in exchange for recoverable uploads that no longer require the camera once staging is complete. Automatically remove a staged original only after the cloud copy's size and checksum have been verified; Pause retains recovery data, while explicit Discard removes temporary files and remaining work, preserving camera originals and completed destination files.
