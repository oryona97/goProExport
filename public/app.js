const state = {
  session: null,
  media: [],
  docs: [],
  candidates: [],
  preview: {
    file: null,
    status: "idle",
    objectUrl: null,
    error: null
  },
  downloadJob: null,
  downloadPollTimer: null
};

const els = {
  docsGrid: document.querySelector("#docs-grid"),
  candidateList: document.querySelector("#candidate-list"),
  sessionSummary: document.querySelector("#session-summary"),
  activityLog: document.querySelector("#activity-log"),
  mediaBody: document.querySelector("#media-body"),
  cameraIp: document.querySelector("#camera-ip"),
  serialSuffix: document.querySelector("#serial-suffix"),
  downloadRoot: document.querySelector("#download-root"),
  selectAll: document.querySelector("#select-all"),
  heroConnection: document.querySelector("#hero-connection"),
  heroDownloadRoot: document.querySelector("#hero-download-root"),
  heroMediaCount: document.querySelector("#hero-media-count"),
  connectForm: document.querySelector("#connect-form"),
  discoverBtn: document.querySelector("#discover-btn"),
  disconnectBtn: document.querySelector("#disconnect-btn"),
  refreshMediaBtn: document.querySelector("#refresh-media-btn"),
  downloadSelectedBtn: document.querySelector("#download-selected-btn"),
  downloadAllBtn: document.querySelector("#download-all-btn"),
  downloadStatusCard: document.querySelector("#download-status-card"),
  downloadHeadline: document.querySelector("#download-headline"),
  overallProgressFill: document.querySelector("#overall-progress-fill"),
  overallProgressText: document.querySelector("#overall-progress-text"),
  currentProgressFill: document.querySelector("#current-progress-fill"),
  currentProgressText: document.querySelector("#current-progress-text"),
  downloadSummary: document.querySelector("#download-summary"),
  previewTitle: document.querySelector("#preview-title"),
  previewBody: document.querySelector("#preview-body"),
  previewMeta: document.querySelector("#preview-meta"),
  previewDownloadBtn: document.querySelector("#preview-download-btn")
};

window.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  renderPreview();
  renderDownloadJob();
  await runUiTask(async () => {
    await Promise.all([loadDocs(), refreshStatus()]);
  });
});

window.addEventListener("beforeunload", () => {
  stopDownloadPolling();
  revokePreviewObjectUrl();
});

function wireEvents() {
  els.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void runUiTask(connectCamera);
  });

  els.discoverBtn.addEventListener("click", () => {
    void runUiTask(() => refreshCandidates(true));
  });

  els.disconnectBtn.addEventListener("click", () => {
    void runUiTask(disconnectCamera);
  });

  els.refreshMediaBtn.addEventListener("click", () => {
    void runUiTask(refreshMedia);
  });

  els.downloadSelectedBtn.addEventListener("click", () => {
    void runUiTask(downloadSelected);
  });

  els.downloadAllBtn.addEventListener("click", () => {
    void runUiTask(() => downloadFiles(state.media));
  });

  els.previewDownloadBtn.addEventListener("click", () => {
    if (!state.preview.file) {
      appendLog("Preview a file first.");
      return;
    }

    void runUiTask(() => downloadFiles([state.preview.file]));
  });

  els.selectAll.addEventListener("change", () => {
    document.querySelectorAll(".row-selector").forEach((checkbox) => {
      checkbox.checked = els.selectAll.checked;
    });
  });

  els.downloadRoot.addEventListener("input", () => {
    els.heroDownloadRoot.textContent = els.downloadRoot.value.trim() || "./downloads";
  });
}

async function loadDocs() {
  const response = await api("/api/docs");
  state.docs = response.docs || [];
  renderDocs();
}

async function refreshStatus() {
  const response = await api("/api/status");
  state.session = response.session;
  state.candidates = response.candidates || [];
  setDownloadJob(response.activeDownloadJob || null, {
    logTransitions: false
  });
  renderSession();
  renderCandidates();

  if (state.downloadJob && isDownloadActive()) {
    startDownloadPolling(state.downloadJob.id);
  }

  if (state.session) {
    appendLog(`Connected to ${state.session.cameraName || state.session.ip}.`);
    await refreshMedia(false);
  } else {
    state.media = [];
    clearPreview();
    renderMedia();
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
  clearPreview();
  renderSession();
  renderMedia();
  appendLog("Disconnected from the GoPro session.");
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
  syncPreviewSelection();
  renderMedia();

  if (logResult) {
    appendLog(`Loaded ${response.count} file${response.count === 1 ? "" : "s"} from the camera.`);
  }
}

async function downloadSelected() {
  const selected = getSelectedFiles();
  if (!selected.length) {
    appendLog("Select at least one file first.");
    return;
  }

  await downloadFiles(selected);
}

async function downloadFiles(files) {
  if (!state.session) {
    appendLog("Connect to a GoPro first.");
    return;
  }

  if (isDownloadActive()) {
    appendLog("A download is already running.");
    return;
  }

  if (!files.length) {
    appendLog("There are no files to download yet.");
    return;
  }

  appendLog(`Starting download for ${files.length} file${files.length === 1 ? "" : "s"}...`);

  const response = await api("/api/download-jobs", {
    method: "POST",
    body: {
      downloadRoot: els.downloadRoot.value.trim(),
      files: files.map((file) => ({
        directory: file.directory,
        name: file.name,
        sizeBytes: file.sizeBytes
      }))
    }
  });

  setDownloadJob(response.job, {
    logTransitions: false
  });
  renderDownloadJob();
  startDownloadPolling(response.job.id);
}

async function pollDownloadJob(jobId) {
  const response = await api(`/api/download-jobs/${encodeURIComponent(jobId)}`);
  setDownloadJob(response.job, {
    logTransitions: true
  });

  if (!isDownloadActive()) {
    stopDownloadPolling();
  }
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

  if (!job || !options.logTransitions || previousStatus === job.status) {
    return;
  }

  if (job.status === "completed") {
    appendLog(`Download finished. Saved ${job.completedFiles} file${job.completedFiles === 1 ? "" : "s"} to ${job.downloadRoot}.`);
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

  revokePreviewObjectUrl();
  state.preview = {
    file,
    status: "loading",
    objectUrl: null,
    error: null
  };
  renderPreview();

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
      error: null
    };
    renderPreview();
    appendLog(`Loaded preview for ${file.name}.`);
  } catch (error) {
    state.preview = {
      file,
      status: "error",
      objectUrl: null,
      error: error instanceof Error ? error.message : String(error)
    };
    renderPreview();
  }
}

function getSelectedFiles() {
  const selectedPaths = new Set(
    Array.from(document.querySelectorAll(".row-selector"))
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.path)
  );

  return state.media.filter((file) => selectedPaths.has(file.path));
}

function renderDocs() {
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
      els.cameraIp.value = candidate.ip;
      appendLog(`Filled camera IP with detected candidate ${candidate.ip}.`);
    });
    els.candidateList.appendChild(button);
  });
}

function renderSession() {
  els.heroDownloadRoot.textContent = els.downloadRoot.value.trim() || "./downloads";

  if (!state.session) {
    els.sessionSummary.innerHTML = "No active session.";
    els.heroConnection.textContent = "Not connected";
    els.heroMediaCount.textContent = `${state.media.length} files`;
    return;
  }

  els.heroConnection.textContent = state.session.cameraName || state.session.ip;
  els.heroMediaCount.textContent = `${state.media.length} file${state.media.length === 1 ? "" : "s"}`;

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

function renderMedia() {
  els.heroMediaCount.textContent = `${state.media.length} file${state.media.length === 1 ? "" : "s"}`;

  if (!state.media.length) {
    els.mediaBody.innerHTML = `<tr><td colspan="7" class="empty-state">${state.session ? "No media returned by the camera yet." : "Connect to a camera to load media."}</td></tr>`;
    return;
  }

  els.mediaBody.innerHTML = state.media
    .map((file) => {
      const isActivePreview = Boolean(state.preview.file && state.preview.file.path === file.path);

      return `
        <tr class="${isActivePreview ? "is-active-row" : ""}">
          <td><input class="row-selector" type="checkbox" data-path="${escapeHtml(file.path)}"></td>
          <td>${escapeHtml(file.name)}</td>
          <td>${escapeHtml(file.type)}</td>
          <td>${escapeHtml(file.directory)}</td>
          <td>${formatBytes(file.sizeBytes)}</td>
          <td>${formatUnix(file.createdUnix)}</td>
          <td>
            <button class="ghost-button preview-action" type="button" data-path="${escapeHtml(file.path)}" ${file.preview && file.preview.available ? "" : "disabled"}>
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
}

function renderPreview() {
  const preview = state.preview;
  const isDownloadBusy = isDownloadActive();
  els.previewDownloadBtn.disabled = !preview.file || isDownloadBusy;

  if (!preview.file) {
    els.previewTitle.textContent = "Select a file";
    els.previewBody.className = "preview-body is-empty";
    els.previewBody.innerHTML = `Choose a photo or video and click <strong>Preview</strong> to inspect a lightweight version before downloading.`;
    els.previewMeta.innerHTML = "";
    return;
  }

  const file = preview.file;
  const previewLabel = file.preview && file.preview.label ? file.preview.label : "Preview";
  els.previewTitle.textContent = `${file.name}`;

  if (preview.status === "loading") {
    els.previewBody.className = "preview-body is-loading";
    els.previewBody.innerHTML = `
      <div class="preview-loading">
        <div class="preview-spinner"></div>
        <p>Loading ${escapeHtml(previewLabel.toLowerCase())}...</p>
      </div>
    `;
  } else if (preview.status === "error") {
    els.previewBody.className = "preview-body is-error";
    els.previewBody.innerHTML = `
      <div class="preview-error">
        <strong>Preview unavailable</strong>
        <p>${escapeHtml(preview.error || "The preview could not be loaded.")}</p>
      </div>
    `;
  } else if (preview.status === "ready" && preview.objectUrl) {
    if (file.preview.kind === "video") {
      els.previewBody.className = "preview-body";
      els.previewBody.innerHTML = `
        <video class="preview-video" controls preload="metadata" poster="${escapeHtml(file.preview.posterUrl || "")}">
          <source src="${escapeHtml(preview.objectUrl)}" type="video/mp4">
        </video>
      `;
    } else {
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
    <div class="preview-note">
      ${escapeHtml(file.preview.kind === "video" ? "This preview uses the GoPro low-resolution proxy file when available." : "This preview uses the GoPro screennail or thumbnail endpoint, not the full-resolution image.")}
    </div>
  `;
}

function renderDownloadJob() {
  const job = state.downloadJob;
  const active = isDownloadActive();

  els.downloadSelectedBtn.disabled = active;
  els.downloadAllBtn.disabled = active;
  els.disconnectBtn.disabled = active;
  els.previewDownloadBtn.disabled = active || !state.preview.file;

  if (!job) {
    els.downloadStatusCard.className = "download-status-card is-idle";
    els.downloadHeadline.textContent = "No active download.";
    els.overallProgressFill.style.width = "0%";
    els.currentProgressFill.style.width = "0%";
    els.overallProgressText.textContent = "0 B of 0 B";
    els.currentProgressText.textContent = "Waiting for a download to start";
    els.downloadSummary.textContent = "Preview a file first if you want to check the low-res version before offloading it.";
    return;
  }

  els.downloadStatusCard.className = `download-status-card is-${job.status}`;
  els.overallProgressFill.style.width = `${job.overallPercent || 0}%`;
  els.overallProgressText.textContent = `${formatBytes(job.transferredBytes)} of ${formatBytes(job.totalBytes)}${job.overallPercent !== null ? ` (${job.overallPercent}%)` : ""}`;

  if (job.currentItem) {
    els.currentProgressFill.style.width = `${job.currentItem.percent || 0}%`;
    els.currentProgressText.textContent = `${job.currentItem.name}: ${formatBytes(job.currentItem.downloadedBytes)} of ${formatBytes(job.currentItem.sizeBytes)}${job.currentItem.percent !== null ? ` (${job.currentItem.percent}%)` : ""}`;
  } else {
    els.currentProgressFill.style.width = job.status === "completed" ? "100%" : "0%";
    els.currentProgressText.textContent = job.status === "completed" ? "All files finished." : "Waiting for the next file.";
  }

  if (job.status === "running" || job.status === "queued") {
    els.downloadHeadline.textContent = `Downloading ${job.completedFiles} of ${job.totalFiles} files`;
    els.downloadSummary.textContent = `Files are being saved to ${job.downloadRoot}.`;
  } else if (job.status === "completed") {
    els.downloadHeadline.textContent = `Download complete`;
    els.downloadSummary.textContent = `Saved ${job.completedFiles} file${job.completedFiles === 1 ? "" : "s"} to ${job.downloadRoot}.`;
  } else if (job.status === "failed") {
    els.downloadHeadline.textContent = `Download failed`;
    els.downloadSummary.textContent = job.error || "The GoPro stopped responding during the transfer.";
  }
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
  revokePreviewObjectUrl();
  state.preview = {
    file: null,
    status: "idle",
    objectUrl: null,
    error: null
  };
  renderPreview();
}

function revokePreviewObjectUrl() {
  if (state.preview.objectUrl) {
    URL.revokeObjectURL(state.preview.objectUrl);
  }
}

function appendLog(message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.activityLog.prepend(line);
}

async function runUiTask(task) {
  try {
    await task();
  } catch (error) {
    appendLog(error instanceof Error ? error.message : String(error));
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
