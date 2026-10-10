const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./fixtures');

test('invalid destination or timezone cannot silently start a local save', async t => {
  const f = await fixture(t);
  await f.connect();
  const invalidDestination = await f.startJob({ destination: { type: 'unsupported-cloud' } });
  assert.equal(invalidDestination.status, 400);
  const invalidTimezone = await f.startJob({ recordingTimezone: 'wrong/timezone' });
  assert.equal(invalidTimezone.status, 400);
  assert.equal((await f.api('/api/download-jobs')).body.jobs.length, 0);
});

test('a website outside the local app cannot start saves or use remembered Google authorization', async t => {
  const f = await fixture(t);
  await f.connect();
  const crossOrigin = await fetch(f.url + '/api/download-jobs', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'text/plain' }, body: JSON.stringify({ files: [] }) });
  assert.equal(crossOrigin.status, 403);
  const forgedStatus = await new Promise((resolve, reject) => {
    require('node:http').get(f.url + '/api/cloud/google/status', { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await f.api('/api/download-jobs')).body.jobs.length, 0);
});

test('resuming refuses a replaced camera original instead of saving it under the previous metadata', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600, delay: 800 }]);
  await f.connect();
  const created = await f.startJob();
  await f.api(`/api/download-jobs/${created.body.job.id}/pause`, {});
  f.files[0].createdUnix = 1791504000;
  await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {});
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'failed');
  assert.match(job.files[0].error, /changed|unavailable/i);
  await assert.rejects(f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4')), { code: 'ENOENT' });
});

test('simultaneous save requests still run only one batch at a time', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600, delay: 700 }]);
  await f.connect();
  const responses = await Promise.all([f.startJob(), f.startJob()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  assert.equal((await f.api('/api/download-jobs')).body.jobs.length, 1);
});

test('the legacy save route respects the selected cloud destination and durable job recovery', async t => {
  const f = await fixture(t);
  await f.connect();
  const response = await f.api('/api/download', { destination: { type: 'google-drive' } });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Google|folder/i);
  await assert.rejects(f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4')), { code: 'ENOENT' });
  const local = await f.api('/api/download', { downloadRoot: path.join(f.root, 'saved'), recordingTimezone: 'UTC' });
  assert.equal(local.status, 202);
  assert.equal((await f.waitJob(local.body.job.id)).status, 'completed');
});

test('switching the connected camera during an active save cannot substitute another source', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600, delay: 800 }]);
  await f.connect();
  const created = await f.startJob();
  f.cameraState.serial = 'camera-other';
  assert.equal((await f.connect()).status, 409);
  await f.api(`/api/download-jobs/${created.body.job.id}/pause`, {});
  await f.connect();
  const resume = await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {});
  assert.equal(resume.status, 409);
  assert.match(resume.body.error, /original camera/i);
});

test('an inaccessible local destination pauses without changing the existing file', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'occupied');
  await require('node:fs/promises').writeFile(target, 'keep-this-file');
  await f.connect();
  const created = await f.startJob({ downloadRoot: target });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'paused');
  assert.equal(await f.readFile(target, 'utf8'), 'keep-this-file');
});

test('an invalid camera timestamp still saves the original under Unknown date', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 'invalid-date' }]);
  await f.connect();
  const created = await f.startJob();
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.files[0].recordingDate, 'Unknown date');
  assert.equal(await f.readFile(path.join(f.root, 'saved', 'Unknown date', 'GX010123.MP4'), 'utf8'), 'original-video');
});

test('a user saves an original video into its recording-day folder', async t => {
  const f = await fixture(t);
  assert.equal((await f.connect()).status, 200);
  const created = await f.startJob();
  assert.equal(created.status, 202);
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'original-video');
});

test('insufficient local space pauses before writing another original', async t => {
  const f = await fixture(t, undefined, { GOPRO_TEST_FREE_BYTES: '0' });
  await f.connect();
  const created = await f.startJob();
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'paused');
  assert.match(job.error, /space/i);
  await assert.rejects(f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4')), { code: 'ENOENT' });
});

test('a user retries a failed original after the camera can provide its complete bytes', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('short'), sizeBytes: 20, createdUnix: 1791417600 }]);
  await f.connect();
  const created = await f.startJob();
  await f.waitJob(created.body.job.id);
  f.files[0].data = Buffer.from('aaaaaaaaaaaaaaaaaaaa');
  const retry = await f.api(`/api/download-jobs/${created.body.job.id}/retry`, {});
  assert.equal(retry.status, 200);
  assert.equal((await f.waitJob(created.body.job.id)).status, 'completed');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'aaaaaaaaaaaaaaaaaaaa');
});

test('discarding unfinished work preserves videos already saved to the destination', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('saved-original'), createdUnix: 1791417600 },
    { name: 'GX010124.MP4', data: Buffer.from('pending-original'), createdUnix: 1791417600, delay: 400 }
  ]);
  await f.connect();
  const created = await f.startJob();
  await f.waitJob(created.body.job.id, job => job.files[0].status === 'completed' && job.files[1].status === 'running');
  const discarded = await f.api(`/api/download-jobs/${created.body.job.id}/discard`, {});
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.job.status, 'discarded');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'saved-original');
  await assert.rejects(f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010124.MP4')), { code: 'ENOENT' });
});

test('a paused batch can resume and save its original', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600, delay: 300 }]);
  await f.connect();
  const created = await f.startJob();
  await f.waitJob(created.body.job.id, job => job.status === 'running');
  const paused = await f.api(`/api/download-jobs/${created.body.job.id}/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.job.status, 'paused');
  const resumed = await f.api(`/api/download-jobs/${created.body.job.id}/resume`, {});
  assert.equal(resumed.status, 200);
  assert.equal((await f.waitJob(created.body.job.id)).status, 'completed');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'original-video');
});

test('reopening offers the interrupted batch for recovery without starting it automatically', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600, delay: 400 }]);
  await f.connect();
  const created = await f.startJob();
  await f.waitJob(created.body.job.id, job => job.status === 'running');
  await f.restart();
  const recovered = await f.api(`/api/download-jobs/${created.body.job.id}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.job.status, 'paused');
  assert.equal(recovered.body.job.recordingTimezone, 'UTC');
  assert.equal((await f.api('/api/download-jobs')).body.jobs[0].id, created.body.job.id);
});

test('an isolated incomplete video does not prevent the remaining originals from saving', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('short'), sizeBytes: 20, createdUnix: 1791417600 },
    { name: 'GX010124.MP4', data: Buffer.from('good-original'), createdUnix: 1791417600 }
  ]);
  await f.connect();
  const created = await f.startJob();
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'completed_with_errors');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010124.MP4'), 'utf8'), 'good-original');
});

test('different videos sharing a filename preserve both originals in a conflict folder', async t => {
  const f = await fixture(t);
  await f.connect();
  const first = await f.startJob();
  await f.waitJob(first.body.job.id);
  f.files[0].data = Buffer.from('different-video');
  const second = await f.startJob();
  const job = await f.waitJob(second.body.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'original-video');
  assert.equal(await f.readFile(job.files[0].savedTo, 'utf8'), 'different-video');
  assert.equal(path.basename(path.dirname(job.files[0].savedTo)), 'Conflicts-1');
});

test('re-saving the same original confirms the destination and skips a duplicate', async t => {
  const f = await fixture(t);
  await f.connect();
  const first = await f.startJob();
  await f.waitJob(first.body.job.id);
  const second = await f.startJob();
  const repeated = await f.waitJob(second.body.job.id);
  assert.equal(repeated.files[0].status, 'skipped');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'original-video');
});

test('each original keeps its date in the batch recording timezone, including unknown dates', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('first-chapter'), createdUnix: 1791417600 },
    { name: 'GX020123.MP4', data: Buffer.from('second-chapter'), createdUnix: 1791446400 },
    { name: 'GX010124.MP4', data: Buffer.from('undated'), createdUnix: 0 }
  ]);
  await f.connect();
  const created = await f.startJob({ recordingTimezone: 'America/Los_Angeles' });
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.recordingTimezone, 'America/Los_Angeles');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-07', 'GX010123.MP4'), 'utf8'), 'first-chapter');
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX020123.MP4'), 'utf8'), 'second-chapter');
  assert.equal(await f.readFile(path.join(f.root, 'saved', 'Unknown date', 'GX010124.MP4'), 'utf8'), 'undated');
});

test('only original videos are offered for saving and photo requests are rejected', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600 },
    { name: 'GOPR0123.JPG', data: Buffer.from('photo'), createdUnix: 1791417600 },
    { name: 'GL010123.LRV', data: Buffer.from('proxy'), createdUnix: 1791417600 }
  ]);
  await f.connect();
  assert.deepEqual((await f.api('/api/media')).body.files.map(file => file.name), ['GX010123.MP4']);
  assert.equal((await f.startJob({ files: [{ directory: '100GOPRO', name: 'GOPR0123.JPG' }] })).status, 400);
});

test('a truncated camera response is not reported as a saved original', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('short'), sizeBytes: 20, createdUnix: 1791417600 }]);
  await f.connect();
  const created = await f.startJob();
  const job = await f.waitJob(created.body.job.id);
  assert.equal(job.status, 'failed');
  await assert.rejects(f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4')), { code: 'ENOENT' });
});
