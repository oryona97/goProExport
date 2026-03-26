const state = {
  session: null,
  media: [],
  docs: [],
  candidates: []
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
  downloadAllBtn: document.querySelector("#download-all-btn")
};

window.addEventListener("DOMContentLoaded", async () => {
  wireEvents();
  await runUiTask(async () => {
    await Promise.all([loadDocs(), refreshStatus()]);
  });
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
  renderSession();
  renderCandidates();

  if (state.session) {
    appendLog(`Connected to ${state.session.cameraName || state.session.ip}.`);
    await refreshMedia(false);
  } else {
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
  await api("/api/disconnect", {
    method: "POST",
    body: {}
  });

  state.session = null;
  state.media = [];
  renderSession();
  renderMedia();
  appendLog("Disconnected from the GoPro session.");
}

async function refreshMedia(logResult = true) {
  if (!state.session) {
    renderMedia();
    return;
  }

  const response = await api("/api/media");
  state.media = response.files || [];
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

  if (!files.length) {
    appendLog("There are no files to download yet.");
    return;
  }

  appendLog(`Downloading ${files.length} file${files.length === 1 ? "" : "s"} to ${els.downloadRoot.value.trim() || "./downloads"}...`);

  const response = await api("/api/download", {
    method: "POST",
    body: {
      downloadRoot: els.downloadRoot.value.trim(),
      files: files.map((file) => ({
        directory: file.directory,
        name: file.name
      }))
    }
  });

  appendLog(`Saved ${response.count} file${response.count === 1 ? "" : "s"} to ${response.root}.`);
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
    els.mediaBody.innerHTML = `<tr><td colspan="6" class="empty-state">${state.session ? "No media returned by the camera yet." : "Connect to a camera to load media."}</td></tr>`;
    return;
  }

  els.mediaBody.innerHTML = state.media
    .map(
      (file) => `
        <tr>
          <td><input class="row-selector" type="checkbox" data-path="${escapeHtml(file.path)}"></td>
          <td>${escapeHtml(file.name)}</td>
          <td>${escapeHtml(file.type)}</td>
          <td>${escapeHtml(file.directory)}</td>
          <td>${formatBytes(file.sizeBytes)}</td>
          <td>${formatUnix(file.createdUnix)}</td>
        </tr>
      `
    )
    .join("");
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
    appendLog(payload.error || `Request failed with HTTP ${response.status}.`);
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
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
