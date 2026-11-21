const { execFile } = require('node:child_process');
const path = require('node:path');
const { AppError } = require('../utils/errors');

const cache = new Map();
const cacheLimit = 12 * 1024 * 1024;
let cacheBytes = 0;
let active = 0;
const maxWorkers = 2;

function resizeBatch(images) {
  const script = path.join(__dirname, '../scripts/memory-thumbnails.py');
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.MATERIALS_PYTHON || '/usr/bin/python3', [script], {
      timeout: 12000,
      maxBuffer: 600 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    // A failed worker may close its input before consuming the entire batch.
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(Object.fromEntries(images.map(([id, image]) => [id, image.base64]))) + '\n');
  });
}

function remember(key, image) {
  if (cache.has(key)) return;
  cache.set(key, image);
  cacheBytes += image.base64.length;
  while (cacheBytes > cacheLimit) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).base64.length;
    cache.delete(oldest);
  }
}

async function makeMemoryThumbnails(scope, originalImages) {
  const images = Object.create(null);
  const missing = [];
  for (const [id, image] of Object.entries(originalImages)) {
    const cached = cache.get(scope + ':' + id);
    if (cached) images[id] = cached;
    else missing.push([id, image]);
  }
  if (!missing.length) return images;
  if (active >= maxWorkers)
    throw new AppError(503, 'MEMORY_PHOTOS_BUSY', '正在准备其他背诵资料，请稍后点同步重试');
  active++;
  try {
    for (let start = 0; start < missing.length; start += 32) {
      const batch = missing.slice(start, start + 32);
      const result = await resizeBatch(batch);
      for (const [id] of batch) {
        if (!result[id]) continue;
        images[id] = { mime: 'image/jpeg', base64: result[id] };
        remember(scope + ':' + id, images[id]);
      }
    }
    return images;
  } catch {
    throw new AppError(503, 'MEMORY_PHOTOS_UNAVAILABLE', '背诵照片暂未准备好，请稍后重新同步');
  } finally {
    active--;
  }
}

module.exports = { makeMemoryThumbnails };
