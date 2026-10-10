const state = {
  session: null,
  media: [],
  selectedPaths: new Set(),
  docs: [],
  candidates: [],
  preview: {
    file: null,
    status: "idle",
    objectUrl: null,
    streamUrl: null,
    error: null
  },
  pendingQueue: [],
  queueSequence: 0,
  downloadJob: null,
  downloadPollTimer: null,
  downloadCenterCollapsed: false,
  recoverableJobs: [],
  google: null,
  authorizationPollTimer: null
};

const ASSET_VERSION = Date.now();
const DOWNLOAD_ROOT_STORAGE_KEY = "gopro.downloadRoot";
const DOWNLOAD_CENTER_COLLAPSED_STORAGE_KEY = "gopro.downloadCenterCollapsed";

const els = {
  docsGrid: document.querySelector("#docs-grid"),
  candidateList: document.querySelector("#candidate-list"),
  sessionSummary: document.querySelector("#session-summary"),
  activityLog: document.querySelector("#activity-log"),
  mediaBody: document.querySelector("#media-body"),
  cameraIp: document.querySelector("#camera-ip"),
  serialSuffix: document.querySelector("#serial-suffix"),
  downloadRoot: document.querySelector("#download-root"),
  saveDestination: document.querySelector("#save-destination"),
  recordingTimezone: document.querySelector("#recording-timezone"),
  stagingRoot: document.querySelector("#staging-root"),
  googleSettings: document.querySelector("#google-settings"),
  googleAccount: document.querySelector("#google-account"),
  googleFolder: document.querySelector("#google-folder"),
  googleStatus: document.querySelector("#google-status"),
  googleConnect: document.querySelector("#google-connect"),
  googleDisconnect: document.querySelector("#google-disconnect"),
  googlePicker: document.querySelector("#google-picker"),
  googleDefaultFolder: document.querySelector("#google-default-folder"),
  googleCancel: document.querySelector("#google-cancel"),
  selectAll: document.querySelector("#select-all"),
  mediaSearch: document.querySelector("#media-search"),
  mediaType: document.querySelector("#media-type"),
  selectionCount: document.querySelector("#selection-count"),
  heroConnection: document.querySelector("#hero-connection"),
  heroDownloadRoot: document.querySelector("#hero-download-root"),
  heroMediaCount: document.querySelector("#hero-media-count"),
  connectForm: document.querySelector("#connect-form"),
  discoverBtn: document.querySelector("#discover-btn"),
  disconnectBtn: document.querySelector("#disconnect-btn"),
  refreshMediaBtn: document.querySelector("#refresh-media-btn"),
  downloadSelectedBtn: document.querySelector("#download-selected-btn"),
  downloadAllBtn: document.querySelector("#download-all-btn"),
  downloadCenterPanel: document.querySelector("#download-center-panel"),
  downloadCenterShell: document.querySelector("#download-center-shell"),
  downloadCenterToggle: document.querySelector("#download-center-toggle"),
  downloadCenterFloatingToggle: document.querySelector("#download-center-floating-toggle"),
  downloadStatusCard: document.querySelector("#download-status-card"),
  downloadBadge: document.querySelector("#download-badge"),
  queueCountPill: document.querySelector("#queue-count-pill"),
  foldedFileName: document.querySelector("#folded-file-name"),
  foldedFileMeta: document.querySelector("#folded-file-meta"),
  foldedStatus: document.querySelector("#folded-status"),
  foldedDownloaded: document.querySelector("#folded-downloaded"),
  foldedCompleted: document.querySelector("#folded-completed"),
  foldedSpeed: document.querySelector("#folded-speed"),
  foldedEta: document.querySelector("#folded-eta"),
  downloadHeadline: document.querySelector("#download-headline"),
  downloadInlineMeta: document.querySelector("#download-inline-meta"),
  overallProgressFill: document.querySelector("#overall-progress-fill"),
  overallProgressText: document.querySelector("#overall-progress-text"),
  currentProgressFill: document.querySelector("#current-progress-fill"),
  currentProgressText: document.querySelector("#current-progress-text"),
  statTotalFiles: document.querySelector("#stat-total-files"),
  statCompletedFiles: document.querySelector("#stat-completed-files"),
  statTransferred: document.querySelector("#stat-transferred"),
  statDownloadRoot: document.querySelector("#stat-download-root"),
  currentFileName: document.querySelector("#current-file-name"),
  currentFileMeta: document.querySelector("#current-file-meta"),
  activeJobList: document.querySelector("#active-job-list"),
  downloadSummary: document.querySelector("#download-summary"),
  startQueueBtn: document.querySelector("#start-queue-btn"),
  resumeBatchBtn: document.querySelector("#resume-batch-btn"),
  pauseBatchBtn: document.querySelector("#pause-batch-btn"),
  discardBatchBtn: document.querySelector("#discard-batch-btn"),
  retryBatchBtn: document.querySelector("#retry-batch-btn"),
  recoverySettings: document.querySelector("#recovery-settings"),
  recoveryBatch: document.querySelector("#recovery-batch"),
  clearQueueBtn: document.querySelector("#clear-queue-btn"),
  queueTitle: document.querySelector("#queue-title"),
  queueSummary: document.querySelector("#queue-summary"),
  queueList: document.querySelector("#queue-list"),
  previewTitle: document.querySelector("#preview-title"),
  previewBody: document.querySelector("#preview-body"),
  previewMeta: document.querySelector("#preview-meta"),
  previewDownloadBtn: document.querySelector("#preview-download-btn")
};

window.addEventListener("DOMContentLoaded", async () => {
  restoreDownloadRoot();
  els.recordingTimezone.value = localStorage.getItem("gopro.recordingTimezone") || Intl.DateTimeFormat().resolvedOptions().timeZone;
  els.stagingRoot.value = localStorage.getItem("gopro.stagingRoot") || "";
  restoreDownloadCenterCollapsed();
  wireEvents();
  renderPreview();
  renderDownloadJob();
  renderPendingQueue();
  await runUiTask(async () => {
    await Promise.all([loadDocs(), refreshStatus(), refreshGoogleStatus()]);
  });
});

window.addEventListener("beforeunload", () => {
  stopDownloadPolling();
  revokePreviewObjectUrl();
  clearInterval(state.authorizationPollTimer);
});

function wireEvents() {
  els.googleCancel.addEventListener('click', () => runUiTask(async () => {
    await api('/api/cloud/google/cancel-authorization', { method: 'POST', body: {} });
    await refreshGoogleStatus();
  }));
  els.saveDestination.addEventListener("change", () => { renderSavingPreferences(); renderPendingQueue(); });
  els.stagingRoot.addEventListener("change", () => localStorage.setItem("gopro.stagingRoot", els.stagingRoot.value.trim()));
  els.googleConnect.addEventListener("click", () => { void runUiTask(() => authorizeGoogle(false)); });
  els.googlePicker.addEventListener("click", () => { void runUiTask(() => authorizeGoogle(true)); });
  els.googleDefaultFolder.addEventListener("click", () => { void runUiTask(async () => {
    els.googleDefaultFolder.disabled = true;
    try { await api("/api/cloud/google/folder", { method: "POST", body: {} }); }
    finally { await refreshGoogleStatus(); }
  }); });
  els.googleDisconnect.addEventListener("click", () => { void runUiTask(async () => {
    await api("/api/cloud/google/disconnect", { method: "POST", body: {} });
    await refreshGoogleStatus();
  }); });
  els.recordingTimezone.addEventListener("change", () => localStorage.setItem("gopro.recordingTimezone", els.recordingTimezone.value.trim()));
  if (els.connectForm) {
    els.connectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void runUiTask(connectCamera);
    });
  }

  if (els.discoverBtn) {
    els.discoverBtn.addEventListener("click", () => {
      void runUiTask(() => refreshCandidates(true));
    });
  }

  if (els.disconnectBtn) {
    els.disconnectBtn.addEventListener("click", () => {
      void runUiTask(disconnectCamera);
    });
  }

  els.refreshMediaBtn.addEventListener("click", () => {
    void runUiTask(async () => {
      els.refreshMediaBtn.disabled = true;
      els.refreshMediaBtn.textContent = "Refreshing…";
      try { await refreshMedia(); }
      finally {
        els.refreshMediaBtn.disabled = false;
        els.refreshMediaBtn.textContent = "Refresh list";
      }
    });
  });

  els.downloadSelectedBtn.addEventListener("click", () => {
    void runUiTask(queueSelected);
  });

  els.downloadAllBtn.addEventListener("click", () => {
    void runUiTask(() => addFilesToQueue(state.media, "browser"));
  });

  els.previewDownloadBtn.addEventListener("click", () => {
    if (!state.preview.file) {
      appendLog("Preview a file first.");
      return;
    }

    void runUiTask(() => addFilesToQueue([state.preview.file], "preview"));
  });

  els.startQueueBtn.addEventListener("click", () => {
    void runUiTask(startPendingQueueDownload);
  });

  els.clearQueueBtn.addEventListener("click", () => {
    clearPendingQueue();
  });

  if (els.downloadCenterToggle) {
    els.downloadCenterToggle.addEventListener("click", () => {
      setDownloadCenterCollapsed(!state.downloadCenterCollapsed);
    });
  }

  if (els.downloadCenterFloatingToggle) {
    els.downloadCenterFloatingToggle.addEventListener("click", () => {
      setDownloadCenterCollapsed(false);
    });
  }

  els.selectAll.addEventListener("change", () => {
    document.querySelectorAll(".row-selector").forEach((checkbox) => {
      checkbox.checked = els.selectAll.checked;
      if (checkbox.checked) state.selectedPaths.add(checkbox.dataset.path);
      else state.selectedPaths.delete(checkbox.dataset.path);
    });
    renderSelection();
  });

  els.mediaSearch.addEventListener("input", renderMedia);
  els.mediaType.addEventListener("change", renderMedia);
  els.mediaBody.addEventListener("change", (event) => {
    if (!event.target.matches(".row-selector")) return;
    if (event.target.checked) state.selectedPaths.add(event.target.dataset.path);
    else state.selectedPaths.delete(event.target.dataset.path);
    renderSelection();
  });

  els.downloadRoot.addEventListener("input", () => {
    const value = els.downloadRoot.value.trim() || "./downloads";
    els.heroDownloadRoot.textContent = value;
    persistDownloadRoot(value);
    if (!state.downloadJob) {
      renderDownloadJob();
    }
    renderPendingQueue();
  });
}

async function loadDocs() {
  if (!els.docsGrid) {
    return;
  }

  const response = await api("/api/docs");
  state.docs = response.docs || [];
  renderDocs();
}

async function refreshGoogleStatus() {
  state.google = await api("/api/cloud/google/status");
  renderSavingPreferences();
  renderPendingQueue();
}

function renderSavingPreferences() {
  const cloud = els.saveDestination.value === "google-drive";
  els.googleSettings.hidden = !cloud;
  document.querySelector("#local-folder-settings").hidden = cloud;
  const google = state.google;
  els.googleCancel.hidden = !google?.authorizationPending;
  els.googleAccount.textContent = google?.account?.email || "Not connected";
  els.googleFolder.textContent = google?.folder?.name || "Choose a folder";
  els.googleConnect.textContent = google?.connected ? google.canSwitch ? "Switch account" : "Reconnect original account" : "Connect Google Drive";
  els.googleConnect.disabled = !google?.configured || google?.authorizationPending;
  els.googleDisconnect.hidden = !google?.connected;
  els.googleDisconnect.disabled = google?.authorizationPending;
  els.googlePicker.disabled = !google?.connected || google?.authorizationPending;
  els.googleDefaultFolder.disabled = !google?.connected || google?.authorizationPending;
  els.googleStatus.textContent = google?.error || (!google?.configured ? "Google Drive is unavailable in this installation. Local saving is ready." : google.authorizationPending ? "Complete Google sign-in in the browser." : google.connected && !google.canSwitch ? "Complete or discard unfinished cloud batches before switching accounts." : google.connected ? "Choose your destination folder. Temporary copies are removed after verified uploads." : "Connect your Google account to save original videos.");
}

async function authorizeGoogle(selectFolder) {
  const popup = window.open("about:blank", "gopro-google-authorization");
  try {
    const response = await api(selectFolder ? "/api/cloud/google/folder-picker" : "/api/cloud/google/connect", { method: "POST", body: {} });
    if (response.browserOpened) popup?.close();
    else if (popup) popup.location.href = response.authorizationUrl;
    else throw new Error("Allow the Google sign-in window, then try again.");
    await refreshGoogleStatus();
    clearInterval(state.authorizationPollTimer);
    state.authorizationPollTimer = window.setInterval(() => {
      void runUiTask(async () => {
        await refreshGoogleStatus();
        if (!state.google.authorizationPending) clearInterval(state.authorizationPollTimer);
      });
    }, 400);
  } catch (error) { popup?.close(); throw error; }
}

async function refreshStatus() {
  const response = await api("/api/status");
  state.session = response.session;
  state.candidates = response.candidates || [];
  state.recoverableJobs = response.recoverableJobs || [];
  if (response.activeDownloadJob?.destination.type === 'google-drive') {
    els.saveDestination.value = 'google-drive';
    renderSavingPreferences();
  }
  setDownloadJob(response.activeDownloadJob || null, {
    logTransitions: false
  });
  renderSession();
  renderCandidates();
  renderPendingQueue();

  if (state.downloadJob && isDownloadActive()) {
    startDownloadPolling(state.downloadJob.id);
  }

  if (state.session) {
    appendLog(`Connected to ${state.session.cameraName || state.session.ip}.`);
    await refreshMedia(false);
  } else {
    state.media = [];
    state.pendingQueue = [];
    clearPreview();
    renderMedia();
    renderPendingQueue();
    renderDownloadJob();
    if (!state.downloadJob) redirectToHome();
  }
}

async function refreshCandidates(userInitiated = false) {
  const response = await api("/api/discover");
  state.candidates = response.candidates || [];
  renderCandidates();

  if (userInitiated) {
    if (state.candidates.length) {
      appendLog(`Found ${state.candidates.length} possible GoPro USB address${state.candidates.length === 1 ? "" : "es"}.`);
    } else {
      appendLog("No likely GoPro USB interface was detected yet.");
    }
  }
}

async function connectCamera() {
  const payload = {
    ip: els.cameraIp.value.trim(),
    serialSuffix: els.serialSuffix.value.trim()
  };

  persistDownloadRoot(els.downloadRoot.value.trim() || "./downloads");
  appendLog("Connecting to GoPro over USB...");

  const response = await api("/api/connect", {
    method: "POST",
    body: payload
  });

  state.session = response.session;
  renderSession();
  appendLog(`Connected to ${state.session.cameraName || state.session.ip}. Wired USB control is active.`);
  await refreshMedia();
}

async function disconnectCamera() {
  if (isDownloadActive()) {
    appendLog("Wait for the active download to finish before disconnecting.");
    return;
  }

  await api("/api/disconnect", {
    method: "POST",
    body: {}
  });

  state.session = null;
  state.media = [];
  state.pendingQueue = [];
  clearPreview();
  renderSession();
  renderMedia();
  renderPendingQueue();
  renderDownloadJob();
  appendLog("Disconnected from the GoPro session.");
  redirectToHome();
}

async function refreshMedia(logResult = true) {
  if (!state.session) {
    state.media = [];
    clearPreview();
    renderMedia();
    return;
  }

  const response = await api("/api/media");
  state.media = response.files || [];
  const availablePaths = new Set(state.media.map((file) => file.path));
  state.selectedPaths.forEach((filePath) => {
    if (!availablePaths.has(filePath)) state.selectedPaths.delete(filePath);
  });
  syncPreviewSelection();
  renderMedia();

  if (logResult) {
    appendLog(`Loaded ${response.count} file${response.count === 1 ? "" : "s"} from the camera.`);
  }
}

async function queueSelected() {
  const selected = getSelectedFiles();
  if (!selected.length) {
    appendLog("Select at least one file first.");
    return;
  }

  await addFilesToQueue(selected, "selection");
}

async function startPendingQueueDownload() {
  if (!state.session) {
    appendLog("Connect to a GoPro first.");
    return;
  }

  if (isDownloadActive()) {
    appendLog("Finish the current batch before starting the next queue.");
    return;
  }

  if (!state.pendingQueue.length) {
    appendLog("Queue at least one file before starting the download.");
    return;
  }

  const batch = state.pendingQueue.map((item) => ({ ...item }));
  appendLog(`Starting queue with ${batch.length} file${batch.length === 1 ? "" : "s"}...`);

  const response = await api("/api/download-jobs", {
    method: "POST",
    body: {
      downloadRoot: els.downloadRoot.value.trim(),
      destination: { type: els.saveDestination.value, ...(els.saveDestination.value === 'google-drive' ? { accountId: state.google?.account?.id, folderId: state.google?.folder?.id } : {}) },
      stagingRoot: els.stagingRoot.value.trim(),
      recordingTimezone: els.recordingTimezone.value.trim(),
      files: batch.map((item) => ({
        directory: item.directory,
        name: item.name,
        sizeBytes: item.sizeBytes
      }))
    }
  });

  state.pendingQueue = [];
  setDownloadJob(response.job, {
    logTransitions: false
  });
  renderPendingQueue();
  renderDownloadJob();
  startDownloadPolling(response.job.id);
  await refreshGoogleStatus();
}

async function addFilesToQueue(files, sourceLabel) {
  if (!state.session) {
    appendLog("Connect to a GoPro first.");
    return;
  }

  if (!files.length) {
    appendLog("There are no files to queue yet.");
    return;
  }

  let added = 0;
  let skipped = 0;

  for (const file of files) {
    if (!file || !file.path) {
      skipped += 1;
      continue;
    }

    if (isQueuedOrActive(file.path)) {
      skipped += 1;
      continue;
    }

    state.queueSequence += 1;
    state.pendingQueue.push(createQueueItem(file, state.queueSequence));
    added += 1;
  }

  renderPendingQueue();
  renderDownloadJob();

  if (added) {
    appendLog(`Added ${added} file${added === 1 ? "" : "s"} to the ${sourceLabel === "preview" ? "preview" : "download"} queue.`);
  }
  if (skipped) {
    appendLog(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that were already queued or already part of the active batch.`);
  }
}

function createQueueItem(file, sequence) {
  return {
    id: `queue-${sequence}`,
    path: file.path,
    directory: file.directory,
    name: file.name,
    sizeBytes: Number(file.sizeBytes || 0),
    type: file.type,
    createdUnix: Number(file.createdUnix || 0)
  };
}

function isQueuedOrActive(filePath) {
  return state.pendingQueue.some((item) => item.path === filePath) || isPathInActiveJob(filePath);
}

function isPathInActiveJob(filePath) {
  if (!state.downloadJob || !isDownloadActive()) {
    return false;
  }

  return (state.downloadJob.files || []).some((item) => `${item.directory}/${item.name}` === filePath);
}

function clearPendingQueue() {
  if (!state.pendingQueue.length) {
    return;
  }

  const removedCount = state.pendingQueue.length;
  state.pendingQueue = [];
  renderPendingQueue();
  renderDownloadJob();
  appendLog(`Cleared ${removedCount} queued file${removedCount === 1 ? "" : "s"}.`);
}

function removeQueueItem(itemId) {
  const before = state.pendingQueue.length;
  state.pendingQueue = state.pendingQueue.filter((item) => item.id !== itemId);
  if (state.pendingQueue.length !== before) {
    renderPendingQueue();
    renderDownloadJob();
  }
}

function moveQueueItem(itemId, direction) {
  const index = state.pendingQueue.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return;
  }

  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.pendingQueue.length) {
    return;
  }

  const nextQueue = [...state.pendingQueue];
  const [item] = nextQueue.splice(index, 1);
  nextQueue.splice(targetIndex, 0, item);
  state.pendingQueue = nextQueue;
  renderPendingQueue();
  renderDownloadJob();
}

async function pollDownloadJob(jobId) {
  const response = await api(`/api/download-jobs/${encodeURIComponent(jobId)}`);
  setDownloadJob(response.job, {
    logTransitions: true
  });

  if (!isDownloadActive()) {
    stopDownloadPolling();
    await refreshGoogleStatus();
    await refreshRecoveries();
  }
}

async function refreshRecoveries() {
  const response = await api('/api/download-jobs');
  state.recoverableJobs = response.jobs.filter(job => ['paused', 'failed', 'completed_with_errors'].includes(job.status));
  renderDownloadJob();
}

function startDownloadPolling(jobId) {
  stopDownloadPolling();

  state.downloadPollTimer = window.setInterval(() => {
    void runUiTask(() => pollDownloadJob(jobId));
  }, 700);
}

function stopDownloadPolling() {
  if (state.downloadPollTimer) {
    window.clearInterval(state.downloadPollTimer);
    state.downloadPollTimer = null;
  }
}

function setDownloadJob(job, options = {}) {
  const previousStatus = state.downloadJob ? state.downloadJob.status : null;
  state.downloadJob = job;
  renderDownloadJob();
  renderPendingQueue();

  if (!job || !options.logTransitions || previousStatus === job.status) {
    return;
  }

  if (job.status === "completed") {
    appendLog(`Saved ${job.completedFiles} video${job.completedFiles === 1 ? "" : "s"} to ${destinationLabel(job)}.`);
  } else if (job.status === "failed") {
    appendLog(`Download failed: ${job.error || "Unknown error"}`);
  }
}

async function previewFile(filePath) {
  const file = state.media.find((item) => item.path === filePath);
  if (!file) {
    appendLog("That file is no longer in the loaded media list.");
    return;
  }

  if (!file.preview || !file.preview.available || !file.preview.url) {
    appendLog(`No preview is available for ${file.name}.`);
    return;
  }

  if (state.preview.file && state.preview.file.path === file.path && state.preview.status === "ready") {
    renderPreview();
    return;
  }

  resetPreviewMediaState();
  state.preview = {
    file,
    status: "loading",
    objectUrl: null,
    streamUrl: null,
    error: null
  };
  renderPreview();

  if (file.preview.kind === "video") {
    state.preview.streamUrl = buildPreviewStreamUrl(file.preview.url);
    renderPreview();
    appendLog(`Streaming preview for ${file.name}.`);
    return;
  }

  try {
    const response = await fetch(file.preview.url, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const blob = await response.blob();
    state.preview = {
      file,
      status: "ready",
      objectUrl: URL.createObjectURL(blob),
      streamUrl: null,
      error: null
    };
    renderPreview();
    appendLog(`Loaded preview for ${file.name}.`);
  } catch (error) {
    state.preview = {
      file,
      status: "error",
      objectUrl: null,
      streamUrl: null,
      error: error instanceof Error ? error.message : String(error)
    };
    renderPreview();
  }
}

function getSelectedFiles() {
  return state.media.filter((file) => state.selectedPaths.has(file.path));
}

function getVisibleMedia() {
  const query = els.mediaSearch.value.trim().toLowerCase();
  const type = els.mediaType.value;
  return state.media.filter((file) => {
    const typeMatches = type === "all" || (type === "Other" ? !["Photo", "Video"].includes(file.type) : file.type === type);
    return typeMatches && (!query || `${file.name} ${file.directory}`.toLowerCase().includes(query));
  });
}

function renderSelection() {
  const visible = getVisibleMedia();
  const selectedVisible = visible.filter((file) => state.selectedPaths.has(file.path)).length;
  const count = getSelectedFiles().length;
  els.selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  els.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  els.selectAll.disabled = !visible.length;
  els.selectionCount.textContent = `${count} selected`;
  els.downloadSelectedBtn.disabled = !count || !state.session;
  els.downloadAllBtn.disabled = !state.media.length || !state.session;
}

function renderDocs() {
  if (!els.docsGrid) {
    return;
  }

  els.docsGrid.innerHTML = "";

  for (const doc of state.docs) {
    const card = document.createElement("article");
    card.className = "doc-card";
    card.innerHTML = `
      <h3>${escapeHtml(doc.title)}</h3>
      <p>${escapeHtml(doc.detail)}</p>
    `;
    els.docsGrid.appendChild(card);
  }
}

function renderCandidates() {
  if (!els.candidateList) {
    return;
  }

  if (!state.candidates.length) {
    els.candidateList.innerHTML = `<div class="candidate-empty">No likely USB candidate detected yet.</div>`;
    return;
  }

  els.candidateList.innerHTML = "";
  state.candidates.forEach((candidate) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-chip";
    button.innerHTML = `
      <strong>${escapeHtml(candidate.ip)}</strong>
      <span>${escapeHtml(candidate.hostAddress)} via ${escapeHtml(candidate.source)}</span>
    `;
    button.addEventListener("click", () => {
      if (els.cameraIp) {
        els.cameraIp.value = candidate.ip;
      }
      appendLog(`Filled camera IP with detected candidate ${candidate.ip}.`);
    });
    els.candidateList.appendChild(button);
  });
}

function renderSession() {
  els.heroDownloadRoot.textContent = els.downloadRoot.value.trim() || "./downloads";

  if (!state.session) {
    if (els.sessionSummary) {
      els.sessionSummary.innerHTML = "No active session.";
    }
    els.heroConnection.textContent = "Not connected";
    els.heroMediaCount.textContent = `${state.media.length} files`;
    return;
  }

  els.heroConnection.textContent = state.session.cameraName || state.session.ip;
  els.heroMediaCount.textContent = `${state.media.length} file${state.media.length === 1 ? "" : "s"}`;

  if (els.sessionSummary) {
    els.sessionSummary.innerHTML = `
      <div class="session-line"><strong>Target:</strong> ${escapeHtml(state.session.ip)}</div>
      <div class="session-line"><strong>Source:</strong> ${escapeHtml(state.session.source || "Unknown")}</div>
      <div class="session-line"><strong>Name:</strong> ${escapeHtml(state.session.cameraName || "Unknown")}</div>
      <div class="session-line"><strong>Version:</strong> ${escapeHtml(state.session.version || "Unknown")}</div>
      <div class="session-line"><strong>Connected:</strong> ${formatTimestamp(state.session.connectedAt)}</div>
      <div class="session-line"><strong>Keep alive:</strong> ${state.session.lastKeepAliveError ? escapeHtml(state.session.lastKeepAliveError) : "Healthy"}</div>
      ${state.session.controlWarning ? `<div class="session-line warning"><strong>Control note:</strong> ${escapeHtml(state.session.controlWarning)}</div>` : ""}
    `;
  }
}

function renderMedia() {
  els.heroMediaCount.textContent = `${state.media.length} file${state.media.length === 1 ? "" : "s"}`;
  const visibleMedia = getVisibleMedia();
  renderSelection();

  if (!state.media.length) {
    els.mediaBody.innerHTML = `<tr><td colspan="8" class="empty-state">${state.session ? "No media returned by the camera yet." : "Connect to a camera to load media."}</td></tr>`;
    return;
  }

  if (!visibleMedia.length) {
    els.mediaBody.innerHTML = '<tr><td colspan="8" class="empty-state">No matching footage. Try another search or choose All media.</td></tr>';
    return;
  }

  els.mediaBody.innerHTML = visibleMedia
    .map((file) => {
      const isActivePreview = Boolean(state.preview.file && state.preview.file.path === file.path);
      const thumbnailUrl = buildMediaThumbnailUrl(file);

      return `
        <tr class="${isActivePreview ? "is-active-row" : ""}">
          <td><input class="row-selector" type="checkbox" aria-label="Select ${escapeHtml(file.name)}" data-path="${escapeHtml(file.path)}" ${state.selectedPaths.has(file.path) ? "checked" : ""}></td>
          <td>
            ${thumbnailUrl ? `<img class="media-thumb" src="${escapeHtml(thumbnailUrl)}" alt="Thumbnail for ${escapeHtml(file.name)}" loading="lazy" data-fallback-label="${escapeHtml(file.type.slice(0, 1) || "?")}">` : `<div class="media-thumb media-thumb-empty">${escapeHtml(file.type.slice(0, 1) || "?")}</div>`}
          </td>
          <td>${escapeHtml(file.name)}</td>
          <td>${escapeHtml(file.type)}</td>
          <td>${escapeHtml(file.directory)}</td>
          <td>${formatBytes(file.sizeBytes)}</td>
          <td>${formatUnix(file.createdUnix)}</td>
          <td>
            <button class="ghost-button preview-action" type="button" aria-label="Preview ${escapeHtml(file.name)}" data-path="${escapeHtml(file.path)}" ${file.preview && file.preview.available ? "" : "disabled"}>
              ${file.preview && file.preview.available ? "Preview" : "Unavailable"}
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll(".preview-action").forEach((button) => {
    button.addEventListener("click", () => {
      void runUiTask(() => previewFile(button.dataset.path));
    });
  });

  wireThumbnailFallbacks();
}

function renderPreview() {
  const preview = state.preview;
  els.previewDownloadBtn.disabled = !preview.file;

  if (!preview.file) {
    els.previewTitle.textContent = "Select a file";
    els.previewBody.className = "preview-body is-empty";
    els.previewBody.innerHTML = `Choose a video and click <strong>Preview</strong> to inspect a lightweight version before saving the original.`;
    els.previewMeta.innerHTML = "";
    return;
  }

  const file = preview.file;
  const previewLabel = file.preview && file.preview.label ? file.preview.label : "Preview";
  els.previewTitle.textContent = `${file.name}`;

  if (preview.status === "error") {
    els.previewBody.className = "preview-body is-error";
    els.previewBody.innerHTML = `
      <div class="preview-error">
        <strong>Preview unavailable</strong>
        <p>${escapeHtml(preview.error || "The preview could not be loaded.")}</p>
      </div>
    `;
  } else if (file.preview.kind === "video" && preview.streamUrl) {
    els.previewBody.className = "preview-body is-video";
    els.previewBody.innerHTML = `
      <div class="preview-video-shell">
        <video id="preview-video" class="preview-video" controls preload="auto" playsinline poster="${escapeHtml(buildPreviewAssetUrl(file.preview.posterUrl))}">
          <source src="${escapeHtml(preview.streamUrl)}" type="video/mp4">
        </video>
        ${preview.status === "loading" ? `
          <div class="preview-video-overlay" data-preview-overlay>
            <div class="preview-spinner"></div>
            <p>Buffering preview video...</p>
          </div>
        ` : ""}
      </div>
    `;
    wirePreviewVideoEvents(file);
  } else if (preview.status === "loading") {
    els.previewBody.className = "preview-body is-loading";
    els.previewBody.innerHTML = `
      <div class="preview-loading">
        <div class="preview-spinner"></div>
        <p>Loading ${escapeHtml(previewLabel.toLowerCase())}...</p>
      </div>
    `;
  } else if (preview.status === "ready" && preview.objectUrl) {
    if (file.preview.kind !== "video") {
      els.previewBody.className = "preview-body";
      els.previewBody.innerHTML = `
        <img class="preview-image" src="${escapeHtml(preview.objectUrl)}" alt="Preview of ${escapeHtml(file.name)}">
      `;
    }
  } else {
    els.previewBody.className = "preview-body is-empty";
    els.previewBody.textContent = "Preview is ready to load.";
  }

  els.previewMeta.innerHTML = `
    <div class="preview-meta-line"><strong>Type:</strong> ${escapeHtml(file.type)}</div>
    <div class="preview-meta-line"><strong>Captured:</strong> ${formatUnix(file.createdUnix)}</div>
    <div class="preview-meta-line"><strong>Full file size:</strong> ${formatBytes(file.sizeBytes)}</div>
    <div class="preview-meta-line"><strong>Folder:</strong> ${escapeHtml(file.directory)}</div>
    ${file.preview.thumbnailUrl ? `<div class="preview-meta-line"><strong>Thumbnail:</strong> GoPro THM-backed preview available</div>` : ""}
    <div class="preview-note">
      ${escapeHtml(file.preview.kind === "video" ? "This preview uses the GoPro low-resolution proxy file when available." : "This preview uses the GoPro screennail or thumbnail endpoint, not the full-resolution image.")}
    </div>
  `;
}

function renderDownloadJob() {
  const job = state.downloadJob;
  const active = isDownloadActive();
  const queuedCount = state.pendingQueue.length;
  const queuedBytes = state.pendingQueue.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const downloadRoot = job ? destinationLabel(job) : els.saveDestination.value === "google-drive" ? `Google Drive · ${state.google?.folder?.name || "Choose a folder"}` : els.downloadRoot.value.trim() || "./downloads";
  const nextQueuedItem = state.pendingQueue[0] || null;
  els.recoverySettings.hidden = !state.recoverableJobs.length;
  els.recoveryBatch.disabled = active;
  els.recoveryBatch.innerHTML = state.recoverableJobs.map(batch => `<option value="${escapeHtml(batch.id)}">${escapeHtml(formatTimestamp(batch.createdAt))} · ${escapeHtml(batch.files[0]?.name || "Batch")} · ${escapeHtml(formatJobBadge(batch.status))}</option>`).join('');
  if (job && state.recoverableJobs.some(batch => batch.id === job.id)) els.recoveryBatch.value = job.id;
  els.recoveryBatch.onchange = () => runUiTask(async () => {
    const response = await api(`/api/download-jobs/${els.recoveryBatch.value}`);
    setDownloadJob(response.job);
  });
  els.resumeBatchBtn.hidden = job?.status !== "paused";
  els.retryBatchBtn.hidden = !job?.files.some(item => item.status === "failed");
  for (const [button, action] of [[els.resumeBatchBtn, 'resume'], [els.retryBatchBtn, 'retry']]) button.onclick = () => runUiTask(async () => {
    button.disabled = true;
    try {
      const response = await api(`/api/download-jobs/${job.id}/${action}`, { method: "POST", body: {} });
      setDownloadJob(response.job);
      startDownloadPolling(job.id);
    } finally { button.disabled = false; }
  });
  els.pauseBatchBtn.hidden = !active;
  els.discardBatchBtn.hidden = !job || !["paused", "failed", "completed_with_errors"].includes(job.status);
  for (const [button, action] of [[els.pauseBatchBtn, "pause"], [els.discardBatchBtn, "discard"]]) {
    button.onclick = () => runUiTask(async () => {
      button.disabled = true;
      try {
        const response = await api(`/api/download-jobs/${job.id}/${action}`, { method: "POST", body: {} });
        stopDownloadPolling();
        setDownloadJob(response.job);
        await refreshGoogleStatus();
        await refreshRecoveries();
      } finally { button.disabled = false; }
    });
  }

  els.disconnectBtn.disabled = active;
  const cloudReady = els.saveDestination.value !== "google-drive" || (state.google?.connected && state.google?.folder && !state.google?.authorizationPending);
  els.startQueueBtn.disabled = active || !queuedCount || !state.session || !cloudReady;
  els.clearQueueBtn.disabled = !queuedCount;

  if (!job) {
    els.downloadStatusCard.className = "download-status-card is-idle";
    els.downloadBadge.className = `download-badge ${queuedCount ? "is-ready" : "is-idle"}`;
    els.downloadBadge.textContent = queuedCount ? "Ready" : "Idle";
    els.downloadHeadline.textContent = queuedCount ? `Queue ready for ${queuedCount} file${queuedCount === 1 ? "" : "s"}.` : "No active download.";
    els.downloadInlineMeta.textContent = queuedCount ? `${formatBytes(queuedBytes)} waiting for the next batch.` : "Queue files to get started.";
    els.statTotalFiles.textContent = String(queuedCount);
    els.statCompletedFiles.textContent = "0";
    els.statTransferred.textContent = "0 B";
    els.statDownloadRoot.textContent = downloadRoot;
    els.overallProgressFill.style.width = "0%";
    els.currentProgressFill.style.width = "0%";
    els.overallProgressText.textContent = "0 B of 0 B";
    els.currentProgressText.textContent = "Waiting for a download to start";
    els.currentFileName.textContent = nextQueuedItem ? nextQueuedItem.name : "Nothing downloading";
    els.currentFileMeta.textContent = queuedCount
      ? "The queue is staged. Start the batch whenever you are ready."
      : "Build a queue, reorder it if needed, then start the batch when you are ready.";
    els.activeJobList.innerHTML = `<div class="job-list-empty">${queuedCount ? "No batch is running yet. Start the queue to begin downloading." : "No active batch yet."}</div>`;
    els.downloadSummary.textContent = queuedCount
      ? `Ready to save ${formatBytes(queuedBytes)} into ${downloadRoot}.`
      : "Preview a file first if you want to check the low-res version before offloading it.";

    renderFoldedDownloadBar({
      status: queuedCount ? "Ready" : "Idle",
      fileName: nextQueuedItem ? nextQueuedItem.name : "Nothing downloading",
      fileMeta: nextQueuedItem
        ? joinCompactParts([
            `${formatBytes(nextQueuedItem.sizeBytes)} first up`,
            `${formatBytes(queuedBytes)} total queued`,
            downloadRoot
          ])
        : "Queue files to get started.",
      downloaded: queuedCount ? `0 B of ${formatBytes(queuedBytes)}` : "0 B of 0 B",
      completed: `0 / ${queuedCount}`,
      speed: "--",
      eta: queuedCount ? "Ready" : "--"
    });
    return;
  }

  els.downloadStatusCard.className = `download-status-card is-${job.status}`;
  els.downloadBadge.className = `download-badge is-${job.status}`;
  els.downloadBadge.textContent = formatJobBadge(job.status);
  els.statTotalFiles.textContent = String(job.totalFiles);
  els.statCompletedFiles.textContent = String(job.completedFiles);
  els.statTransferred.textContent = formatBytes(job.transferredBytes);
  els.statDownloadRoot.textContent = downloadRoot;
  els.overallProgressFill.style.width = `${job.overallPercent || 0}%`;
  els.overallProgressText.textContent = `${formatBytes(job.transferredBytes)} of ${formatBytes(job.totalBytes)}${job.overallPercent !== null ? ` (${job.overallPercent}%)` : ""}`;

  let foldedFileName = "Waiting for the next file";
  let foldedFileMeta = joinCompactParts([
    `${formatBytes(job.transferredBytes)} downloaded`,
    `${formatBytes(job.totalBytes)} total`
  ]);

  if (job.currentItem) {
    els.currentProgressFill.style.width = `${job.currentItem.percent || 0}%`;
    els.currentProgressText.textContent = `${formatStage(job.currentItem.stage)} · ${formatBytes(job.currentItem.stageBytes)} of ${formatBytes(job.currentItem.sizeBytes)}`;
    els.currentFileName.textContent = job.currentItem.name;
    els.currentFileMeta.textContent = joinCompactParts([
      job.currentItem.directory,
      `${formatStage(job.currentItem.stage)}: ${formatBytes(job.currentItem.stageBytes)} of ${formatBytes(job.currentItem.sizeBytes)}`,
      formatTransferRate(job.speedBytesPerSecond),
      `ETA ${formatEta(job.currentItem.etaSeconds, job.status)}`
    ]);
    foldedFileName = job.currentItem.name;
    foldedFileMeta = joinCompactParts([
      `${formatStage(job.currentItem.stage)}: ${formatBytes(job.currentItem.stageBytes)} of ${formatBytes(job.currentItem.sizeBytes)}`,
      job.currentItem.percent !== null ? `${job.currentItem.percent}%` : "",
      job.currentItem.directory
    ]);
  } else {
    els.currentProgressFill.style.width = job.status === "completed" ? "100%" : "0%";
    els.currentProgressText.textContent = job.status === "completed" ? "All files finished." : "Waiting for the next file.";
    els.currentFileName.textContent = job.status === "completed" ? "Batch finished" : "Waiting for the next file";
    els.currentFileMeta.textContent = job.status === "failed" ? (job.error || "The active batch hit an error.") : "No file is actively transferring right now.";

    if (job.status === "completed") {
      foldedFileName = "Batch finished";
      foldedFileMeta = `Saved ${job.completedFiles} video${job.completedFiles === 1 ? "" : "s"} to ${downloadRoot}`;
    } else if (job.status === "failed") {
      foldedFileName = "Download failed";
      foldedFileMeta = job.error || "The active batch hit an error.";
    }
  }

  if (job.status === "running" || job.status === "queued") {
    els.downloadHeadline.textContent = job.currentItem ? formatStage(job.currentItem.stage) : "Preparing batch";
    els.downloadInlineMeta.textContent = joinCompactParts([
      `Saving to ${downloadRoot}`,
      formatTransferRate(job.speedBytesPerSecond),
      `ETA ${formatEta(job.etaSeconds, job.status)}`
    ]);
    els.downloadSummary.textContent = `Saving ${job.completedFiles} of ${job.totalFiles} videos to ${downloadRoot}. ${formatBytes(job.retainedBytes)} retained in temporary storage. Recording timezone: ${job.recordingTimezone}.`;
  } else if (job.status === "completed") {
    els.downloadHeadline.textContent = "Save complete";
    els.downloadInlineMeta.textContent = `Finished at ${formatTimestamp(job.finishedAt)}`;
    els.downloadSummary.textContent = `Saved ${job.completedFiles} video${job.completedFiles === 1 ? '' : 's'} to ${downloadRoot}. Recording timezone: ${job.recordingTimezone}.`;
  } else if (job.status === "failed") {
    els.downloadHeadline.textContent = "Save failed";
    els.downloadInlineMeta.textContent = `Stopped while saving to ${downloadRoot}`;
    els.downloadSummary.textContent = job.error || "The GoPro stopped responding during the transfer.";
  } else if (job.status === "paused") {
    els.downloadHeadline.textContent = "Batch paused";
    els.downloadInlineMeta.textContent = downloadRoot;
    els.downloadSummary.textContent = `${job.error || "Resume when ready. Completed videos remain saved."} ${formatBytes(job.retainedBytes)} retained in temporary storage.`;
  } else if (job.status === "completed_with_errors") {
    els.downloadHeadline.textContent = "Finished with errors";
    els.downloadInlineMeta.textContent = `${job.completedFiles} of ${job.totalFiles} videos saved to ${downloadRoot}`;
    els.downloadSummary.textContent = `Retry failed videos when ready. ${formatBytes(job.retainedBytes)} retained in temporary storage.`;
  } else if (job.status === "discarded") {
    els.downloadHeadline.textContent = "Unfinished work discarded";
    els.downloadInlineMeta.textContent = "Completed videos remain saved.";
    els.downloadSummary.textContent = "Temporary originals and remaining work were cleared. Camera originals are unchanged.";
  }

  renderFoldedDownloadBar({
    status: formatJobBadge(job.status),
    fileName: foldedFileName,
    fileMeta: foldedFileMeta,
    downloaded: `${formatBytes(job.transferredBytes)} of ${formatBytes(job.totalBytes)}`,
    completed: `${job.completedFiles} / ${job.totalFiles}`,
    speed: formatTransferRate(job.speedBytesPerSecond),
    eta: formatEta(job.etaSeconds, job.status)
  });
  renderActiveJobList(job);
}

function renderPendingQueue() {
  const count = state.pendingQueue.length;
  const totalBytes = state.pendingQueue.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const active = isDownloadActive();

  els.queueCountPill.textContent = `${count} queued`;
  els.queueTitle.textContent = count ? `${count} file${count === 1 ? "" : "s"} ready` : "No files queued";
  els.queueSummary.textContent = count
    ? `${formatBytes(totalBytes)} across ${count} file${count === 1 ? "" : "s"}. ${active ? "This queue will wait for the active batch to finish." : "Reorder or remove anything before you start."}`
    : "Add files from the footage browser or the preview panel to build a batch before downloading.";

  const cloudReady = els.saveDestination.value !== "google-drive" || (state.google?.connected && state.google?.folder && !state.google?.authorizationPending);
  els.startQueueBtn.disabled = active || !count || !state.session || !cloudReady;
  els.clearQueueBtn.disabled = !count;

  if (!count) {
    els.queueList.innerHTML = `<div class="queue-empty">No pending queue yet. Use “Queue selected”, “Queue all”, or “Add to queue” from preview.</div>`;
    return;
  }

  els.queueList.innerHTML = state.pendingQueue
    .map((item, index) => `
      <article class="queue-item-card">
        <div class="queue-item-order">${index + 1}</div>
        <div class="queue-item-main">
          <div class="queue-item-title-row">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="queue-item-badge">${escapeHtml(item.type || "Media")}</span>
          </div>
          <div class="queue-item-meta">${escapeHtml(item.directory)} · ${formatBytes(item.sizeBytes)}${item.createdUnix ? ` · ${formatUnix(item.createdUnix)}` : ""}</div>
        </div>
        <div class="queue-item-actions">
          <button class="ghost-button queue-action" type="button" data-action="up" data-id="${escapeHtml(item.id)}" ${index === 0 ? "disabled" : ""}>Up</button>
          <button class="ghost-button queue-action" type="button" data-action="down" data-id="${escapeHtml(item.id)}" ${index === state.pendingQueue.length - 1 ? "disabled" : ""}>Down</button>
          <button class="ghost-button queue-action queue-action-danger" type="button" data-action="remove" data-id="${escapeHtml(item.id)}">Remove</button>
        </div>
      </article>
    `)
    .join("");

  document.querySelectorAll(".queue-action").forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = button.dataset.id;
      const action = button.dataset.action;

      if (action === "remove") {
        removeQueueItem(itemId);
      } else if (action === "up") {
        moveQueueItem(itemId, -1);
      } else if (action === "down") {
        moveQueueItem(itemId, 1);
      }
    });
  });
}

function renderActiveJobList(job) {
  if (!job || !(job.files || []).length) {
    els.activeJobList.innerHTML = `<div class="job-list-empty">No batch details yet.</div>`;
    return;
  }

  els.activeJobList.innerHTML = job.files
    .map((item) => {
      const transferringUpload = ['uploading', 'verifying'].includes(item.stage);
      const stageBytes = transferringUpload ? item.uploadedBytes : item.downloadedBytes;
      const percent = ['completed', 'skipped'].includes(item.status) ? 100 : item.sizeBytes ? Math.min(99, stageBytes / item.sizeBytes * 100) : 0;
      return `
        <div class="job-file-row is-${escapeHtml(item.status)}">
          <div class="job-file-main">
            <div class="job-file-title-row">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="job-file-badge is-${escapeHtml(item.status)}">${escapeHtml(formatJobBadge(item.status))}</span>
            </div>
            <div class="job-file-meta">${escapeHtml(item.recordingDate)}${item.recordingDate === 'Unknown date' ? ' · Camera recording date unavailable' : ''} · ${escapeHtml(formatStage(item.stage))} · ${formatBytes(stageBytes)} of ${formatBytes(item.sizeBytes)}</div>
            ${['completed', 'skipped'].includes(item.status) && item.driveFileId ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(item.driveFileId)}/view" target="_blank" rel="noopener noreferrer">Open saved ${escapeHtml(item.name)}</a>` : ''}
            ${item.status === "running" ? `
              <div class="job-file-progress">
                <div class="job-file-progress-fill" style="width:${percent || 0}%"></div>
              </div>
            ` : ""}
            ${item.error ? `<div class="job-file-error">${escapeHtml(item.error)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}

function formatJobBadge(status) {
  return (
    {
      idle: "Idle",
      queued: "Queued",
      running: "Running",
      completed: "Completed",
      failed: "Failed", paused: "Paused", completed_with_errors: "Finished with errors", skipped: "Skipped", discarded: "Discarded"
    }[status] || "Unknown"
  );
}

function destinationLabel(job) {
  return job.destination?.type === 'google-drive' ? `Google Drive · ${job.destination.name}` : job.downloadRoot;
}

function formatStage(stage) {
  return { downloading: 'Downloading original', uploading: 'Uploading original', verifying: 'Verifying original', saved: 'Saved' }[stage] || 'Waiting';
}

function isDownloadActive() {
  return Boolean(state.downloadJob && (state.downloadJob.status === "queued" || state.downloadJob.status === "running"));
}

function syncPreviewSelection() {
  if (!state.preview.file) {
    renderPreview();
    return;
  }

  const replacement = state.media.find((file) => file.path === state.preview.file.path);
  if (!replacement) {
    clearPreview();
    return;
  }

  state.preview.file = replacement;
  renderPreview();
}

function clearPreview() {
  resetPreviewMediaState();
  state.preview = {
    file: null,
    status: "idle",
    objectUrl: null,
    streamUrl: null,
    error: null
  };
  renderPreview();
}

function resetPreviewMediaState() {
  revokePreviewObjectUrl();
}

function revokePreviewObjectUrl() {
  if (state.preview.objectUrl) {
    URL.revokeObjectURL(state.preview.objectUrl);
  }
}

function wirePreviewVideoEvents(file) {
  const video = document.querySelector("#preview-video");
  if (!video) {
    return;
  }

  const expectedPath = file.path;

  video.addEventListener("loadeddata", () => {
    if (!isCurrentPreviewFile(expectedPath)) {
      return;
    }

    removePreviewVideoOverlay();
  });

  video.addEventListener("canplay", () => {
    if (!isCurrentPreviewFile(expectedPath)) {
      return;
    }

    state.preview.status = "ready";
    removePreviewVideoOverlay();
  });

  video.addEventListener("waiting", () => {
    if (!isCurrentPreviewFile(expectedPath)) {
      return;
    }

    showPreviewVideoOverlay("Buffering preview video...");
  });

  video.addEventListener("playing", () => {
    if (!isCurrentPreviewFile(expectedPath)) {
      return;
    }

    removePreviewVideoOverlay();
  });

  video.addEventListener("error", () => {
    if (!isCurrentPreviewFile(expectedPath)) {
      return;
    }

    state.preview.status = "error";
    state.preview.error = "Unable to stream the preview video from the camera.";
    renderPreview();
  });
}

function removePreviewVideoOverlay() {
  const overlay = els.previewBody.querySelector("[data-preview-overlay]");
  if (overlay) {
    overlay.remove();
  }
}

function showPreviewVideoOverlay(message) {
  let overlay = els.previewBody.querySelector("[data-preview-overlay]");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "preview-video-overlay";
    overlay.dataset.previewOverlay = "true";
    overlay.innerHTML = `
      <div class="preview-spinner"></div>
      <p></p>
    `;
    const shell = els.previewBody.querySelector(".preview-video-shell");
    if (shell) {
      shell.appendChild(overlay);
    }
  }

  const text = overlay.querySelector("p");
  if (text) {
    text.textContent = message;
  }
}

function isCurrentPreviewFile(expectedPath) {
  return Boolean(state.preview.file && state.preview.file.path === expectedPath);
}

function buildPreviewStreamUrl(baseUrl) {
  return buildPreviewAssetUrl(baseUrl);
}

function buildPreviewAssetUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }

  const separator = String(baseUrl).includes("?") ? "&" : "?";
  return `${baseUrl}${separator}v=${ASSET_VERSION}`;
}

function buildMediaThumbnailUrl(file) {
  if (!file.preview) {
    return "";
  }

  const baseUrl = file.preview.thumbnailUrl || file.preview.posterUrl || file.preview.url;
  if (!baseUrl) {
    return "";
  }

  return buildPreviewAssetUrl(baseUrl);
}

function wireThumbnailFallbacks() {
  document.querySelectorAll(".media-thumb").forEach((image) => {
    image.addEventListener("error", () => {
      const fallback = createMediaThumbFallback(image.dataset.fallbackLabel || "?");
      image.replaceWith(fallback);
    }, { once: true });
  });
}

function createMediaThumbFallback(label) {
  const fallback = document.createElement("div");
  fallback.className = "media-thumb media-thumb-empty";
  fallback.textContent = label;
  return fallback;
}

function appendLog(message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.activityLog.prepend(line);
}

function renderFoldedDownloadBar(summary) {
  if (!els.foldedFileName) {
    return;
  }

  els.foldedFileName.textContent = summary.fileName;
  els.foldedFileMeta.textContent = summary.fileMeta;
  els.foldedStatus.textContent = summary.status;
  els.foldedDownloaded.textContent = summary.downloaded;
  els.foldedCompleted.textContent = summary.completed;
  els.foldedSpeed.textContent = summary.speed;
  els.foldedEta.textContent = summary.eta;
}

function setDownloadCenterCollapsed(collapsed) {
  state.downloadCenterCollapsed = Boolean(collapsed);
  renderDownloadCenterCollapsedState();

  try {
    window.localStorage.setItem(DOWNLOAD_CENTER_COLLAPSED_STORAGE_KEY, state.downloadCenterCollapsed ? "1" : "0");
  } catch (error) {
    // Ignore storage failures and continue with the active layout.
  }
}

function renderDownloadCenterCollapsedState() {
  if (els.downloadCenterShell) {
    els.downloadCenterShell.classList.toggle("is-collapsed", state.downloadCenterCollapsed);
  }

  if (els.downloadCenterPanel) {
    els.downloadCenterPanel.classList.toggle("is-floating-collapsed", state.downloadCenterCollapsed);
  }

  if (els.downloadCenterToggle) {
    els.downloadCenterToggle.textContent = state.downloadCenterCollapsed ? "Expand" : "Collapse";
    els.downloadCenterToggle.setAttribute("aria-expanded", String(!state.downloadCenterCollapsed));
  }

  if (els.downloadCenterFloatingToggle) {
    els.downloadCenterFloatingToggle.textContent = state.downloadCenterCollapsed ? "Expand" : "Collapse";
  }
}

function restoreDownloadCenterCollapsed() {
  let storedValue = "";

  try {
    storedValue = window.localStorage.getItem(DOWNLOAD_CENTER_COLLAPSED_STORAGE_KEY) || "";
  } catch (error) {
    storedValue = "";
  }

  state.downloadCenterCollapsed = storedValue === "1";
  renderDownloadCenterCollapsedState();
}

function persistDownloadRoot(value) {
  try {
    window.localStorage.setItem(DOWNLOAD_ROOT_STORAGE_KEY, value);
  } catch (error) {
    // Ignore storage failures and continue with the active session.
  }
}

function restoreDownloadRoot() {
  let storedValue = "";

  try {
    storedValue = window.localStorage.getItem(DOWNLOAD_ROOT_STORAGE_KEY) || "";
  } catch (error) {
    storedValue = "";
  }

  if (storedValue) {
    els.downloadRoot.value = storedValue;
  }

  els.heroDownloadRoot.textContent = els.downloadRoot.value.trim() || "./downloads";
}

function redirectToHome() {
  window.location.replace("/");
}

async function runUiTask(task) {
  const feedback = document.querySelector("#workspace-feedback");
  feedback.hidden = true;
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    feedback.textContent = message;
    feedback.hidden = false;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function readErrorMessage(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await response.json();
    return payload.error || `Request failed with HTTP ${response.status}.`;
  }

  const text = await response.text();
  return text || `Request failed with HTTP ${response.status}.`;
}

function joinCompactParts(parts) {
  return parts.filter((part) => Boolean(part) && part !== "--").join(" | ");
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTransferRate(bytesPerSecond) {
  if (bytesPerSecond === null || bytesPerSecond === undefined) {
    return "--";
  }

  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds, status = "running") {
  if (status === "completed") {
    return "Done";
  }

  if (status === "failed") {
    return "Stopped";
  }

  if (status === "queued") {
    return "Waiting";
  }

  if (seconds === null || seconds === undefined) {
    return "Calculating...";
  }

  return formatDuration(seconds);
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function formatUnix(unixSeconds) {
  const value = Number(unixSeconds || 0);
  if (!value) {
    return "Unknown";
  }
  return new Date(value * 1000).toLocaleString();
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown";
  }
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
