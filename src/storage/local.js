import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Development-only stand-in for Drive. config.js refuses it in production. */
export function createLocalStorage({ directory }) {
  return {
    async assertPrivate() {},
    async put(name, bytes) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), bytes);
      return name;
    },
    get: (key) => readFile(join(directory, key)),
    delete: (key) => rm(join(directory, key), { force: true }),
  };
}
