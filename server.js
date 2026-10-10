const http = require("http");
const { randomUUID, createHash } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { JobStore } = require("./lib/job-store");
const { GoogleDrive } = require("./lib/google-drive");
const { openSystemBrowser } = require("./lib/system-browser");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_DOWNLOAD_ROOT = path.join(__dirname, "downloads");
const KEEP_ALIVE_INTERVAL_MS = 3000;
const JSON_LIMIT_BYTES = 1024 * 128;
const JOB_PROGRESS_SAMPLE_TTL_MS = 15000;
const JOB_PROGRESS_SAMPLE_LIMIT = 60;

const DOC_SUMMARY = [
  {
    title: "USB is HTTP over a GoPro USB network link",
    detail:
      "Open GoPro says USB connections use Network Control Model (NCM), not simple mass storage mounting."
  },
  {
    title: "Wired USB control must be enabled",
    detail:
      "The official wired-control endpoint is /gopro/camera/control/wired_usb?p=1."
  },
  {
    title: "No USB authentication is required",
    detail:
      "GoPro documents USB authentication as unnecessary once the USB network connection is active."
  },
  {
    title: "Keep the session alive every 3 seconds",
    detail:
      "GoPro recommends sending /gopro/camera/keep_alive every 3.0 seconds after connecting."
  },
  {
    title: "Media flows through the media list and file download endpoints",
    detail:
      "The app uses /gopro/media/list and /videos/DCIM/{directory}/{filename} to browse and offload footage."
  }
];

const state = {
  session: null,
  downloadJobs: new Map(),
  jobActions: new Set(),
  thumbnailCache: new Map(),
  thumbnailPending: new Map(),
  thumbnailQueue: Promise.resolve()
};
const DATA_ROOT = process.env.GOPRO_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GoProExport");
const googleDrive = new GoogleDrive(DATA_ROOT);
// Providers implement validateDestination and saveOriginal; the coordinator owns staging and recovery.
const saveProviders = new Map([["google-drive", googleDrive]]);
const jobStore = new JobStore(DATA_ROOT);
const jobsReady = jobStore.load().then(records => {
  for (const job of records) {
    if (["queued", "running"].includes(job.status)) {
      job.status = "paused";
      job.error = "App restarted. Resume when ready.";
      for (const item of job.items) if (item.status === "running") { item.status = "queued"; item.downloadedBytes = 0; }
    }
    job.progressSamples = [];
    state.downloadJobs.set(job.id, job);
  }
});

const THUMBNAIL_CACHE_TTL_MS = 5 * 60 * 1000;

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ${req.method || "GET"} ${(req.url || "/").split("?")[0]} failed:`,
        error.message
      );
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, error.statusCode || 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
}

async function routeRequest(req, res) {
  const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  if (!allowedHosts.includes((req.headers.host || "").toLowerCase())) throw Object.assign(new Error("Open the app through its local address"), { statusCode: 403 });
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`))) throw Object.assign(new Error("This action must come from the local app"), { statusCode: 403 });
  }
  await jobsReady;
  await googleDrive.ready;
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/api/cloud/google/status" && req.method === "GET") return sendJson(res, 200, { ...googleDrive.status(), canSwitch: !lockedCloudAccount() });
  if (pathname === "/api/cloud/google/cancel-authorization" && req.method === "POST") {
    await googleDrive.cancelAuthorization();
    return sendJson(res, 200, googleDrive.status());
  }
  if (pathname === "/api/cloud/google/disconnect" && req.method === "POST") {
    for (const job of state.downloadJobs.values()) if (job.destination?.type === "google-drive" && ["running", "queued"].includes(job.status)) {
      job.controller?.abort(); await job.task; job.status = "paused";
    }
    await jobStore.save(state.downloadJobs);
    await googleDrive.disconnect();
    return sendJson(res, 200, googleDrive.status());
  }
  if (pathname === "/api/cloud/google/folder" && req.method === "POST") return sendJson(res, 200, { folder: await googleDrive.createDefaultFolder() });
  if (pathname === "/oauth/google/callback" && req.method === "GET") {
    googleDrive.authInFlight += 1;
    try { await googleDrive.finishAuthorization(requestUrl.searchParams, lockedCloudAccount); }
    catch (error) { googleDrive.authorizationError = error.message; throw error; }
    finally { googleDrive.authInFlight -= 1; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end('<!doctype html><html><head><title>Google Drive connected</title></head><body><h1>Google Drive connected</h1><p>Return to GoPro Export to save your videos.</p><a href="/main">Open workspace</a></body></html>');
  }

  if (["/api/cloud/google/connect", "/api/cloud/google/folder-picker"].includes(pathname) && req.method === "POST") {
    const authorizationUrl = googleDrive.authorize(`http://${HOST}:${req.socket.localPort}/oauth/google/callback`, pathname.endsWith("folder-picker"), lockedCloudAccount());
    return sendJson(res, 200, { authorizationUrl, browserOpened: await openSystemBrowser(authorizationUrl) });
  }

  if (pathname === "/api/docs" && req.method === "GET") {
    return sendJson(res, 200, {
      docs: DOC_SUMMARY,
      references: {
        httpSpec: "https://gopro.github.io/OpenGoPro/http",
        mediaTutorial: "https://gopro.github.io/OpenGoPro/tutorials/camera-media-list",
        bleSpec: "https://gopro.github.io/OpenGoPro/ble"
      }
    });
  }

  if (pathname === "/api/discover" && req.method === "GET") {
    return sendJson(res, 200, {
      candidates: listCandidateUsbIps()
    });
  }

  if (pathname === "/api/status" && req.method === "GET") {
    const activeJob = findActiveDownloadJob();
    const recoverableJobs = [...state.downloadJobs.values()].reverse().filter(job => ["paused", "failed", "completed_with_errors"].includes(job.status));
    return sendJson(res, 200, {
      session: presentSession(),
      candidates: listCandidateUsbIps(),
      activeDownloadJob: activeJob ? presentDownloadJob(activeJob) : recoverableJobs[0] ? presentDownloadJob(recoverableJobs[0]) : null,
      recoverableJobs: recoverableJobs.map(presentDownloadJob)
    });
  }

  if (pathname === "/api/connect" && req.method === "POST") {
    if (state.preparingBatch || findActiveDownloadJob()) return sendJson(res, 409, { error: "Pause the current batch before changing the camera" });
    const body = await readJsonBody(req);
    const session = await connectToCamera(body || {});
    return sendJson(res, 200, {
      session: presentSession(session)
    });
  }

  if (pathname === "/api/disconnect" && req.method === "POST") {
    await disconnectCamera();
    return sendJson(res, 200, {
      ok: true
    });
  }

  if (pathname === "/api/media" && req.method === "GET") {
    ensureConnected();
    const payload = await fetchMediaList();
    return sendJson(res, 200, payload);
  }

  if (pathname === "/api/media/preview" && req.method === "GET") {
    ensureConnected();
    return proxyPreviewAsset(req, res, requestUrl.searchParams);
  }

  if (pathname === "/api/download-jobs" && req.method === "GET") {
    return sendJson(res, 200, { jobs: [...state.downloadJobs.values()].reverse().map(presentDownloadJob) });
  }

  if (["/api/download-jobs", "/api/download"].includes(pathname) && req.method === "POST") {
    ensureConnected();

    const activeJob = findActiveDownloadJob();
    if (activeJob || state.preparingBatch) {
      return sendJson(res, 409, {
        error: "Another save batch is preparing or running."
      });
    }
    state.preparingBatch = true;
    try {
      const body = await readJsonBody(req);
      const job = await createDownloadJob(body || {});
      return sendJson(res, 202, { job: presentDownloadJob(job) });
    } finally { state.preparingBatch = false; }
  }

  const downloadJobMatch = pathname.match(/^\/api\/download-jobs\/([a-z0-9-]+)$/i);
  if (downloadJobMatch && req.method === "GET") {
    const job = state.downloadJobs.get(downloadJobMatch[1]);
    if (!job) {
      return sendJson(res, 404, {
        error: "Download job not found."
      });
    }

    return sendJson(res, 200, {
      job: presentDownloadJob(job)
    });
  }

  const jobAction = pathname.match(/^\/api\/download-jobs\/([a-z0-9-]+)\/(pause|resume|discard|retry)$/i);
  if (jobAction && req.method === "POST") {
    const job = state.downloadJobs.get(jobAction[1]);
    if (!job) return sendJson(res, 404, { error: "Save batch not found" });
    if (state.preparingBatch || state.jobActions.has(job.id)) return sendJson(res, 409, { error: "Another batch operation is in progress. Try again when it finishes." });
    state.jobActions.add(job.id);
    try {
      if (jobAction[2] === "discard") {
        job.controller?.abort();
        await job.task;
        job.status = "discarded";
        for (const item of job.items) {
          if (item.partialPath) await removeOwnedTemporary(job.destination?.type === "google-drive" ? job.stagingRoot : job.downloadRoot, item.partialPath);
          item.stagedPath = null;
          item.encryptedUploadSession = null;
          item.sessionUrl = null;
          if (!["completed", "skipped"].includes(item.status)) item.status = "discarded";
        }
        await jobStore.save(state.downloadJobs);
      } else if (jobAction[2] === "pause") {
        job.controller?.abort();
        await job.task;
        if (!["completed", "completed_with_errors", "failed"].includes(job.status)) job.status = "paused";
        await jobStore.save(state.downloadJobs);
      } else {
        if (jobAction[2] === "retry") {
          if (!["failed", "completed_with_errors", "paused"].includes(job.status) || !job.items.some(item => item.status === "failed")) return sendJson(res, 409, { error: "No failed videos to retry" });
        } else if (job.status !== "paused") return sendJson(res, 409, { error: "Only a paused batch can resume" });
        if (findActiveDownloadJob()) return sendJson(res, 409, { error: "Another batch is running" });
        const needsCamera = job.items.some(item => !["completed", "skipped", "discarded"].includes(item.status) && !item.stagedPath);
        if (needsCamera) {
          ensureConnected();
          if (!job.cameraSerial || job.cameraSerial !== state.session.cameraInfo?.serial_number) return sendJson(res, 409, { error: "Reconnect the original camera" });
          job.targetIp = state.session.ip;
        }
        if (job.destination?.type === "google-drive" && googleDrive.status().account?.id !== job.destination.accountId) return sendJson(res, 409, { error: "Reconnect the original Google account" });
        if (jobAction[2] === "retry") for (const item of job.items) if (item.status === "failed") item.status = "queued";
        job.status = "queued";
        job.task = runDownloadJob(job);
      }
      return sendJson(res, 200, { job: presentDownloadJob(job) });
    } finally { state.jobActions.delete(job.id); }
  }

  if (pathname === "/" && req.method === "GET") {
    return serveStaticFile(res, path.join(PUBLIC_DIR, "index.html"));
  }

  if (pathname === "/main" && req.method === "GET") {
    return serveStaticFile(res, path.join(PUBLIC_DIR, "main.html"));
  }

  if (pathname.startsWith("/")) {
    const relativePath = pathname.replace(/^\/+/, "");
    const targetPath = path.normalize(path.join(PUBLIC_DIR, relativePath));
    if (targetPath.startsWith(PUBLIC_DIR) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      return serveStaticFile(res, targetPath);
    }
  }

  sendJson(res, 404, {
    error: "Not found"
  });
}

function sendJson(res, statusCode, payload) {
  const buffer = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > JSON_LIMIT_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStaticFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon"
    }[extension] || "application/octet-stream";

  const stat = await fsp.stat(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function listCandidateUsbIps() {
  const interfaces = os.networkInterfaces();
  const candidates = new Map();

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }
      if (!isLikelyGoProUsbHostAddress(address.address)) {
        continue;
      }

      const octets = address.address.split(".");
      const candidateIp = `${octets[0]}.${octets[1]}.${octets[2]}.51`;

      if (!candidates.has(candidateIp)) {
        candidates.set(candidateIp, {
          ip: candidateIp,
          source: `Detected from local interface ${name}`,
          hostAddress: address.address
        });
      }
    }
  }

  return Array.from(candidates.values()).sort((left, right) => left.ip.localeCompare(right.ip));
}

function isLikelyGoProUsbHostAddress(ipAddress) {
  const octets = ipAddress.split(".").map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN)) {
    return false;
  }

  const [, second, third, fourth] = octets;
  return second >= 20 && second <= 29 && third >= 100 && third <= 199 && fourth !== 51;
}

function computeUsbIpFromSerialSuffix(serialSuffix) {
  const digits = String(serialSuffix || "").trim();
  if (!/^\d{3}$/.test(digits)) {
    throw new Error("Serial suffix must be exactly 3 digits.");
  }

  const [x, y, z] = digits.split("").map(Number);
  return `172.${20 + x}.${100 + y * 10 + z}.51`;
}

async function connectToCamera(options) {
  const target = await resolveTargetCamera(options);

  await goproGet(target.ip, "/gopro/camera/control/wired_usb", {
    query: { p: 1 }
  });

  try {
    await goproGet(target.ip, "/gopro/camera/control/set_ui_controller", {
      query: { p: 2 }
    });
  } catch (error) {
    target.controlWarning = error instanceof Error ? error.message : String(error);
  }

  const [version, cameraName, cameraInfo] = await Promise.all([
    safeJson(target.ip, "/gopro/version"),
    safeJson(target.ip, "/gopro/camera/name"),
    safeJson(target.ip, "/gopro/camera/info")
  ]);

  clearKeepAlive();

  const session = {
    ip: target.ip,
    source: target.source,
    connectedAt: new Date().toISOString(),
    version: version && typeof version === "object" ? version.version || null : null,
    cameraName: cameraName && typeof cameraName === "object" ? cameraName.value || null : null,
    cameraInfo: cameraInfo && typeof cameraInfo === "object" ? cameraInfo : null,
    controlWarning: target.controlWarning || null,
    lastKeepAliveOkAt: null,
    lastKeepAliveError: null,
    keepAliveTimer: null
  };

  session.keepAliveTimer = setInterval(async () => {
    try {
      await goproGet(session.ip, "/gopro/camera/keep_alive", { timeoutMs: 1500 });
      session.lastKeepAliveOkAt = new Date().toISOString();
      session.lastKeepAliveError = null;
    } catch (error) {
      session.lastKeepAliveError = error instanceof Error ? error.message : String(error);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  session.keepAliveTimer.unref?.();
  state.session = session;

  try {
    await goproGet(session.ip, "/gopro/camera/keep_alive", { timeoutMs: 1500 });
    session.lastKeepAliveOkAt = new Date().toISOString();
  } catch (error) {
    session.lastKeepAliveError = error instanceof Error ? error.message : String(error);
  }

  return session;
}

async function resolveTargetCamera(options) {
  const manualIp = String(options.ip || "").trim();
  const serialSuffix = String(options.serialSuffix || "").trim();

  if (manualIp) {
    validateIpv4(manualIp);
    await probeCamera(manualIp);
    return {
      ip: manualIp,
      source: "Manual IP"
    };
  }

  if (serialSuffix) {
    const ip = computeUsbIpFromSerialSuffix(serialSuffix);
    await probeCamera(ip);
    return {
      ip,
      source: `Derived from serial suffix ${serialSuffix}`
    };
  }

  const candidates = listCandidateUsbIps();
  if (!candidates.length) {
    throw new Error(
      "No likely GoPro USB network interface was found. Connect the camera with USB-C, power it on, or enter the camera IP / serial suffix manually."
    );
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      await probeCamera(candidate.ip);
      return candidate;
    } catch (error) {
      failures.push(`${candidate.ip}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Found possible USB addresses but none responded like a GoPro: ${failures.join(" | ")}`
  );
}

async function probeCamera(ip) {
  const version = await safeJson(ip, "/gopro/version");
  const info = await safeJson(ip, "/gopro/camera/info");

  if (!version && !info) {
    throw new Error("The target did not respond to Open GoPro camera endpoints.");
  }
}

async function fetchMediaList() {
  const mediaList = await goproGetJson(state.session.ip, "/gopro/media/list", { timeoutMs: 10000 });
  const files = flattenMediaList(mediaList).filter(file => file.type === "Video");

  return {
    session: presentSession(),
    mediaListId: mediaList.id || null,
    count: files.length,
    files
  };
}

function flattenMediaList(mediaList) {
  const files = [];

  for (const directoryEntry of mediaList.media || []) {
    for (const fileEntry of directoryEntry.fs || []) {
      if (!fileEntry.n) {
        continue;
      }

      const filename = fileEntry.n;
      const extension = path.extname(filename).slice(1).toLowerCase();
      const previewDescriptor = buildPreviewDescriptor(directoryEntry.d, filename, fileEntry);
      files.push({
        directory: directoryEntry.d,
        name: filename,
        extension,
        type: describeFileType(extension),
        preview: previewDescriptor,
        lowResSizeBytes: Number(fileEntry.glrv || 0),
        sizeBytes: Number(fileEntry.s || 0),
        createdUnix: Number.isFinite(Number(fileEntry.cre)) ? Number(fileEntry.cre) : 0,
        modifiedUnix: Number(fileEntry.mod || 0),
        path: `${directoryEntry.d}/${filename}`
      });
    }
  }

  files.sort((left, right) => (right.createdUnix || 0) - (left.createdUnix || 0) || left.name.localeCompare(right.name));
  return files;
}

function describeFileType(extension) {
  if (isVideoExtension(extension)) {
    return "Video";
  }
  if (isPhotoExtension(extension)) {
    return "Photo";
  }
  if (extension === "thm") {
    return "Thumbnail";
  }
  if (extension === "lrv") {
    return "Proxy video";
  }
  return "Other";
}

function isVideoExtension(extension) {
  return ["mp4", "mov"].includes(String(extension || "").toLowerCase());
}

function isPhotoExtension(extension) {
  return ["jpg", "jpeg", "png", "gpr"].includes(String(extension || "").toLowerCase());
}

function buildPreviewDescriptor(directory, filename, fileEntry) {
  const extension = path.extname(filename).slice(1).toLowerCase();
  const search = new URLSearchParams({
    directory,
    name: filename
  });

  if (isVideoExtension(extension)) {
    return {
      available: true,
      kind: "video",
      label: "Low-res proxy preview",
      url: `/api/media/preview?assetType=video&${search.toString()}`,
      thumbnailUrl: `/api/media/preview?assetType=thumbnail&${search.toString()}`,
      posterUrl: `/api/media/preview?assetType=thumbnail&${search.toString()}`,
      proxyCandidates: buildVideoPreviewCandidates(directory, filename),
      lowResSizeBytes: Number(fileEntry.glrv || 0)
    };
  }

  if (isPhotoExtension(extension)) {
    return {
      available: true,
      kind: "image",
      label: "Photo screennail preview",
      url: `/api/media/preview?assetType=image&${search.toString()}`,
      thumbnailUrl: `/api/media/preview?assetType=thumbnail&${search.toString()}`,
      posterUrl: null,
      proxyCandidates: []
    };
  }

  return {
    available: false,
    kind: null,
    label: "No preview",
    url: null,
    thumbnailUrl: null,
    posterUrl: null,
    proxyCandidates: []
  };
}

function buildVideoPreviewCandidates(directory, filename) {
  const parsed = path.parse(filename);
  const baseName = parsed.name.toUpperCase();
  const candidates = [];
  const seen = new Set();

  function addCandidate(candidateDirectory, candidateName) {
    const key = `${candidateDirectory}/${candidateName}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({
        directory: candidateDirectory,
        name: candidateName
      });
    }
  }

  if (baseName.startsWith("GOPR") && baseName.length > 4) {
    addCandidate(directory, `GLPR${baseName.slice(4)}.LRV`);
  }

  if (baseName.startsWith("G") && baseName.length > 2) {
    addCandidate(directory, `GL${baseName.slice(2)}.LRV`);
  }

  addCandidate(directory, `${baseName}.LRV`);

  return candidates;
}

function buildVideoThumbnailCandidates(directory, filename) {
  return buildVideoSiblingCandidates(directory, filename, "THM");
}

function buildPhotoPreviewCandidates(directory, filename) {
  const parsed = path.parse(filename);
  const upperExtension = parsed.ext.replace(".", "").toUpperCase();
  const candidates = [];
  const seen = new Set();

  function addCandidate(candidateDirectory, candidateName) {
    const key = `${candidateDirectory}/${candidateName}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({
        directory: candidateDirectory,
        name: candidateName
      });
    }
  }

  addCandidate(directory, filename);

  if (upperExtension === "GPR") {
    addCandidate(directory, `${parsed.name}.JPG`);
  }

  return candidates;
}

function buildVideoSiblingCandidates(directory, filename, targetExtension) {
  const parsed = path.parse(filename);
  const baseName = parsed.name.toUpperCase();
  const upperExtension = String(targetExtension || "").toUpperCase();
  const candidates = [];
  const seen = new Set();

  function addCandidate(candidateDirectory, candidateName) {
    const key = `${candidateDirectory}/${candidateName}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({
        directory: candidateDirectory,
        name: candidateName
      });
    }
  }

  if (baseName.startsWith("GOPR") && baseName.length > 4) {
    addCandidate(directory, `GLPR${baseName.slice(4)}.${upperExtension}`);
  }

  if (baseName.startsWith("G") && baseName.length > 2) {
    addCandidate(directory, `GL${baseName.slice(2)}.${upperExtension}`);
  }

  addCandidate(directory, `${baseName}.${upperExtension}`);

  return candidates;
}

async function proxyPreviewAsset(req, res, searchParams) {
  const assetType = String(searchParams.get("assetType") || "").trim().toLowerCase();
  const directory = sanitizePathPart(searchParams.get("directory"), "100GOPRO");
  const name = sanitizePathPart(searchParams.get("name"), "media.bin");
  const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : null;

  if (!assetType) {
    throw new Error("Preview asset type is required.");
  }

  if (assetType === "video") {
    const candidates = buildVideoPreviewCandidates(directory, name);
    const previewResponse = await tryMediaFileCandidates(state.session.ip, candidates, {
      timeoutMs: 0,
      headers: buildPreviewRequestHeaders(rangeHeader)
    });

    if (previewResponse) {
      return proxyBinaryResponse(res, previewResponse.response, {
        contentType: "video/mp4",
        filename: previewResponse.candidate.name
      });
    }

    const sourceResponse = await goproGet(state.session.ip, buildMediaDownloadEndpoint(directory, name), {
      timeoutMs: 0,
      headers: buildPreviewRequestHeaders(rangeHeader)
    });

    return proxyBinaryResponse(res, sourceResponse, {
      filename: name
    });
  }

  if (assetType === "image") {
    const photoPreview = await tryPhotoPreview(state.session.ip, directory, name);
    if (!photoPreview) {
      throw new Error(`No preview image was found for ${directory}/${name}.`);
    }

    return proxyBinaryResponse(res, photoPreview.response, {
      contentType: "image/jpeg",
      filename: `${path.parse(photoPreview.candidate.name).name}-preview.jpg`
    });
  }

  if (assetType === "thumbnail") {
    const thumbnail = await getCachedThumbnail(state.session.ip, directory, name);
    return sendBinary(res, 200, thumbnail.buffer, {
      "Content-Type": thumbnail.contentType,
      "Content-Length": thumbnail.buffer.length,
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${sanitizePathPart(thumbnail.filename, "thumbnail.jpg")}"`
    });
  }

  throw new Error(`Unsupported preview asset type: ${assetType}`);
}

async function tryPhotoPreview(ip, directory, name) {
  for (const candidate of buildPhotoPreviewCandidates(directory, name)) {
    const screennailResponse = await tryPreviewEndpoint(ip, "/gopro/media/screennail", candidate);
    if (screennailResponse) {
      return screennailResponse;
    }

    const thumbnailResponse = await tryPreviewEndpoint(ip, "/gopro/media/thumbnail", candidate);
    if (thumbnailResponse) {
      return thumbnailResponse;
    }
  }

  for (const candidate of buildPhotoPreviewCandidates(directory, name)) {
    if (!isDirectPreviewableImage(candidate.name)) {
      continue;
    }

    const response = await tryMediaFileCandidates(ip, [candidate], {
      timeoutMs: 0
    });
    if (response) {
      return response;
    }
  }

  return null;
}

async function tryThumbnailPreview(ip, directory, name) {
  const endpointThumbnail = await tryPreviewEndpoint(ip, "/gopro/media/thumbnail", {
    directory,
    name
  });
  if (endpointThumbnail) {
    return endpointThumbnail;
  }

  const thmResponse = await tryMediaFileCandidates(ip, buildVideoThumbnailCandidates(directory, name), {
    timeoutMs: 0
  });
  if (thmResponse) {
    return thmResponse;
  }

  if (isPhotoExtension(path.extname(name).slice(1))) {
    return tryPhotoPreview(ip, directory, name);
  }

  return null;
}

async function tryPreviewEndpoint(ip, endpoint, candidate) {
  try {
    const response = await goproGet(ip, endpoint, {
      query: {
        path: `${candidate.directory}/${candidate.name}`
      },
      timeoutMs: 10000
    });

    return {
      candidate,
      response
    };
  } catch (error) {
    if (isPreviewUnavailableError(error)) {
      return null;
    }

    throw error;
  }
}

async function getCachedThumbnail(ip, directory, name) {
  const cacheKey = `${ip}|${directory}|${name}`;
  const now = Date.now();
  const cached = state.thumbnailCache.get(cacheKey);

  if (cached && now - cached.createdAt < THUMBNAIL_CACHE_TTL_MS) {
    return cached;
  }

  if (state.thumbnailPending.has(cacheKey)) {
    return state.thumbnailPending.get(cacheKey);
  }

  const pending = enqueueThumbnailWork(async () => {
    const previewResponse = await tryThumbnailPreview(ip, directory, name);
    if (!previewResponse) {
      throw new Error(`No thumbnail was found for ${directory}/${name}.`);
    }

    const buffer = Buffer.from(await previewResponse.response.arrayBuffer());
    const entry = {
      createdAt: Date.now(),
      filename: `${path.parse(previewResponse.candidate.name).name}-thumbnail.jpg`,
      contentType: "image/jpeg",
      buffer
    };

    state.thumbnailCache.set(cacheKey, entry);
    return entry;
  }).finally(() => {
    state.thumbnailPending.delete(cacheKey);
  });

  state.thumbnailPending.set(cacheKey, pending);
  return pending;
}

function enqueueThumbnailWork(task) {
  const work = state.thumbnailQueue.then(task, task);
  state.thumbnailQueue = work.catch(() => {});
  return work;
}

async function tryMediaFileCandidates(ip, candidates, options = {}) {
  for (const candidate of candidates) {
    try {
      const response = await goproGet(ip, buildMediaDownloadEndpoint(candidate.directory, candidate.name), options);
      return {
        candidate,
        response
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

async function proxyBinaryResponse(res, response, options = {}) {
  if (!response.body) {
    throw new Error("The GoPro did not provide preview data.");
  }

  const headers = {
    "Content-Type": options.contentType || response.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store"
  };

  for (const headerName of ["content-length", "content-range", "accept-ranges"]) {
    const headerValue = response.headers.get(headerName);
    if (headerValue) {
      headers[toHeaderCase(headerName)] = headerValue;
    }
  }

  if (options.filename) {
    headers["Content-Disposition"] = `inline; filename="${sanitizePathPart(options.filename, "preview.bin")}"`;
  }

  res.writeHead(response.status || 200, headers);
  await pipeline(Readable.fromWeb(response.body), res);
}

function sendBinary(res, statusCode, buffer, headers = {}) {
  res.writeHead(statusCode, headers);
  res.end(buffer);
}

function isMissingFileError(error) {
  return Boolean(error && (error.status === 404 || /HTTP 404/i.test(String(error.message || ""))));
}

function isPreviewUnavailableError(error) {
  return Boolean(
    error &&
      (error.status === 400 ||
        error.status === 404 ||
        /HTTP 400/i.test(String(error.message || "")) ||
        /HTTP 404/i.test(String(error.message || "")))
  );
}

function isDirectPreviewableImage(filename) {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return ["jpg", "jpeg", "png"].includes(extension);
}

function buildMediaDownloadEndpoint(directory, filename) {
  return `/videos/DCIM/${encodeURIComponent(directory)}/${encodeURIComponent(filename)}`;
}

function buildPreviewRequestHeaders(rangeHeader) {
  if (!rangeHeader) {
    return undefined;
  }

  return {
    Range: rangeHeader
  };
}

function toHeaderCase(headerName) {
  return String(headerName)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

async function createDownloadJob(options) {
  const plan = await prepareDownloadPlan(options);

  const job = {
    id: randomUUID(),
    targetIp: state.session.ip,
    cameraSerial: state.session.cameraInfo?.serial_number || null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    status: "queued",
    error: null,
    downloadRoot: plan.downloadRoot,
    recordingTimezone: plan.recordingTimezone,
    destination: plan.destination,
    stagingRoot: plan.stagingRoot,
    items: plan.items.map((item, index) => ({
      id: `${index + 1}`,
      directory: item.directory,
      name: item.name,
      outputPath: item.outputPath,
      sizeBytes: Number(item.sizeBytes || 0),
      createdUnix: item.createdUnix,
      recordingDate: item.recordingDate,
      downloadedBytes: 0,
      status: "queued",
      error: null
    })),
    completedFiles: 0,
    completedBytes: 0,
    progressSamples: []
  };

  recordJobProgress(job);
  state.downloadJobs.set(job.id, job);
  try { await jobStore.save(state.downloadJobs); }
  catch (error) { state.downloadJobs.delete(job.id); throw Object.assign(new Error("The batch could not be stored. Restore access to the app's data folder and try again."), { statusCode: 507 }); }

  setImmediate(() => {
    if (job.status === "queued") job.task = runDownloadJob(job);
  });

  return job;
}

async function runDownloadJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.error = null;
  job.controller = new AbortController();
  job.completedFiles = job.items.filter(item => ["completed", "skipped"].includes(item.status)).length;
  job.completedBytes = job.items.filter(item => ["completed", "skipped"].includes(item.status)).reduce((sum, item) => sum + item.sizeBytes, 0);
  recordJobProgress(job);

  try {
    await jobStore.save(state.downloadJobs);
    const provider = saveProviders.get(job.destination?.type);
    const cloud = !!provider;
    if (provider) await provider.validateDestination(job.destination);
    await fsp.mkdir(cloud ? job.stagingRoot : job.downloadRoot, { recursive: true });

    for (const item of job.items) {
      if (job.controller.signal.aborted) break;
      if (["completed", "skipped", "failed"].includes(item.status)) continue;
      item.status = "running";
      item.error = null;
      item.downloadedBytes = item.stagedPath ? item.sizeBytes : 0;
      item.partialPath = item.partialPath || (cloud ? path.join(job.stagingRoot, `${job.id}-${item.id}.part`) : `${item.outputPath}.${randomUUID()}.part`);
      await jobStore.save(state.downloadJobs);

      if (!cloud) await fsp.mkdir(path.dirname(item.outputPath), { recursive: true });

      try {
        let result;
        if (!item.stagedPath) {
          const availableOriginals = (await fetchMediaList()).files;
          const source = availableOriginals.find(file => file.directory === item.directory && file.name === item.name);
          if (!source || source.sizeBytes !== item.sizeBytes || source.createdUnix !== item.createdUnix) throw new Error("Camera original changed or is unavailable. The planned original was not saved.");
          await removeOwnedTemporary(cloud ? job.stagingRoot : job.downloadRoot, item.partialPath);
          const available = process.env.NODE_ENV === "test" && process.env.GOPRO_TEST_FREE_BYTES !== undefined
            ? BigInt(process.env.GOPRO_TEST_FREE_BYTES)
            : await freeDiskBytes(cloud ? job.stagingRoot : path.dirname(item.outputPath));
          if (available < BigInt(item.sizeBytes)) throw Object.assign(new Error("Not enough local space for the next original. Free space or discard retained work, then resume."), { pause: true });
          item.stage = "downloading";
          result = await downloadRemoteFile(job.targetIp, item, item.outputPath, ({ downloadedBytes }) => {
            item.downloadedBytes = downloadedBytes;
            recordJobProgress(job);
          }, job.controller.signal, cloud);
          if (cloud) {
            item.stagedPath = result.outputPath;
            item.md5 = result.md5;
            item.sha256 = result.sha256;
            await jobStore.save(state.downloadJobs);
          }
        }
        if (cloud) {
          item.stage = "uploading";
          result = await provider.saveOriginal(item, job.destination, () => jobStore.save(state.downloadJobs), job.controller.signal, () => recordJobProgress(job));
          await removeOwnedTemporary(job.stagingRoot, item.stagedPath);
          item.stagedPath = null;
          item.encryptedUploadSession = null;
          item.sessionUrl = null;
        }

        item.downloadedBytes = result.downloadedBytes;
        item.outputPath = result.outputPath;
        item.status = result.skipped ? "skipped" : "completed";
        item.stage = "saved";
        job.completedFiles += 1;
        job.completedBytes += result.downloadedBytes;
        recordJobProgress(job);
        await jobStore.save(state.downloadJobs);
      } catch (error) {
        if (job.controller.signal.aborted) { item.status = "queued"; item.downloadedBytes = item.stagedPath ? item.sizeBytes : 0; break; }
        if (error.pause || isStorageAccessError(error)) {
          item.status = "queued";
          job.status = "paused";
          job.error = error.message;
          break;
        }
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        job.error = item.error;
        recordJobProgress(job);
      }
    }

    job.status = job.status === "paused" || job.controller.signal.aborted ? "paused" : job.items.some(item => item.status === "failed")
      ? (job.completedFiles ? "completed_with_errors" : "failed") : "completed";
  } catch (error) {
    if (job.status !== "failed") {
      job.status = error.pause || isStorageAccessError(error) ? "paused" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    recordJobProgress(job);
    try { await jobStore.save(state.downloadJobs); }
    catch { job.status = "paused"; job.error = "Recovery state could not be stored. Restore space and access to the app's data folder before resuming."; }
  }
}

async function prepareDownloadPlan(options) {
  if (options.destination && !["local", "google-drive"].includes(options.destination.type)) throw Object.assign(new Error("Choose local saving or Google Drive"), { statusCode: 400 });
  const recordingTimezone = options.recordingTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en", { timeZone: recordingTimezone }); }
  catch { throw Object.assign(new Error("Choose a valid recording timezone, for example Asia/Jerusalem or UTC"), { statusCode: 400 }); }
  const requestedFiles = Array.isArray(options.files) ? options.files : [];
  const availableFiles = (await fetchMediaList()).files;
  const payload = requestedFiles.length ? requestedFiles.map(requested => {
    const found = availableFiles.find(item => item.directory === requested.directory && item.name === requested.name);
    if (!found) throw Object.assign(new Error(`Original video unavailable: ${requested.name}`), { statusCode: 400 });
    return found;
  }) : availableFiles;

  if (!payload.length) {
    throw Object.assign(new Error("There are no original videos to save."), { statusCode: 400 });
  }

  const baseRoot = resolveDownloadRoot(options.downloadRoot);
  const downloadRoot = baseRoot;
  const destination = options.destination?.type === "google-drive" ? { type: "google-drive", folderId: options.destination.folderId || googleDrive.status().folder?.id, accountId: googleDrive.status().account?.id } : { type: "local" };
  if (destination.type === "google-drive") {
    if (googleDrive.status().authorizationPending) throw Object.assign(new Error("Finish Google account selection before starting a batch"), { statusCode: 409 });
    if (options.destination.accountId && options.destination.accountId !== destination.accountId) throw Object.assign(new Error("The selected Google account changed. Check the account and try again."), { statusCode: 409 });
    if (!destination.accountId || !destination.folderId) throw Object.assign(new Error("Connect Google and choose a destination folder first"), { statusCode: 400 });
    const folder = await googleDrive.validateDestination(destination);
    destination.name = folder.name;
    destination.accountEmail = googleDrive.status().account.email;
    if (googleDrive.status().authorizationPending || googleDrive.status().account?.id !== destination.accountId) throw Object.assign(new Error("The selected Google account changed. Check the account and try again."), { statusCode: 409 });
  }

  return {
    downloadRoot,
    recordingTimezone,
    destination,
    stagingRoot: options.stagingRoot ? path.resolve(options.stagingRoot) : path.join(DATA_ROOT, "staging"),
    items: payload.map((item) => createDownloadItem(item, downloadRoot, recordingTimezone))
  };
}

function createDownloadItem(item, downloadRoot, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const directory = sanitizePathPart(item.directory, "100GOPRO");
  const name = sanitizePathPart(item.name, "media.bin");

  return {
    directory,
    name,
    sizeBytes: Number(item.sizeBytes || 0),
    createdUnix: item.createdUnix,
    recordingDate: recordingDay(item.createdUnix, timezone),
    outputPath: path.join(downloadRoot, recordingDay(item.createdUnix, timezone), name)
  };
}

function recordingDay(seconds, timezone) {
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0 || Number.isNaN(date.getTime())) return "Unknown date";
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type).value).join("-");
}

async function downloadRemoteFile(ip, item, outputPath, onProgress, signal, stageOnly = false) {
  const response = await goproGet(ip, buildMediaDownloadEndpoint(item.directory, item.name), {
    timeoutMs: 0,
    signal
  });

  if (!response.body) {
    throw new Error(`GoPro did not return file content for ${item.directory}/${item.name}.`);
  }

  const headerSize = Number(response.headers.get("content-length") || 0);
  const totalBytes = headerSize || Number(item.sizeBytes || 0);
  let downloadedBytes = 0;
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  const partialPath = item.partialPath || `${outputPath}.${randomUUID()}.part`;
  await fsp.rm(partialPath, { force: true });

  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      md5.update(chunk);
      sha256.update(chunk);
      if (typeof onProgress === "function") {
        onProgress({
          downloadedBytes,
          totalBytes
        });
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(partialPath, { flags: "wx" }), { signal });
    if (!item.sizeBytes || downloadedBytes !== item.sizeBytes) {
      throw new Error(`Incomplete original ${item.name}: received ${downloadedBytes} of ${item.sizeBytes} bytes.`);
    }
  } catch (error) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }

  if (stageOnly) return { outputPath: partialPath, downloadedBytes, totalBytes, md5: md5.digest("hex"), sha256: sha256.digest("hex") };

  let skipped = false;
  const dateDirectory = path.dirname(outputPath);
  try {
    for (let conflict = 0; ; conflict += 1) {
      if (conflict) outputPath = path.join(dateDirectory, `Conflicts-${conflict}`, item.name);
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      try {
        try { await fsp.link(partialPath, outputPath); }
        catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) throw error;
          await copyExclusive(partialPath, outputPath, signal);
        }
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if ((await fileDigest(partialPath)) === (await fileDigest(outputPath))) { skipped = true; break; }
      }
    }
  } finally {
    await fsp.rm(partialPath, { force: true });
  }

  return {
    downloadedBytes,
    totalBytes,
    skipped,
    outputPath
  };
}

async function fileDigest(filename, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function freeDiskBytes(folder) {
  const space = await fsp.statfs(folder, { bigint: true });
  return space.bavail * space.bsize;
}

function isStorageAccessError(error) {
  return ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "ENOTDIR", "EEXIST"].includes(error.code);
}

async function copyExclusive(source, target, signal) {
  const handle = await fsp.open(target, "wx");
  try {
    for await (const chunk of fs.createReadStream(source, { signal })) await handle.writeFile(chunk);
    await handle.sync();
  } catch (error) {
    const owned = await handle.stat();
    await handle.close();
    const current = await fsp.stat(target).catch(() => null);
    if (current && current.ino === owned.ino && current.dev === owned.dev) await fsp.rm(target);
    throw error;
  } finally { await handle.close().catch(() => {}); }
}

async function removeOwnedTemporary(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !filename.endsWith(".part")) throw new Error("Unsafe temporary-file cleanup path");
  await fsp.rm(filename, { force: true });
}

function findActiveDownloadJob() {
  for (const job of state.downloadJobs.values()) {
    if (job.status === "queued" || job.status === "running") {
      return job;
    }
  }

  return null;
}

function lockedCloudAccount() {
  return [...state.downloadJobs.values()].find(job => job.destination?.type === "google-drive" && job.items.some(item => !["completed", "skipped", "discarded"].includes(item.status)))?.destination.accountId || null;
}

function presentDownloadJob(job) {
  const cloud = job.destination?.type === "google-drive";
  const runningItem = job.items.find((item) => item.status === "running") || null;
  const totalFiles = job.items.length;
  const totalBytes = job.items.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0) * (cloud ? 2 : 1);
  const transferredBytes = getJobTransferredBytes(job);
  const speedBytesPerSecond = calculateTransferRate(job);
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  const currentItem = runningItem
    ? {
        directory: runningItem.directory,
        name: runningItem.name,
        downloadedBytes: runningItem.downloadedBytes,
        stage: runningItem.stage,
        stageBytes: cloud && ["uploading", "verifying"].includes(runningItem.stage) ? (runningItem.uploadedBytes || 0) : runningItem.downloadedBytes,
        sizeBytes: Number(runningItem.sizeBytes || 0),
        percent: calculatePercent(cloud && ["uploading", "verifying"].includes(runningItem.stage) ? runningItem.uploadedBytes : runningItem.downloadedBytes, runningItem.sizeBytes),
        remainingBytes: Math.max(0, Number(runningItem.sizeBytes || 0) - Number(runningItem.downloadedBytes || 0)),
        etaSeconds: calculateEtaSeconds(
          Math.max(0, Number(runningItem.sizeBytes || 0) - Number(runningItem.downloadedBytes || 0)),
          speedBytesPerSecond
        )
      }
    : null;

  return {
    id: job.id,
    targetIp: job.targetIp,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    downloadRoot: job.downloadRoot,
    recordingTimezone: job.recordingTimezone,
    destination: job.destination,
    totalFiles,
    completedFiles: job.completedFiles,
    totalBytes,
    transferredBytes,
    remainingBytes,
    overallPercent: Math.min(job.status === "completed" ? 100 : 99, calculatePercent(transferredBytes, totalBytes) || 0),
    retainedBytes: job.items.reduce((sum, item) => sum + (item.stagedPath ? Number(item.sizeBytes || 0) : 0), 0),
    speedBytesPerSecond,
    etaSeconds: calculateEtaSeconds(remainingBytes, speedBytesPerSecond),
    currentItem,
    files: job.items.map((item) => ({
      directory: item.directory,
      name: item.name,
      sizeBytes: item.sizeBytes,
      recordingDate: item.recordingDate,
      downloadedBytes: item.downloadedBytes,
      status: item.status,
      savedTo: item.outputPath,
      driveFileId: item.driveFileId,
      stage: item.stage,
      uploadedBytes: item.uploadedBytes || 0,
      retainedBytes: item.stagedPath ? item.sizeBytes : 0,
      error: item.error
    }))
  };
}

function recordJobProgress(job) {
  if (!job) {
    return;
  }

  const sample = {
    at: Date.now(),
    bytes: getJobTransferredBytes(job)
  };

  job.progressSamples.push(sample);

  const cutoff = sample.at - JOB_PROGRESS_SAMPLE_TTL_MS;
  job.progressSamples = job.progressSamples
    .filter((entry) => entry.at >= cutoff)
    .slice(-JOB_PROGRESS_SAMPLE_LIMIT);
}

function getJobTransferredBytes(job) {
  const cloud = job.destination?.type === "google-drive";
  return job.items.reduce((sum, item) => sum + (["completed", "skipped"].includes(item.status) ? Number(item.sizeBytes || 0) * (cloud ? 2 : 1) : Number(item.downloadedBytes || 0) + (cloud ? Number(item.uploadedBytes || 0) : 0)), 0);
}

function calculateTransferRate(job) {
  if (!job || job.status !== "running") {
    return null;
  }

  const samples = getProgressSamplesForRate(job);
  if (samples.length < 2) {
    return null;
  }

  const latest = samples[samples.length - 1];
  const recentSamples = samples.filter((sample) => latest.at - sample.at <= 8000);
  let baseline = recentSamples[0] || samples[0];

  if (latest.at - baseline.at < 1000) {
    baseline = samples[0];
  }

  const elapsedMs = latest.at - baseline.at;
  const deltaBytes = latest.bytes - baseline.bytes;

  if (elapsedMs <= 0 || deltaBytes < 0) {
    return null;
  }

  return Number(((deltaBytes / elapsedMs) * 1000).toFixed(1));
}

function getProgressSamplesForRate(job) {
  const samples = Array.isArray(job.progressSamples) ? [...job.progressSamples] : [];
  const transferredBytes = getJobTransferredBytes(job);
  const now = Date.now();
  const latestSample = samples[samples.length - 1];

  if (!latestSample || latestSample.at !== now || latestSample.bytes !== transferredBytes) {
    samples.push({
      at: now,
      bytes: transferredBytes
    });
  }

  return samples;
}

function calculateEtaSeconds(remainingBytes, speedBytesPerSecond) {
  const remaining = Number(remainingBytes || 0);
  const rate = Number(speedBytesPerSecond || 0);

  if (!remaining || !rate) {
    return null;
  }

  return Math.max(1, Math.ceil(remaining / rate));
}

function calculatePercent(value, total) {
  const numerator = Number(value || 0);
  const denominator = Number(total || 0);

  if (!denominator) {
    return null;
  }

  return Math.max(0, Math.min(100, Number(((numerator / denominator) * 100).toFixed(1))));
}

function resolveDownloadRoot(downloadRoot) {
  const input = String(downloadRoot || "").trim();
  if (!input) {
    return DEFAULT_DOWNLOAD_ROOT;
  }

  return path.isAbsolute(input) ? input : path.resolve(__dirname, input);
}

function sanitizePathPart(value, fallback) {
  const cleaned = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  return cleaned || fallback;
}

function slugify(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "gopro"
  );
}

function validateIpv4(ip) {
  const octets = ip.split(".");
  if (octets.length !== 4) {
    throw new Error("Camera IP must be a valid IPv4 address.");
  }

  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error("Camera IP must be a valid IPv4 address.");
    }
  }
}

async function goproGetJson(ip, pathname, options = {}) {
  const response = await goproGet(ip, pathname, options);
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function safeJson(ip, pathname) {
  try {
    return await goproGetJson(ip, pathname, { timeoutMs: 2500 });
  } catch (error) {
    return null;
  }
}

async function goproGet(ip, pathname, options = {}) {
  const cameraPort = process.env.NODE_ENV === "test" ? Number(process.env.GOPRO_CAMERA_PORT || 8080) : 8080;
  const requestUrl = new URL(`http://${ip}:${cameraPort}${pathname}`);

  for (const [key, value] of Object.entries(options.query || {})) {
    requestUrl.searchParams.set(key, String(value));
  }

  const timeoutMs = options.timeoutMs === undefined ? 4000 : options.timeoutMs;
  let timeoutHandle = null;
  let controller = null;

  if (timeoutMs > 0) {
    controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetch(requestUrl, {
      method: options.method || "GET",
      headers: options.headers,
      signal: controller ? (options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal) : options.signal
    });

    if (!response.ok) {
      const error = new Error(`GoPro responded with HTTP ${response.status} for ${pathname}.`);
      error.status = response.status;
      throw error;
    }

    return response;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Timed out contacting ${requestUrl}.`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function disconnectCamera() {
  if (!state.session) {
    return;
  }

  const { ip } = state.session;
  clearKeepAlive();

  try {
    await goproGet(ip, "/gopro/camera/control/wired_usb", {
      query: { p: 0 },
      timeoutMs: 1500
    });
  } catch (error) {
    // Best effort only. The local session is still cleared.
  }

  state.session = null;
}

function clearKeepAlive() {
  if (state.session && state.session.keepAliveTimer) {
    clearInterval(state.session.keepAliveTimer);
    state.session.keepAliveTimer = null;
  }
}

function ensureConnected() {
  if (!state.session) {
    throw new Error("Connect to the GoPro first.");
  }
}

function presentSession(sourceSession = state.session) {
  if (!sourceSession) {
    return null;
  }

  return {
    ip: sourceSession.ip,
    source: sourceSession.source,
    connectedAt: sourceSession.connectedAt,
    version: sourceSession.version,
    cameraName: sourceSession.cameraName,
    cameraInfo: sourceSession.cameraInfo,
    controlWarning: sourceSession.controlWarning,
    lastKeepAliveOkAt: sourceSession.lastKeepAliveOkAt,
    lastKeepAliveError: sourceSession.lastKeepAliveError
  };
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`GoPro USB app running at http://${HOST}:${server.address().port}`);
  });

  const shutdown = async () => {
    clearKeepAlive();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  buildVideoPreviewCandidates,
  createServer,
  computeUsbIpFromSerialSuffix,
  flattenMediaList,
  listCandidateUsbIps
};
