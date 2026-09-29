import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonFileAtomic } from './pipeline_file_io.mjs';

// Session URLs grant access to a pending upload. Keep them in private local
// state, separate from the public progress payload and the recording's name.
export function createUploadSessionStore(directory, sourcePath) {
  const resolved = path.resolve(sourcePath);
  const key = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
  const filePath = path.join(directory, `${key}.json`);
  return {
    async load() {
      let contents;
      try { contents = await fs.readFile(filePath, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try {
        const data = JSON.parse(contents);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
        return data;
      } catch {
        throw Object.assign(new Error('The saved upload checkpoint cannot be read. Preserve it and verify the upload before retrying.'), { code: 'SOFTUCHIVE_UPLOAD_SESSION_UNREADABLE' });
      }
    },
    async save(snapshot) {
      if (snapshot === null) await fs.rm(filePath, { force: true });
      else await writeJsonFileAtomic(filePath, snapshot, { durable: true });
    },
  };
}
