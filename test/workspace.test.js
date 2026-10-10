const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture, googleFixture } = require('./fixtures');

test('a paused cloud batch can resume from the workspace after restart without a camera', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  const folder = (await f.api('/api/cloud/google/folder', {})).body.folder;
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive', folderId: folder.id } });
  assert.equal((await f.waitJob(created.body.job.id)).status, 'paused');
  await f.restart();
  google.controls.uploadStatus = 0;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(f.url);
  await page.getByRole('button', { name: 'Resume batch', exact: true }).click();
  await page.getByText('Save complete', { exact: true }).waitFor();
  const job = (await f.api(`/api/download-jobs/${created.body.job.id}`)).body.job;
  assert.equal(job.status, 'completed');
  assert.equal((await f.api('/api/status')).body.session, null);
  assert.equal(await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}?alt=media`)).text(), 'original-video');
});

test('unfinished cloud work still offers reconnecting its original Google account', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  google.controls.uploadStatus = 403;
  const created = await f.startJob({ destination: { type: 'google-drive' } });
  await f.waitJob(created.body.job.id);
  await f.restart();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(f.url);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Reconnect original account', exact: true }).click();
  const popup = await popupPromise;
  await popup.getByRole('heading', { name: 'Google Drive connected', exact: true }).waitFor();
  await popup.close();
  google.controls.uploadStatus = 0;
  await page.getByRole('button', { name: 'Resume batch', exact: true }).click();
  await page.getByText('Save complete', { exact: true }).waitFor();
});

test('the workspace lets a user choose local saving and save only the queued original', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('original-video'), createdUnix: 1791417600 },
    { name: 'GOPR0123.JPG', data: Buffer.from('photo'), createdUnix: 1791417600 }
  ]);
  await f.connect();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  await page.goto(f.url + '/main');
  await page.getByLabel('Save destination', { exact: true }).selectOption('local');
  await page.getByLabel('Local folder', { exact: true }).fill(path.join(f.root, 'saved'));
  await page.getByLabel('Recording timezone', { exact: true }).fill('UTC');
  await page.getByRole('checkbox', { name: 'Select GX010123.MP4', exact: true }).check();
  assert.equal(await page.getByText('GOPR0123.JPG', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Queue selected', exact: true }).click();
  await page.getByRole('button', { name: 'Start queue', exact: true }).click();
  await page.getByText('Save complete', { exact: true }).waitFor();
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'original-video');
});

test('the workspace can pause and discard unfinished work while keeping saved originals', async t => {
  const f = await fixture(t, [
    { name: 'GX010123.MP4', data: Buffer.from('saved-original'), createdUnix: 1791417600 },
    { name: 'GX020123.MP4', data: Buffer.from('pending-original'), createdUnix: 1791417600, delay: 3500 }
  ]);
  await f.connect();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(f.url + '/main');
  await page.getByLabel('Local folder', { exact: true }).fill(path.join(f.root, 'saved'));
  await page.getByLabel('Recording timezone', { exact: true }).fill('UTC');
  await page.getByRole('button', { name: 'Queue all', exact: true }).click();
  await page.getByRole('button', { name: 'Start queue', exact: true }).click();
  await page.getByRole('button', { name: 'Pause batch', exact: true }).waitFor();
  const id = (await f.api('/api/download-jobs')).body.jobs[0].id;
  await f.waitJob(id, job => job.completedFiles === 1);
  await page.getByRole('button', { name: 'Pause batch', exact: true }).click();
  await page.getByText('Batch paused', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Discard unfinished', exact: true }).click();
  await page.getByText('Unfinished work discarded', { exact: true }).waitFor();
  assert.equal(await f.readFile(path.join(f.root, 'saved', '2026-10-08', 'GX010123.MP4'), 'utf8'), 'saved-original');
  assert.equal((await f.api(`/api/download-jobs/${id}`)).body.job.files[1].status, 'discarded');
});

test('recovered failed batches remain selectable and their failed videos can be retried', async t => {
  const f = await fixture(t, [{ name: 'GX010123.MP4', data: Buffer.from('short'), sizeBytes: 14, createdUnix: 1791417600 }]);
  await f.connect();
  const first = await f.startJob();
  await f.waitJob(first.body.job.id);
  const second = await f.startJob();
  await f.waitJob(second.body.job.id);
  await f.restart();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(f.url);
  await page.getByLabel('Unfinished batches', { exact: true }).selectOption(first.body.job.id);
  f.files[0].data = Buffer.from('original-video');
  await f.connect();
  await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
  await page.getByText('Save complete', { exact: true }).waitFor();
  assert.equal((await f.api(`/api/download-jobs/${first.body.job.id}`)).body.job.status, 'completed');
  assert.equal((await f.api(`/api/download-jobs/${second.body.job.id}`)).body.job.status, 'failed');
});

test('cloud saving visibly distinguishes upload and verification before calling a video saved', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await google.authorize(f);
  await f.api('/api/cloud/google/folder', {});
  await f.connect();
  google.controls.uploadDelay = 2200;
  google.controls.verificationDelay = 2200;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(f.url + '/main');
  await page.getByLabel('Save destination', { exact: true }).selectOption('google-drive');
  await page.getByRole('button', { name: 'Queue all', exact: true }).click();
  await page.getByRole('button', { name: 'Start queue', exact: true }).click();
  await page.getByText('Uploading original', { exact: true }).waitFor();
  await page.getByText('Verifying original', { exact: true }).waitFor();
  assert.equal(await page.getByText('Save complete', { exact: true }).count(), 0);
  assert.equal(await page.locator('#stat-download-root').textContent(), 'Google Drive · GoPro Exports');
  await page.getByText('Save complete', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open saved GX010123.MP4', exact: true }).waitFor();
});

test('the workspace connects Google, selects a folder, saves an original, and disconnects', async t => {
  const google = await googleFixture(t);
  const f = await fixture(t, undefined, google.env);
  await f.connect();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(f.url + '/main');
  await page.getByLabel('Save destination', { exact: true }).selectOption('google-drive');
  const authorization = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click();
  const popup = await authorization;
  await popup.getByRole('heading', { name: 'Google Drive connected', exact: true }).waitFor();
  await popup.close();
  await page.getByText('owner@example.test', { exact: true }).waitFor();
  const picker = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Choose existing folder', exact: true }).click();
  const picked = await picker;
  await picked.getByRole('heading', { name: 'Google Drive connected', exact: true }).waitFor();
  await picked.close();
  await page.getByText('Existing videos', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create GoPro Exports folder', exact: true }).click();
  await page.getByText('GoPro Exports', { exact: true }).waitFor();
  if (process.env.GOPRO_SCREENSHOTS === '1') {
    const output = path.resolve('.test-output');
    await require('node:fs/promises').mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'cloud-desktop.png') });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.screenshot({ path: path.join(output, 'cloud-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await page.getByLabel('Recording timezone', { exact: true }).fill('UTC');
  await page.getByRole('checkbox', { name: 'Select GX010123.MP4', exact: true }).check();
  await page.getByRole('button', { name: 'Queue selected', exact: true }).click();
  await page.getByRole('button', { name: 'Start queue', exact: true }).click();
  await page.getByText('Save complete', { exact: true }).waitFor();
  if (process.env.GOPRO_SCREENSHOTS === '1') {
    await page.locator('#download-center-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve('.test-output/cloud-saved.png') });
  }
  const job = (await f.api('/api/download-jobs')).body.jobs[0];
  assert.equal(job.destination.type, 'google-drive');
  assert.equal(await (await fetch(`${google.url}/drive/v3/files/${job.files[0].driveFileId}?alt=media`)).text(), 'original-video');
  await page.getByRole('button', { name: 'Disconnect Google Drive', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).waitFor();
});
