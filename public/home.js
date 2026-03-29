const DOWNLOAD_ROOT_STORAGE_KEY = "gopro.downloadRoot";

const state = {
  session: null,
  docs: [],
  candidates: [],
  activeTab: "connect"
};

const els = {
  docsGrid: document.querySelector("#docs-grid"),
  candidateList: document.querySelector("#candidate-list"),
  sessionSummary: document.querySelector("#session-summary"),
  activityLog: document.querySelector("#activity-log"),
  cameraIp: document.querySelector("#camera-ip"),
  serialSuffix: document.querySelector("#serial-suffix"),
  downloadRoot: document.querySelector("#download-root"),
  heroConnection: document.querySelector("#hero-connection"),
  heroDownloadRoot: document.querySelector("#hero-download-root"),
  heroCandidateCount: document.querySelector("#hero-candidate-count"),
  connectForm: document.querySelector("#connect-form"),
  discoverBtn: document.querySelector("#discover-btn"),
  disconnectBtn: document.querySelector("#disconnect-btn"),
  connectTab: document.querySelector("#home-tab-connect"),
  aboutTab: document.querySelector("#home-tab-about"),
  connectPanel: document.querySelector("#home-panel-connect"),
  aboutPanel: document.querySelector("#home-panel-about")
};

window.addEventListener("DOMContentLoaded", async () => {
  restoreDownloadRoot();
  wireEvents();
  renderTabs();

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

  els.connectTab.addEventListener("click", () => {
    setActiveTab("connect");
  });

  els.aboutTab.addEventListener("click", () => {
    setActiveTab("about");
  });

  els.downloadRoot.addEventListener("input", () => {
    const value = els.downloadRoot.value.trim() || "./downloads";
    els.heroDownloadRoot.textContent = value;
    persistDownloadRoot(value);
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

  renderCandidates();
  renderSession();

  if (state.session) {
    appendLog(`Connected to ${state.session.cameraName || state.session.ip}. Redirecting to the main page...`);
    redirectToMain();
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
  appendLog(`Connected to ${state.session.cameraName || state.session.ip}. Opening the main page...`);
  redirectToMain();
}

async function disconnectCamera() {
  await api("/api/disconnect", {
    method: "POST",
    body: {}
  });

  state.session = null;
  renderSession();
  appendLog("Disconnected from the GoPro session.");
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
  els.heroCandidateCount.textContent = `${state.candidates.length} detected`;

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
  const downloadRoot = els.downloadRoot.value.trim() || "./downloads";
  els.heroDownloadRoot.textContent = downloadRoot;

  if (!state.session) {
    els.heroConnection.textContent = "Ready to connect";
    els.sessionSummary.innerHTML = "No active session.";
    return;
  }

  els.heroConnection.textContent = state.session.cameraName || state.session.ip;
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

function setActiveTab(tab) {
  state.activeTab = tab === "about" ? "about" : "connect";
  renderTabs();
}

function renderTabs() {
  const isAbout = state.activeTab === "about";

  els.connectTab.classList.toggle("is-active", !isAbout);
  els.aboutTab.classList.toggle("is-active", isAbout);
  els.connectTab.setAttribute("aria-selected", String(!isAbout));
  els.aboutTab.setAttribute("aria-selected", String(isAbout));
  els.connectPanel.hidden = isAbout;
  els.aboutPanel.hidden = !isAbout;
}

function redirectToMain() {
  window.location.replace("/main");
}

function appendLog(message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.activityLog.prepend(line);
}

function persistDownloadRoot(value) {
  try {
    window.localStorage.setItem(DOWNLOAD_ROOT_STORAGE_KEY, value);
  } catch (error) {
    // Ignore storage failures and continue with the current session.
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
