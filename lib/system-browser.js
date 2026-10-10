const { spawn } = require('node:child_process');

function openSystemBrowser(url) {
  const testLauncher = process.env.NODE_ENV === 'test' && process.env.GOPRO_TEST_BROWSER_LAUNCHER;
  if (process.env.NODE_ENV === 'test' && !testLauncher) return Promise.resolve(false);
  if (process.platform !== 'win32' && !testLauncher) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = testLauncher
      ? spawn(process.execPath, [testLauncher, url], { windowsHide: true, stdio: 'ignore' })
      : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

module.exports = { openSystemBrowser };
