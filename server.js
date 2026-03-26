const http = require("http");
const { randomUUID } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_DOWNLOAD_ROOT = path.join(__dirname, "downloads");
const KEEP_ALIVE_INTERVAL_MS = 3000;
const JSON_LIMIT_BYTES = 1024 * 128;

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
  downloadJobs: new Map()
};

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ${req.method || "GET"} ${req.url || "/"} failed:`,
        error
      );
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
}

async function routeRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

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
    return sendJson(res, 200, {
      session: presentSession(),
      candidates: listCandidateUsbIps(),
      activeDownloadJob: activeJob ? presentDownloadJob(activeJob) : null
    });
  }

  if (pathname === "/api/connect" && req.method === "POST") {
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

  if (pathname === "/api/download" && req.method === "POST") {
    ensureConnected();
    const body = await readJsonBody(req);
    const result = await downloadMedia(body || {});
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/download-jobs" && req.method === "POST") {
    ensureConnected();

    const activeJob = findActiveDownloadJob();
    if (activeJob) {
      return sendJson(res, 409, {
        error: `A download is already running for job ${activeJob.id}.`
      });
    }

    const body = await readJsonBody(req);
    const job = await createDownloadJob(body || {});
    return sendJson(res, 202, {
      job: presentDownloadJob(job)
    });
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

  if (pathname === "/" && req.method === "GET") {
    return serveStaticFile(res, path.join(PUBLIC_DIR, "index.html"));
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
  const files = flattenMediaList(mediaList);

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
        createdUnix: Number(fileEntry.cre || 0),
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
      posterUrl: null,
      proxyCandidates: []
    };
  }

  return {
    available: false,
    kind: null,
    label: "No preview",
    url: null,
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
    const previewResponse = await tryThumbnailPreview(state.session.ip, directory, name);
    if (!previewResponse) {
      throw new Error(`No thumbnail was found for ${directory}/${name}.`);
    }

    return proxyBinaryResponse(res, previewResponse.response, {
      contentType: "image/jpeg",
      filename: `${path.parse(previewResponse.candidate.name).name}-thumbnail.jpg`
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
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
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

function isMissingFileError(error) {
  return Boolean(error && (error.status === 404 || /HTTP 404/i.test(String(error.message || ""))));
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

async function downloadMedia(options) {
  const plan = await prepareDownloadPlan(options);
  await fsp.mkdir(plan.downloadRoot, { recursive: true });

  const downloaded = [];
  for (const item of plan.items) {
    await fsp.mkdir(path.dirname(item.outputPath), { recursive: true });
    const result = await downloadRemoteFile(state.session.ip, item, item.outputPath);

    downloaded.push({
      directory: item.directory,
      name: item.name,
      savedTo: item.outputPath,
      sizeBytes: result.downloadedBytes
    });
  }

  return {
    ok: true,
    root: plan.downloadRoot,
    count: downloaded.length,
    files: downloaded
  };
}

async function createDownloadJob(options) {
  const plan = await prepareDownloadPlan(options);

  const job = {
    id: randomUUID(),
    targetIp: state.session.ip,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    status: "queued",
    error: null,
    downloadRoot: plan.downloadRoot,
    items: plan.items.map((item, index) => ({
      id: `${index + 1}`,
      directory: item.directory,
      name: item.name,
      outputPath: item.outputPath,
      sizeBytes: Number(item.sizeBytes || 0),
      downloadedBytes: 0,
      status: "queued",
      error: null
    })),
    completedFiles: 0,
    completedBytes: 0
  };

  state.downloadJobs.set(job.id, job);

  setImmediate(() => {
    void runDownloadJob(job);
  });

  return job;
}

async function runDownloadJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.error = null;

  try {
    await fsp.mkdir(job.downloadRoot, { recursive: true });

    for (const item of job.items) {
      item.status = "running";
      item.error = null;
      item.downloadedBytes = 0;

      await fsp.mkdir(path.dirname(item.outputPath), { recursive: true });

      try {
        const result = await downloadRemoteFile(job.targetIp, item, item.outputPath, ({ downloadedBytes, totalBytes }) => {
          if (totalBytes && item.sizeBytes !== totalBytes) {
            item.sizeBytes = totalBytes;
          }
          item.downloadedBytes = downloadedBytes;
        });

        item.downloadedBytes = result.downloadedBytes;
        item.status = "completed";
        job.completedFiles += 1;
        job.completedBytes += result.downloadedBytes;
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        job.status = "failed";
        job.error = item.error;
        throw error;
      }
    }

    job.status = "completed";
  } catch (error) {
    if (job.status !== "failed") {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function prepareDownloadPlan(options) {
  const requestedFiles = Array.isArray(options.files) ? options.files : [];
  const payload = requestedFiles.length ? requestedFiles : (await fetchMediaList()).files;

  if (!payload.length) {
    throw new Error("There are no files to download.");
  }

  const baseRoot = resolveDownloadRoot(options.downloadRoot);
  const sessionLabel = slugify(state.session.cameraName || state.session.ip || "gopro");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const downloadRoot = path.join(baseRoot, `${timestamp}-${sessionLabel}`);

  return {
    downloadRoot,
    items: payload.map((item) => createDownloadItem(item, downloadRoot))
  };
}

function createDownloadItem(item, downloadRoot) {
  const directory = sanitizePathPart(item.directory, "100GOPRO");
  const name = sanitizePathPart(item.name, "media.bin");

  return {
    directory,
    name,
    sizeBytes: Number(item.sizeBytes || 0),
    outputPath: path.join(downloadRoot, directory, name)
  };
}

async function downloadRemoteFile(ip, item, outputPath, onProgress) {
  const response = await goproGet(ip, buildMediaDownloadEndpoint(item.directory, item.name), {
    timeoutMs: 0
  });

  if (!response.body) {
    throw new Error(`GoPro did not return file content for ${item.directory}/${item.name}.`);
  }

  const headerSize = Number(response.headers.get("content-length") || 0);
  const totalBytes = headerSize || Number(item.sizeBytes || 0);
  let downloadedBytes = 0;

  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
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
    await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(outputPath));
  } catch (error) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    downloadedBytes,
    totalBytes
  };
}

function findActiveDownloadJob() {
  for (const job of state.downloadJobs.values()) {
    if (job.status === "queued" || job.status === "running") {
      return job;
    }
  }

  return null;
}

function presentDownloadJob(job) {
  const runningItem = job.items.find((item) => item.status === "running") || null;
  const totalFiles = job.items.length;
  const totalBytes = job.items.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const transferredBytes = job.completedBytes + Number(runningItem ? runningItem.downloadedBytes : 0);
  const currentItem = runningItem
    ? {
        directory: runningItem.directory,
        name: runningItem.name,
        downloadedBytes: runningItem.downloadedBytes,
        sizeBytes: Number(runningItem.sizeBytes || 0),
        percent: calculatePercent(runningItem.downloadedBytes, runningItem.sizeBytes)
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
    totalFiles,
    completedFiles: job.completedFiles,
    totalBytes,
    transferredBytes,
    overallPercent: calculatePercent(transferredBytes, totalBytes),
    currentItem,
    files: job.items.map((item) => ({
      directory: item.directory,
      name: item.name,
      sizeBytes: item.sizeBytes,
      downloadedBytes: item.downloadedBytes,
      status: item.status,
      error: item.error
    }))
  };
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
  const requestUrl = new URL(`http://${ip}:8080${pathname}`);

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
      signal: controller ? controller.signal : undefined
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
    console.log(`GoPro USB app running at http://${HOST}:${PORT}`);
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
