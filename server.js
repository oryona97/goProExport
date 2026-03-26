const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
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
  session: null
};

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
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
    return sendJson(res, 200, {
      session: presentSession(),
      candidates: listCandidateUsbIps()
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

  if (pathname === "/api/download" && req.method === "POST") {
    ensureConnected();
    const body = await readJsonBody(req);
    const result = await downloadMedia(body || {});
    return sendJson(res, 200, result);
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
      files.push({
        directory: directoryEntry.d,
        name: filename,
        extension,
        type: describeFileType(extension),
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
  if (["mp4", "mov"].includes(extension)) {
    return "Video";
  }
  if (["jpg", "jpeg", "png", "gpr"].includes(extension)) {
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

async function downloadMedia(options) {
  const requestedFiles = Array.isArray(options.files) ? options.files : [];
  const payload = requestedFiles.length ? requestedFiles : (await fetchMediaList()).files;

  if (!payload.length) {
    throw new Error("There are no files to download.");
  }

  const baseRoot = resolveDownloadRoot(options.downloadRoot);
  const sessionLabel = slugify(state.session.cameraName || state.session.ip || "gopro");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const downloadRoot = path.join(baseRoot, `${timestamp}-${sessionLabel}`);

  await fsp.mkdir(downloadRoot, { recursive: true });

  const downloaded = [];
  for (const item of payload) {
    const directory = sanitizePathPart(item.directory, "100GOPRO");
    const filename = sanitizePathPart(item.name, "media.bin");
    const outputPath = path.join(downloadRoot, directory, filename);
    const endpoint = `/videos/DCIM/${encodeURIComponent(directory)}/${encodeURIComponent(filename)}`;

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    const response = await goproGet(state.session.ip, endpoint, {
      timeoutMs: 0
    });

    if (!response.body) {
      throw new Error(`GoPro did not return file content for ${directory}/${filename}.`);
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));

    downloaded.push({
      directory,
      name: filename,
      savedTo: outputPath
    });
  }

  return {
    ok: true,
    root: downloadRoot,
    count: downloaded.length,
    files: downloaded
  };
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
      method: "GET",
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      throw new Error(`GoPro responded with HTTP ${response.status} for ${pathname}.`);
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
  createServer,
  computeUsbIpFromSerialSuffix,
  flattenMediaList,
  listCandidateUsbIps
};
