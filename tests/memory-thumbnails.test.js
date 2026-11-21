const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { makeMemoryThumbnails } = require('../services/memoryThumbnails');

test('memory thumbnails shrink a large portrait, preserve reference keys, and skip corrupt photos', async () => {
  const portrait = execFileSync('/usr/bin/python3', ['-c', [
    'from PIL import Image',
    'import sys',
    "Image.effect_noise((720,1080),85).convert('RGB').save(sys.stdout.buffer, 'PNG')",
  ].join('\n')], { maxBuffer: 4 * 1024 * 1024 });
  const original = portrait.toString('base64');
  const thumbnails = await makeMemoryThumbnails('fixture-owner', {
    original: { mime: 'image/png', base64: original },
    corrupt: { mime: 'image/png', base64: 'broken' },
  });
  assert.deepEqual(Object.keys(thumbnails), ['original']);
  const photo = thumbnails.original;
  assert.equal(photo.mime, 'image/jpeg');
  const bytes = Buffer.from(photo.base64, 'base64');
  assert(bytes.length <= 12 * 1024);
  assert(photo.base64.length < original.length / 10);
  const dimensions = execFileSync('/usr/bin/python3', ['-c',
    'from PIL import Image; import sys; print(*Image.open(sys.stdin.buffer).size)',
  ], { input: bytes }).toString().trim().split(' ').map(Number);
  assert(dimensions[0] < dimensions[1] && dimensions[1] <= 320);
  assert.equal((await makeMemoryThumbnails('fixture-owner', { original: { base64: original } })).original, photo);
  assert.equal(Object.keys(await makeMemoryThumbnails('another-owner', { original: { base64: 'broken' } })).length, 0);
});
