const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

async function fixture(t, files = [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600 }], extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gopro-save-test-'));
  const cameraState = { serial: 'camera-one' };
  const camera = await listen((req, res) => {
    const url = new URL(req.url, 'http://camera');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/gopro/camera/info') return res.end(JSON.stringify({ serial_number: cameraState.serial, model_name: 'HERO' }));
    if (url.pathname === '/gopro/camera/name') return res.end(JSON.stringify({ value: 'Test camera' }));
    if (url.pathname === '/gopro/version') return res.end(JSON.stringify({ version: '1.0' }));
    if (url.pathname === '/gopro/media/list') return res.end(JSON.stringify({ media: [{ d: '100GOPRO', fs: files.map(f => ({ n: f.name, s: f.sizeBytes ?? f.data.length, cre: f.createdUnix })) }] }));
    if (url.pathname.startsWith('/videos/DCIM/')) {
      const file = files.find(f => f.name === decodeURIComponent(url.pathname.split('/').pop()));
      if (!file) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'video/mp4');
      if (file.delay) return setTimeout(() => res.end(file.data), file.delay);
      return res.end(file.data);
    }
    res.end('{}');
  });
  let app;
  const start = async () => {
    let output = '';
    app = spawn(process.execPath, ['server.js'], { windowsHide: true, cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: '0', GOPRO_CAMERA_PORT: String(camera.port), GOPRO_DATA_DIR: path.join(root, 'state'), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', chunk => { output += chunk; });
    app.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const match = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !match[1].endsWith(':0')) return match[1];
      if (app.exitCode !== null) throw new Error(`App exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`App did not start: ${output}`);
  };
  const stop = async () => {
    if (app && app.exitCode === null) { const exited = once(app, 'exit'); app.kill(); await exited; }
  };
  t.after(async () => {
    await stop(); camera.server.closeAllConnections(); await new Promise(resolve => camera.server.close(resolve));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('gopro-save-test-')) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  let appUrl = await start();
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(appUrl + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const connect = () => api('/api/connect', { ip: '127.0.0.1' });
  const waitJob = async (id, predicate = job => ['completed', 'completed_with_errors', 'paused', 'failed'].includes(job.status)) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await api(`/api/download-jobs/${id}`);
      if (predicate(result.body.job)) return result.body.job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Job did not reach the expected state');
  };
  return { root, files, api, connect, waitJob, camera, cameraState, readFile, startJob: options => api('/api/download-jobs', { downloadRoot: path.join(root, 'saved'), recordingTimezone: 'UTC', files: files.map(f => ({ directory: '100GOPRO', name: f.name })), ...options }), restart: async () => { await stop(); appUrl = await start(); }, get url() { return appUrl; } };
}

async function googleFixture(t) {
  const folders = new Map([['selected-folder', { id: 'selected-folder', name: 'Existing videos', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }]]);
  const controls = { expiresIn: 3600, requireRefreshed: false, corruptChecksum: false, uploadStatus: 0, accountId: 'account-one', email: 'owner@example.test', interruptOnce: false, expireProbeOnce: false, transientUploadFailures: 0, transientChunkOnce: false, uploadDelay: 0, verificationDelay: 0, noProgress: false };
  const sessions = new Map();
  let identifier = 0;
  const google = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://google');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/o/oauth2/v2/auth') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', url.searchParams.get('state'));
      redirect.searchParams.set('code', 'fixture-code');
      if (url.searchParams.get('trigger_onepick') === 'true') redirect.searchParams.set('picked_file_ids', 'selected-folder');
      res.writeHead(302, { Location: redirect.toString() }); return res.end();
    }
    if (url.pathname === '/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'fixture-refresh') return res.end(JSON.stringify({ access_token: 'fixture-refreshed', expires_in: 3600 }));
      if (!form.get('code_verifier') || form.get('grant_type') !== 'authorization_code') { res.statusCode = 400; return res.end('{}'); }
      return res.end(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: controls.expiresIn, scope: 'https://www.googleapis.com/auth/drive.file' }));
    }
    if (url.pathname === '/drive/v3/about') return res.end(JSON.stringify({ user: { permissionId: controls.accountId, emailAddress: controls.email, displayName: 'Video owner' }, storageQuota: { limit: '1000000', usage: '0' } }));
    if (url.pathname === '/drive/v3/files/generateIds') return res.end(JSON.stringify({ ids: [`generated-${++identifier}`] }));
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const parent = query.match(/'([^']+)' in parents/)?.[1];
      const name = query.match(/name = '([^']+)'/)?.[1];
      const items = [...folders.values()].filter(file => (!parent || file.parents?.includes(parent)) && (!name || file.name === name));
      return res.end(JSON.stringify({ files: items.map(({ data, ...file }) => file) }));
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      if (controls.uploadDelay) await new Promise(resolve => setTimeout(resolve, controls.uploadDelay));
      if (controls.transientUploadFailures > 0) { controls.transientUploadFailures -= 1; res.statusCode = 503; return res.end('{}'); }
      if (controls.uploadStatus) { res.statusCode = controls.uploadStatus; return res.end(JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } })); }
      let body = ''; for await (const chunk of req) body += chunk;
      const metadata = JSON.parse(body);
      if (folders.has(metadata.id)) { res.statusCode = 409; return res.end('{}'); }
      sessions.set(metadata.id, { metadata, data: Buffer.alloc(0) });
      res.setHeader('Location', `${google.url}/session/${metadata.id}`); return res.end('{}');
    }
    if (url.pathname.startsWith('/session/') && req.method === 'PUT') {
      const id = url.pathname.split('/').pop();
      const session = sessions.get(id);
      if (!session) { res.statusCode = 404; return res.end('{}'); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const range = req.headers['content-range'] || '';
      if (range.startsWith('bytes */') && controls.expireProbeOnce) {
        controls.expireProbeOnce = false; sessions.delete(id);
        res.statusCode = 404; return res.end('{}');
      }
      const chunkRange = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const total = Number(range.split('/').pop());
      if (chunkRange) {
        if (controls.noProgress) { res.statusCode = 308; return res.end('{}'); }
        if (Number(chunkRange[1]) !== session.data.length) { res.statusCode = 400; return res.end('{}'); }
        session.data = Buffer.concat([session.data, ...chunks]);
        if (controls.transientChunkOnce) { controls.transientChunkOnce = false; res.statusCode = 503; return res.end('{}'); }
        if (controls.interruptOnce) {
          controls.interruptOnce = false;
          res.statusCode = 403;
          return res.end(JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }));
        }
      }
      if (session.data.length === total) {
        const file = { ...session.metadata, size: String(total), md5Checksum: createHash('md5').update(session.data).digest('hex'), webViewLink: `https://drive.google.com/file/d/${id}/view`, data: session.data };
        folders.set(id, file);
        const { data, ...metadata } = file;
        if (controls.corruptChecksum && metadata.md5Checksum) metadata.md5Checksum = '00000000000000000000000000000000';
        return res.end(JSON.stringify(metadata));
      }
      res.statusCode = 308;
      if (session.data.length) res.setHeader('Range', `bytes=0-${session.data.length - 1}`);
      return res.end('{}');
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      if (controls.requireRefreshed && req.headers.authorization !== 'Bearer fixture-refreshed') { res.statusCode = 401; return res.end('{}'); }
      let body = ''; for await (const chunk of req) body += chunk;
      const metadata = JSON.parse(body);
      const folder = { ...metadata, id: metadata.id || `folder-${folders.size}`, capabilities: { canAddChildren: true } };
      folders.set(folder.id, folder); return res.end(JSON.stringify(folder));
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const file = folders.get(decodeURIComponent(url.pathname.split('/').pop()));
      if (file) {
        if (url.searchParams.get('alt') === 'media') return res.end(file.data);
        if (file.data && controls.verificationDelay) await new Promise(resolve => setTimeout(resolve, controls.verificationDelay));
        const { data, ...metadata } = file;
        if (controls.corruptChecksum && metadata.md5Checksum) metadata.md5Checksum = '00000000000000000000000000000000';
        return res.end(JSON.stringify(metadata));
      }
    }
    res.statusCode = 404; res.end('{}');
  });
  t.after(async () => { google.server.closeAllConnections(); await new Promise(resolve => google.server.close(resolve)); });
  const env = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_API_ORIGIN: google.url };
  const authorize = async f => {
    const start = await f.api('/api/cloud/google/connect', {});
    const url = new URL(start.body.authorizationUrl);
    return fetch(`${f.url}/oauth/google/callback?state=${encodeURIComponent(url.searchParams.get('state'))}&code=fixture-code`);
  };
  return { ...google, env, authorize, folders, controls };
}

module.exports = { fixture, listen, googleFixture };
