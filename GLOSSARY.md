# GoPro Footage Saving

The language used to describe saving original GoPro videos to a location chosen by the user.

## Language

**Original video**:
A video file recorded by the camera in its original form. Photos and lightweight preview files are not original videos.
_Avoid_: Preview, proxy

**Save destination**:
The location chosen by the user to receive an original video, either on their computer or in cloud storage.
_Avoid_: Download root (when referring to cloud storage)

**Cloud provider**:
A service that stores the user's videos in their connected cloud account. Google Drive is the first supported cloud provider.

**Connected cloud account**:
An account whose owner has authorized the app to save videos with a cloud provider.
_Avoid_: Subscription (when referring to authorization)

**Save batch**:
A group of original video files the user starts saving together to one chosen destination. That destination stays fixed for the batch.
_Avoid_: Backup job

**Camera chapter**:
An original video file containing one part of a recording that the camera split across multiple files. Each chapter is saved separately with its original filename.
_Avoid_: Merged recording

**Staged original**:
A complete temporary copy of an original video retained while cloud saving has not yet been verified.
_Avoid_: Saved video (before verification)

**Verified cloud copy**:
A cloud copy confirmed to contain the complete original video unchanged. It establishes that the original has been saved to the cloud destination.
_Avoid_: Upload started, preview ready

**Recording date**:
The calendar day on which an original video was recorded, interpreted in the batch's chosen recording timezone.
_Avoid_: Import date, upload date

**Recording timezone**:
The timezone chosen to determine the recording dates of original videos in a save batch.
_Avoid_: Upload timezone

**Date folder**:
A destination folder containing original videos recorded on the same day.
_Avoid_: Batch folder

**Filename conflict**:
Different original videos intended for the same date folder that share an original filename.
_Avoid_: Duplicate (when the contents differ)

**Unknown date**:
The destination grouping for original videos whose recording date is missing or invalid.
_Avoid_: Today's date (as a substitute for an unknown recording date)
