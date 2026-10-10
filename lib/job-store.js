const fs = require('node:fs/promises');
const path = require('node:path');

class JobStore {
  constructor(root) { this.root = root; this.filename = path.join(root, 'jobs.json'); this.pending = Promise.resolve(); }
  async load() {
    try {
      const records = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid saved-job records');
      return records;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(jobs) {
    const snapshot = JSON.stringify([...jobs.values()], (key, value) => ['controller', 'task', 'progressSamples', 'sessionUrl'].includes(key) ? undefined : value);
    const write = this.pending.then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(`${this.filename}.tmp`, snapshot, { mode: 0o600 });
      await fs.rename(`${this.filename}.tmp`, this.filename);
    });
    this.pending = write.catch(() => {});
    return write;
  }
}

module.exports = { JobStore };
