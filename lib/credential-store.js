const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// Only the OS boundary sees plaintext. Secrets travel on stdin, never command arguments.
async function protect(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('Remembered Google authorization currently requires Windows');
  const operation = decrypt
    ? '$bytes=[Convert]::FromBase64String($inputValue); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))'
    : '$bytes=[Text.Encoding]::UTF8.GetBytes($inputValue); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))';
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); ' + operation;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Windows credential protection timed out')); }, 15000);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(deadline); reject(new Error('Windows credential protection is unavailable')); });
    child.on('close', code => { clearTimeout(deadline); code === 0 ? resolve(output) : reject(new Error('Windows could not protect or open the saved authorization')); });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

class CredentialStore {
  constructor(root) { this.root = root; this.filename = path.join(root, 'google-authorization.bin'); this.pending = Promise.resolve(); }
  async load() {
    try { return JSON.parse(await protect(await fs.readFile(this.filename, 'utf8'), true)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(value) {
    const snapshot = JSON.stringify(value);
    const write = this.pending.then(async () => {
      const encrypted = await protect(snapshot);
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(`${this.filename}.tmp`, encrypted, { mode: 0o600 });
      await fs.rename(`${this.filename}.tmp`, this.filename);
    });
    this.pending = write.catch(() => {});
    return write;
  }
  async clear() { const clear = this.pending.then(() => fs.rm(this.filename, { force: true })); this.pending = clear.catch(() => {}); return clear; }
  seal(value) { return protect(value); }
  open(value) { return protect(value, true); }
}

module.exports = { CredentialStore };
