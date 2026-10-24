import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(directory) { this.directory = directory; }
  async read(name, fallback = null) {
    try { return JSON.parse(await readFile(path.join(this.directory, name + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  async write(name, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, name + '.json');
    const temp = target + '.tmp';
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, target);
  }
}
