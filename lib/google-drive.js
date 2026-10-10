const { randomBytes, createHash } = require('node:crypto');
const { CredentialStore } = require('./credential-store');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

class GoogleDrive {
  constructor(root) {
    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!this.clientId) {
      try {
        const config = JSON.parse(require('node:fs').readFileSync(process.env.GOPRO_GOOGLE_CONFIG || path.join(__dirname, '..', 'google-oauth.json'), 'utf8'));
        const desktop = config.installed || config;
        if (!desktop.client_id || config.web) throw new Error('Invalid desktop OAuth configuration');
        this.clientId = desktop.client_id;
        this.clientSecret = desktop.client_secret;
      } catch (error) { if (error.code !== 'ENOENT' || process.env.GOPRO_GOOGLE_CONFIG) this.configurationError = 'The app Google sign-in configuration is unavailable. Contact the app maintainer.'; }
    }
    this.store = new CredentialStore(root);
    this.ready = this.store.load().then(value => { this.credentials = value; }).catch(() => { this.credentialError = 'Saved sign-in could not be opened. Reconnect Google.'; });
    const testOrigin = process.env.NODE_ENV === 'test' && process.env.GOOGLE_API_ORIGIN;
    this.tokenUrl = testOrigin ? `${testOrigin}/token` : 'https://oauth2.googleapis.com/token';
    this.apiBase = testOrigin ? `${testOrigin}/drive/v3` : 'https://www.googleapis.com/drive/v3';
    this.uploadBase = testOrigin ? `${testOrigin}/upload/drive/v3` : 'https://www.googleapis.com/upload/drive/v3';
    this.authorizationBase = testOrigin ? `${testOrigin}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth';
    this.authGeneration = 0;
    this.authInFlight = 0;
    this.pending = new Map();
  }
  status() {
    for (const [key, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(key);
    return { configured: !!this.clientId, connected: !!this.credentials, account: this.credentials?.account || null, folder: this.credentials?.folder || null, authorizationPending: this.pending.size > 0 || this.authInFlight > 0, error: this.authorizationError || this.credentialError || this.configurationError || null };
  }
  async disconnect() { this.authGeneration += 1; this.pending.clear(); this.credentials = null; this.authorizationError = null; this.credentialError = null; await this.store.clear(); }
  async cancelAuthorization() {
    this.authGeneration += 1; this.pending.clear(); this.authorizationError = null;
    // Restore the current grant after any already queued callback write.
    if (this.credentials) await this.store.save(this.credentials); else await this.store.clear();
  }
  async accessToken(force = false) {
    if (!this.credentials) throw Object.assign(new Error('Connect Google Drive first'), { statusCode: 401, pause: true });
    if (!force && this.credentials.expiresAt > Date.now() + 60000) return this.credentials.accessToken;
    if (!this.refreshing) this.refreshing = (async () => {
      const current = this.credentials;
      if (!current.refreshToken) throw Object.assign(new Error('Reconnect Google Drive to continue'), { statusCode: 401, pause: true });
      const form = new URLSearchParams({ client_id: this.clientId, refresh_token: current.refreshToken, grant_type: 'refresh_token' });
      if (this.clientSecret) form.set('client_secret', this.clientSecret);
      const response = await fetch(this.tokenUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Object.assign(new Error('Google sign-in expired. Reconnect the original account.'), { statusCode: 401, pause: true });
      const token = await response.json();
      if (current !== this.credentials) throw Object.assign(new Error('Google account changed during authorization'), { statusCode: 409, pause: true });
      current.accessToken = token.access_token;
      current.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
      current.refreshToken = token.refresh_token || current.refreshToken;
      await this.store.save(current);
      return current.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async request(pathname, { method = 'GET', body, signal } = {}) {
    const response = await this.uploadRequest(this.apiBase + pathname, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal, safeToRetry: method === 'GET' || !!body?.id });
    if (!response.ok) throw Object.assign(new Error(`Google Drive request failed (HTTP ${response.status})`), { statusCode: response.status, pause: [401, 403].includes(response.status) });
    return response.json();
  }
  async createDefaultFolder() {
    if (this.defaultFolderTask) return this.defaultFolderTask;
    this.defaultFolderTask = (async () => {
      await this.accessToken();
      let folder;
      if (this.credentials.defaultFolderId) {
        try {
          const existing = await this.request(`/files/${encodeURIComponent(this.credentials.defaultFolderId)}?fields=id,name,mimeType,trashed,driveId,capabilities`);
          if (!existing.trashed && !existing.driveId && existing.capabilities?.canAddChildren && existing.mimeType === 'application/vnd.google-apps.folder') folder = existing;
          else this.credentials.defaultFolderId = null;
        } catch (error) { if (error.statusCode !== 404) throw error; }
      }
      if (!folder) {
        folder = (await this.listFiles('root')).find(file => file.mimeType === 'application/vnd.google-apps.folder' && file.appProperties?.goproExportDefault === 'true');
        if (!folder) {
          this.credentials.defaultFolderId ||= (await this.request('/files/generateIds?count=1&space=drive&type=files')).ids[0];
          await this.store.save(this.credentials);
          folder = await this.request('/files?fields=id,name', { method: 'POST', body: { id: this.credentials.defaultFolderId, name: 'GoPro Exports', parents: ['root'], mimeType: 'application/vnd.google-apps.folder', appProperties: { goproExportDefault: 'true' } } });
        }
      }
      this.credentials.defaultFolderId = folder.id;
      this.credentials.folder = { id: folder.id, name: folder.name };
      await this.store.save(this.credentials);
      return this.credentials.folder;
    })().finally(() => { this.defaultFolderTask = null; });
    return this.defaultFolderTask;
  }
  async dateFolder(rootId, day) {
    this.credentials.dateFolders ||= {};
    const key = `${rootId}/${day}`;
    const cached = this.credentials.dateFolders[key];
    if (cached) {
      try {
        const folder = await this.request(`/files/${encodeURIComponent(cached)}?fields=id,name,parents,trashed`);
        if (!folder.trashed && folder.name === day && folder.parents?.includes(rootId)) return folder.id;
      } catch (error) { if (error.statusCode !== 404) throw error; }
    }
    const known = (await this.listFiles(rootId)).find(file => file.name === day && file.mimeType === 'application/vnd.google-apps.folder' && file.appProperties?.goproExportFolder === 'true');
    const folder = known || await this.request('/files?fields=id,name', { method: 'POST', body: { name: day, parents: [rootId], mimeType: 'application/vnd.google-apps.folder', appProperties: { goproExportFolder: 'true' } } });
    this.credentials.dateFolders[key] = folder.id;
    await this.store.save(this.credentials);
    return folder.id;
  }
  async listFiles(parentId) {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ q: `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`, fields: 'files(id,name,mimeType,size,md5Checksum,parents,appProperties,trashed),nextPageToken', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request(`/files?${params}`);
      files.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
  async targetFor(item, rootId) {
    const dayFolder = await this.dateFolder(rootId, item.recordingDate);
    for (let conflict = 0; ; conflict += 1) {
      const folderId = conflict ? await this.dateFolder(dayFolder, `Conflicts-${conflict}`) : dayFolder;
      const files = await this.listFiles(folderId);
      for (const candidate of files.filter(file => file.name === item.name && Number(file.size) === item.sizeBytes && file.md5Checksum === item.md5)) {
        try {
          const file = await this.request(`/files/${encodeURIComponent(candidate.id)}?fields=id,name,size,md5Checksum,parents,trashed,webViewLink`);
          if (!file.trashed && file.parents?.includes(folderId) && Number(file.size) === item.sizeBytes && file.md5Checksum === item.md5) return { folderId, file };
        } catch (error) { if (error.statusCode !== 404) throw error; }
      }
      if (!files.some(file => file.name === item.name)) return { folderId };
    }
  }
  async uploadRequest(url, { method, body, headers = {}, signal, safeToRetry = true }) {
    if (new URL(url).origin !== new URL(this.uploadBase).origin) throw new Error('Invalid Google upload session');
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      let response;
      try {
        response = await fetch(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (safeToRetry && attempt < 2) { await delay(200 * 2 ** attempt, undefined, { signal }); continue; }
        throw Object.assign(new Error('Google Drive connection failed. Resume when the connection returns.'), { pause: true, transient: true });
      }
      if (response.ok || [308, 404, 409].includes(response.status)) return response;
      if (response.status === 401 && attempt === 0) { await this.accessToken(true); continue; }
      const detail = await response.json().catch(() => ({}));
      const reason = detail.error?.errors?.[0]?.reason;
      const transient = response.status === 429 || response.status >= 500 || ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason);
      if (transient && safeToRetry && attempt < 2) { await delay(200 * 2 ** attempt, undefined, { signal }); continue; }
      throw Object.assign(new Error(reason === 'storageQuotaExceeded' ? 'Google Drive storage is full. Free space and resume.' : `Google Drive request failed (HTTP ${response.status}). Resume or reconnect if needed.`), { statusCode: response.status, pause: transient || [401, 403].includes(response.status), transient });
    }
  }
  async saveOriginal(item, destination, persist, signal, onProgress) {
    if (this.credentials?.account.id !== destination.accountId) throw Object.assign(new Error('Reconnect the original Google account'), { pause: true });
    const target = await this.targetFor(item, destination.folderId);
    if (target.file) {
      const skipped = item.driveFileId !== target.file.id;
      item.driveFileId = target.file.id;
      item.uploadedBytes = item.sizeBytes;
      await persist();
      return { outputPath: target.file.webViewLink || `https://drive.google.com/file/d/${target.file.id}/view`, downloadedBytes: item.sizeBytes, skipped };
    }
    if (item.driveDateFolderId && item.driveDateFolderId !== target.folderId) {
      item.driveFileId = null; item.encryptedUploadSession = null; item.sessionUrl = null; item.uploadedBytes = 0;
    }
    item.driveDateFolderId = target.folderId;
    if (!item.driveFileId) item.driveFileId = (await this.request('/files/generateIds?count=1&space=drive&type=files')).ids[0];
    await persist();
    if (!item.sessionUrl && item.encryptedUploadSession) item.sessionUrl = await this.store.open(item.encryptedUploadSession);
    if (item.sessionUrl) {
      const response = await this.uploadRequest(item.sessionUrl, { method: 'PUT', body: Buffer.alloc(0), headers: { 'Content-Length': '0', 'Content-Range': `bytes */${item.sizeBytes}` }, signal });
      if ([200, 201].includes(response.status)) item.uploadedBytes = item.sizeBytes;
      else if (response.status === 308) {
        const range = response.headers.get('range')?.match(/bytes=0-(\d+)/);
        item.uploadedBytes = range ? Number(range[1]) + 1 : 0;
      } else if (response.status === 404) {
        item.sessionUrl = null;
        item.encryptedUploadSession = null;
        item.uploadedBytes = 0;
      } else throw Object.assign(new Error('The Google upload session is unavailable. The original is retained.'), { pause: true });
      await persist();
    }
    if (!item.sessionUrl) {
      const mimeType = path.extname(item.name).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4';
      const response = await this.uploadRequest(`${this.uploadBase}/files?uploadType=resumable`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(item.sizeBytes) }, body: JSON.stringify({ id: item.driveFileId, name: item.name, parents: [item.driveDateFolderId], mimeType, appProperties: { goproSha256: item.sha256 } }), signal });
      if (!response.ok) throw new Error('Google could not start the video upload');
      item.sessionUrl = response.headers.get('location');
      if (!item.sessionUrl) throw new Error('Google did not provide an upload session');
      item.encryptedUploadSession = await this.store.seal(item.sessionUrl);
      await persist();
    }
    const source = await fs.open(item.stagedPath, 'r');
    try {
      let offset = item.uploadedBytes || 0;
      let transientFailures = 0;
      let stalledChunks = 0;
      while (offset < item.sizeBytes) {
        const buffer = Buffer.alloc(Math.min(8 * 1024 * 1024, item.sizeBytes - offset));
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (bytesRead !== buffer.length) throw new Error('The staged original is incomplete');
        let response;
        try {
          response = await this.uploadRequest(item.sessionUrl, { method: 'PUT', body: buffer, headers: { 'Content-Length': String(bytesRead), 'Content-Range': `bytes ${offset}-${offset + bytesRead - 1}/${item.sizeBytes}` }, signal, safeToRetry: false });
          transientFailures = 0;
        } catch (error) {
          if (!error.transient || ++transientFailures > 3) throw error;
          await delay(200 * 2 ** (transientFailures - 1), undefined, { signal });
          response = await this.uploadRequest(item.sessionUrl, { method: 'PUT', body: Buffer.alloc(0), headers: { 'Content-Length': '0', 'Content-Range': `bytes */${item.sizeBytes}` }, signal });
        }
        if (![200, 201, 308].includes(response.status)) throw new Error('The Google upload session is unavailable');
        const received = response.headers.get('range')?.match(/bytes=0-(\d+)/);
        const nextOffset = response.status === 308 ? (received ? Number(received[1]) + 1 : 0) : item.sizeBytes;
        if (nextOffset < 0 || nextOffset > item.sizeBytes || nextOffset < offset || (nextOffset === offset && ++stalledChunks > 2)) throw Object.assign(new Error('Google upload stopped making progress. The original is retained. Resume when ready.'), { pause: true });
        if (nextOffset > offset) stalledChunks = 0;
        offset = nextOffset;
        item.uploadedBytes = offset;
        onProgress();
        await persist();
      }
    } finally { await source.close(); }
    item.stage = 'verifying';
    await persist();
    const file = await this.request(`/files/${encodeURIComponent(item.driveFileId)}?fields=id,name,size,md5Checksum,parents,webViewLink,trashed`, { signal });
    if (file.trashed || !file.parents?.includes(item.driveDateFolderId) || Number(file.size) !== item.sizeBytes || file.md5Checksum !== item.md5) throw new Error('Cloud verification failed. The temporary original has been retained.');
    return { outputPath: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, downloadedBytes: item.sizeBytes, skipped: false };
  }
  async validateDestination(destination) {
    if (this.credentials?.account.id !== destination.accountId) throw Object.assign(new Error('Reconnect the original Google account'), { pause: true });
    try {
      const folder = await this.request(`/files/${encodeURIComponent(destination.folderId)}?fields=id,name,mimeType,trashed,driveId,capabilities`);
      if (folder.trashed || folder.driveId || folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.capabilities?.canAddChildren) throw new Error('Folder unavailable');
      return folder;
    } catch (error) {
      throw Object.assign(new Error('The Google Drive destination folder is inaccessible. Restore access to the original folder and resume.'), { pause: true, statusCode: error.statusCode || 400 });
    }
  }
  async finishAuthorization(parameters, currentLock = () => null) {
    const state = parameters.get('state');
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw Object.assign(new Error('Invalid or expired Google authorization request'), { statusCode: 400 });
    if (parameters.get('error') || !parameters.get('code')) throw Object.assign(new Error('Google authorization was cancelled'), { statusCode: 400 });
    const form = new URLSearchParams({ client_id: this.clientId, code: parameters.get('code'), code_verifier: pending.verifier, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' });
    if (this.clientSecret) form.set('client_secret', this.clientSecret);
    const response = await fetch(this.tokenUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Object.assign(new Error('Google could not complete sign-in'), { statusCode: 401 });
    const token = await response.json();
    const aboutResponse = await fetch(`${this.apiBase}/about?fields=user,storageQuota`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
    if (!aboutResponse.ok) throw Object.assign(new Error('Google account information is unavailable'), { statusCode: 401 });
    const about = await aboutResponse.json();
    const credentials = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in) * 1000, account: { id: about.user.permissionId, email: about.user.emailAddress, name: about.user.displayName }, quota: about.storageQuota };
    const expectedAccountId = currentLock() || pending.expectedAccountId;
    if (expectedAccountId && credentials.account.id !== expectedAccountId) throw Object.assign(new Error('Complete or discard unfinished cloud batches before switching accounts. Reconnect the original account.'), { statusCode: 409 });
    if (pending.generation !== this.authGeneration) throw Object.assign(new Error('Google sign-in was superseded or disconnected'), { statusCode: 409 });
    if (this.credentials?.account.id === credentials.account.id) {
      credentials.refreshToken ||= this.credentials.refreshToken;
      credentials.folder = this.credentials.folder;
      credentials.dateFolders = this.credentials.dateFolders;
      credentials.defaultFolderId = this.credentials.defaultFolderId;
    }
    if (pending.selectFolder) {
      const ids = (parameters.get('picked_file_ids') || '').split(',').filter(Boolean);
      if (ids.length !== 1) throw Object.assign(new Error('Select one destination folder'), { statusCode: 400 });
      const response = await fetch(`${this.apiBase}/files/${encodeURIComponent(ids[0])}?fields=id,name,mimeType,trashed,driveId,capabilities`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Object.assign(new Error('The selected folder is inaccessible'), { statusCode: 400 });
      const folder = await response.json();
      if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed || folder.driveId || !folder.capabilities?.canAddChildren) throw Object.assign(new Error('Choose a writable My Drive folder'), { statusCode: 400 });
      credentials.folder = { id: folder.id, name: folder.name };
    }
    if (pending.generation !== this.authGeneration) throw Object.assign(new Error('Google sign-in was disconnected'), { statusCode: 409 });
    await this.store.save(credentials);
    if (pending.generation !== this.authGeneration) throw Object.assign(new Error('Google sign-in was disconnected'), { statusCode: 409 });
    this.credentials = credentials;
    this.credentialError = null;
    this.authorizationError = null;
  }
  authorize(redirectUri, selectFolder = false, expectedAccountId = null) {
    if (!this.clientId) throw Object.assign(new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID for this app.'), { statusCode: 400 });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.clear();
    this.authorizationError = null;
    this.authGeneration += 1;
    this.pending.set(state, { verifier, redirectUri, selectFolder, generation: this.authGeneration, expectedAccountId: expectedAccountId || (selectFolder ? this.credentials?.account.id : null), expires: Date.now() + 10 * 60 * 1000 });
    const url = new URL(this.authorizationBase);
    const parameters = { client_id: this.clientId, redirect_uri: redirectUri, scope: DRIVE_SCOPE, response_type: 'code', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    if (selectFolder) Object.assign(parameters, { trigger_onepick: 'true', allow_folder_selection: 'true', mimetypes: 'application/vnd.google-apps.folder' });
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url.toString();
  }
}

module.exports = { GoogleDrive };
