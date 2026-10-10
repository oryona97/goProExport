const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readdir } = require('node:fs/promises');
const { fixture, googleFixture } = require('./fixtures');

test('Connect Google starts a desktop authorization flow with narrow scope and PKCE', async t => {
  const f = await fixture(t, undefined, { GOOGLE_CLIENT_ID: 'test-client' });
  const connected = await f.api('/api/cloud/google/connect', {});
  assert.equal(connected.status, 200);
  const url = new URL(connected.body.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge').length >= 43);
  assert.ok(url.searchParams.get('state').length >= 32);
  assert.equal(url.searchParams.get('redirect_uri'), `${f.url}/oauth/google/callback`);
});

test('cloud progress accounts for both transfers and retained storage without reporting saved early', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive' } });
  const paused = await f.waitJob(created.body.job.id);
  assert.equal(paused.totalBytes, 28);
  assert.equal(paused.transferredBytes, 14);
  assert.equal(paused.overallPercent, 50);
  assert.equal(paused.retainedBytes, 14);
  assert.equal(paused.files[0].recordingDate, '2026-10-08');
  assert.equal(paused.completedFiles, 0);
});

test('a cloud batch cannot start during account selection or silently use a different account', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  const wrongAccount = await f.startJob({ destination: { type: 'google-drive', accountId: 'account-other' } });
  assert.equal(wrongAccount.status, 409);
  await f.api('/api/cloud/google/connect', {});
  const pending = await f.startJob({ destination: { type: 'google-drive' } });
  assert.equal(pending.status, 409);
  assert.equal((await f.api('/api/download-jobs')).body.jobs.length, 0);
});

test('the easy default reuses its GoPro Exports folder after reconnecting and reopening', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const first = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await google.authorize(f);
  await f.restart();
  const second = (await f.api('/api/cloud/google/folder', {})).body.folder;
  assert.equal(second.id, first.id);
  const folders = await (await fetch(`${google.url}/drive/v3/files?q=${encodeURIComponent("name = 'GoPro Exports'")}`)).json();
  assert.equal(folders.files.length, 1);
});

test('Google revoking an access token triggers a refresh before retrying the destination request', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  google.controls.requireRefreshed = true;
  const response = await f.api('/api/cloud/google/folder', {});
  assert.equal(response.status, 200);
  assert.equal(response.body.folder.name, 'GoPro Exports');
  assert.equal((await f.api('/api/cloud/google/status')).body.account.email, 'owner@example.test');
});

test('an inaccessible destination pauses before downloading another original', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive' } });
  await f.waitJob(created.body.job.id);
  google.folders.delete(folder.id);
  await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {});
  const resumed = await f.waitJob(created.body.job.id);
  assert.equal(resumed.status, 'paused');
  assert.equal(resumed.retainedBytes, 14);
  assert.match(resumed.error, /destination|folder/i);
});

test('an upload that acknowledges no progress pauses with the original retained', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  google.controls.noProgress = true;
  const created = await f.startJob({ destination: { type: 'google-drive' } });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'paused');
  assert.equal(job.retainedBytes, 14);
  assert.equal(job.completedFiles, 0);
});

test('OAuth callbacks must match a single pending request and cannot be replayed', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  const start = await f.api('/api/cloud/google/connect', {});
  const state = new URL(start.body.authorizationUrl).searchParams.get('state');
  const wrong = await fetch(`${f.url}/oauth/google/callback?state=wrong&code=fixture-code`);
  assert.equal(wrong.status, 400);
  assert.equal((await f.api('/api/cloud/google/status')).body.connected, false);
  const callback = `${f.url}/oauth/google/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 400);
  assert.equal((await f.api('/api/cloud/google/status')).body.account.email, 'owner@example.test');
});

test('a maintainer supplied desktop client lets users connect without environment credentials', async t => {
  const filename = path.join(require('node:os').tmpdir(), `gopro-oauth-test-${require('node:crypto').randomUUID()}.json`);
  await require('node:fs/promises').writeFile(filename, JSON.stringify({ installed: { client_id: 'shared-desktop-client', client_secret: 'desktop-client-value' } }));
  t.after(() => require('node:fs/promises').rm(filename, { force: true }));
  const f = await fixture(t, undefined, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOPRO_GOOGLE_CONFIG: filename });
  assert.equal((await f.api('/api/cloud/google/status')).body.configured, true);
  const connect = await f.api('/api/cloud/google/connect', {});
  assert.equal(connect.status, 200);
  assert.equal(new URL(connect.body.authorizationUrl).searchParams.get('client_id'), 'shared-desktop-client');
  assert.ok(!JSON.stringify(connect.body).includes('desktop-client-value'));
});

test('Connect dispatches authorization to the system browser and receives its loopback callback', async t => {
  const google = await googleFixture(t);
  const launcher = path.join(require('node:os').tmpdir(), `gopro-browser-test-${require('node:crypto').randomUUID()}.cjs`);
  await require('node:fs/promises').writeFile(launcher, 'fetch(process.argv[2]).then(response => { if (!response.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });');
  t.after(() => require('node:fs/promises').rm(launcher, { force: true }));
  const f = await fixture(t, undefined, { ...google.env, GOPRO_TEST_BROWSER_LAUNCHER: launcher });
  const response = await f.api('/api/cloud/google/connect', {});
  assert.equal(response.body.browserOpened, true);
  const deadline = Date.now() + 5000;
  let status;
  do {
    status = (await f.api('/api/cloud/google/status')).body;
    if (status.connected) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(status.account?.email, 'owner@example.test');
});

test('cancelling pending sign-in preserves the remembered account and rejects the late callback', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const start = await f.api('/api/cloud/google/connect', {});
  const state = new URL(start.body.authorizationUrl).searchParams.get('state');
  assert.equal((await f.api('/api/cloud/google/cancel-authorization', {})).status, 200);
  const status = (await f.api('/api/cloud/google/status')).body;
  assert.equal(status.authorizationPending, false);
  assert.equal(status.account.email, 'owner@example.test');
  assert.equal((await fetch(`${f.url}/oauth/google/callback?state=${state}&code=fixture-code`)).status, 400);
});

test('MOV originals keep their filename, contents, and video media type in Drive', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, [{ name: 'GOPR0123.MOV', data: Buffer.from('original-mov'), createdUnix: 1791417600 }], google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  const created = await f.startJob({ destination: { type: 'google-drive' } });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed');
  const file = await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}`)).json();
  assert.equal(file.name, 'GOPR0123.MOV');
  assert.equal(file.mimeType, 'video/quicktime');
  assert.equal(await (await fetch(`${google.url}/drive/v3/files/${file.id}?alt=media`)).text(), 'original-mov');
});

test('a temporary failure after accepted upload bytes recovers without sending those bytes twice', async t => {
  const google = await googleFixture(t);
  const original = Buffer.alloc(10 * 1024 * 1024, 0x63);
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: original, createdUnix: 1791417600 }], google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.transientChunkOnce = true;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed');
  assert.deepEqual(Buffer.from(await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}?alt=media`)).arrayBuffer()), original);
});

test('temporary Google service failures retry without losing or duplicating the original', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.transientUploadFailures = 2;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}?alt=media`)).text(), 'original-video');
});

test('an expired upload session restarts from the retained original using the same file identity', async t => {
  const google = await googleFixture(t);
  const original = Buffer.alloc(10 * 1024 * 1024, 0x62);
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: original, createdUnix: 1791417600 }], google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.interruptOnce = true;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  const paused = await f.waitJob(created.body.job.id);
  google.controls.expireProbeOnce = true;
  await f.restart();
  await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {});
  const resumed = await f.waitJob(created.body.job.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.files[0].driveFileId, paused.files[0].driveFileId);
  assert.deepEqual(Buffer.from(await (await fetch(`${google.url}/drive/v3/files/${resumed.files[0].driveFileId}?alt=media`)).arrayBuffer()), original);
});

test('reopening resumes from Google-confirmed bytes after an interrupted chunk', async t => {
  const google = await googleFixture(t);
  const original = Buffer.alloc(10 * 1024 * 1024, 0x61);
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: original, createdUnix: 1791417600 }], google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.interruptOnce = true;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  assert.equal((await f.waitJob(created.body.job.id)).status, 'paused');
  await f.restart();
  assert.equal((await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {})).status, 200);
  const resumed = await f.waitJob(created.body.job.id);
  assert.equal(resumed.status, 'completed');
  const uploaded = await fetch(`${google.url}/drive/v3/files/${resumed.files[0].driveFileId}?alt=media`);
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), original);
});

test('unfinished cloud work blocks another account until the user explicitly discards it', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  await f.waitJob(created.body.job.id);
  google.controls.accountId = 'account-two';
  google.controls.email = 'other@example.test';
  assert.equal((await google.authorize(f)).status, 409);
  assert.equal((await f.api('/api/cloud/google/status')).body.account.id, 'account-one');
  assert.equal((await f.api(`/api/download-jobs/${created.body.job.id}/discard`, {})).status, 200);
  assert.equal((await google.authorize(f)).status, 200);
  assert.equal((await f.api('/api/cloud/google/status')).body.account.id, 'account-two');
});

test('a cloud-wide rejection pauses the batch and retains the staged original', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600 },
    { name: 'GX010124.MP4', data: Buffer.from('next-video'), createdUnix: 1791417600 }
  ], google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  const paused = await f.waitJob(created.body.job.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.files[0].retainedBytes, 14);
  assert.equal(paused.files[1].status, 'queued');
});

test('cloud repeats skip a confirmed copy and different contents preserve both filenames', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  const options = { destination: { type: 'google-drive', folderId: folder.id } };
  const first = await f.startJob(options);
  const saved = await f.waitJob(first.body.job.id);
  await google.authorize(f);
  const repeat = await f.startJob(options);
  const repeated = await f.waitJob(repeat.body.job.id);
  assert.equal(repeated.files[0].status, 'skipped');
  assert.equal(repeated.files[0].driveFileId, saved.files[0].driveFileId);
  f.files[0].data = Buffer.from('different-video');
  const next = await f.startJob(options);
  const changed = await f.waitJob(next.body.job.id);
  assert.equal(changed.status, 'completed');
  assert.equal(await (await fetch(`${google.url}/drive/v3/files/${saved.files[0].driveFileId}?alt=media`)).text(), 'original-video');
  const metadata = await (await fetch(`${google.url}/drive/v3/files/${changed.files[0].driveFileId}`)).json();
  const conflict = await (await fetch(`${google.url}/drive/v3/files/${metadata.parents[0]}`)).json();
  assert.equal(conflict.name, 'Conflicts-1');
});

test('a failed verification retains the original and can recover after reopening without the camera', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.corruptChecksum = true;
  const stagingRoot = path.join(f.root, 'staging');
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id }, stagingRoot });
  const failed = await f.waitJob(created.body.job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.files[0].retainedBytes, 14);
  const retained = (await readdir(stagingRoot)).find(name => name.endsWith('.part'));
  assert.equal(await f.readFile(path.join(stagingRoot, retained), 'utf8'), 'original-video');
  await f.restart();
  google.controls.corruptChecksum = false;
  const retried = await f.api(`/api/download-jobs/${created.body.job.id}/retry`, {});
  assert.equal(retried.status, 200);
  assert.equal((await f.waitJob(created.body.job.id)).status, 'completed');
});

test('cloud saving uploads the original to its date folder and cleans staging only after verification', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  const stagingRoot = path.join(f.root, 'staging');
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id }, stagingRoot });
  assert.equal(created.status, 202);
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.destination.type, 'google-drive');
  assert.equal(job.status, 'completed');
  const response = await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}?alt=media`);
  assert.equal(await response.text(), 'original-video');
  const metadata = await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}`)).json();
  const dateFolder = await (await fetch(`${google.url}/drive/v3/files/${metadata.parents[0]}`)).json();
  assert.equal(dateFolder.name, '2026-10-08');
  assert.deepEqual((await readdir(stagingRoot)).filter(name => name.endsWith('.part')), []);
});

test('a user creates the default destination even after the short-lived access token expires', async t => {
  const google = await googleFixture(t);
  google.controls.expiresIn = 0;
  google.controls.requireRefreshed = true;
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const created = await f.api('/api/cloud/google/folder', {});
  assert.equal(created.status, 200);
  assert.equal(created.body.folder.name, 'GoPro Exports');
  assert.equal((await f.api('/api/cloud/google/status')).body.folder.id, created.body.folder.id);
});

test('a user authorizes an existing My Drive folder through the desktop picker', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const picked = await f.api('/api/cloud/google/folder-picker', {});
  assert.equal(picked.status, 200);
  const url = new URL(picked.body.authorizationUrl);
  assert.equal(url.searchParams.get('trigger_onepick'), 'true');
  assert.equal(url.searchParams.get('allow_folder_selection'), 'true');
  const callback = await fetch(`${f.url}/oauth/google/callback?state=${encodeURIComponent(url.searchParams.get('state'))}&code=fixture-code&picked_file_ids=selected-folder`);
  assert.equal(callback.status, 200);
  assert.equal((await f.api('/api/cloud/google/status')).body.folder.id, 'selected-folder');
});

test('a connected Google account survives reopening without exposing its credentials', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  assert.equal((await google.authorize(f)).status, 200);
  await f.restart();
  const status = await f.api('/api/cloud/google/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.account.email, 'owner@example.test');
  assert.equal(status.body.connected, true);
  assert.ok(!JSON.stringify(status.body).includes('fixture-access'));
  assert.ok(!JSON.stringify(status.body).includes('fixture-refresh'));
});
