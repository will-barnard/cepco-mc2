/**
 * Unit tests for the browser image pipeline.
 *
 * The DOM bits (canvas, createImageBitmap) are stubbed, so this covers the
 * decision logic — which is where the bugs live: what counts as HEIC, what
 * gets passed through untouched, what gets re-encoded, and that re-encoding
 * never makes a file bigger.
 *
 * Not covered here: the actual HEIC decode. That needs heic2any and a real
 * WASM-capable browser, so it's verified by hand against a real iPhone file
 * rather than pretended at with a stub. What *is* covered is the detection
 * that routes a file into that path, including the iOS empty-MIME-type case.
 *
 * Run: npm test --prefix frontend
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- minimal browser stubs ------------------------------------------------
class FakeBlob {
  constructor(size, type) { this.size = size; this.type = type; }
}

class FakeFile extends FakeBlob {
  constructor(name, size, type) { super(size, type); this.name = name; }
}

let drawnTo = null;
let encodeSize = 100 * 1024;

globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '', fillRect() {}, drawImage() {},
    }),
    toBlob(cb, type, quality) {
      drawnTo = { width: this.width, height: this.height, type, quality };
      cb(new FakeBlob(encodeSize, type));
    },
  }),
};

globalThis.createImageBitmap = async () => ({ width: 4032, height: 3024, close() {} });
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

const {
  isHeic, isProbablyImage, prepareImage, formatBytes,
} = await import('../src/imagePipeline.js');

// --- detection -------------------------------------------------------------
test('detects HEIC by MIME type', () => {
  assert.equal(isHeic(new FakeFile('a.jpg', 1, 'image/heic')), true);
  assert.equal(isHeic(new FakeFile('a.jpg', 1, 'image/heif')), true);
});

test('detects HEIC by extension when iOS sends an empty MIME type', () => {
  // This is the real-world case: Safari hands over type: '' for HEIC.
  assert.equal(isHeic(new FakeFile('IMG_0802.HEIC', 1, '')), true);
  assert.equal(isHeic(new FakeFile('IMG_0802.heif', 1, '')), true);
});

test('does not treat normal photos as HEIC', () => {
  assert.equal(isHeic(new FakeFile('a.jpg', 1, 'image/jpeg')), false);
  assert.equal(isHeic(new FakeFile('a.png', 1, 'image/png')), false);
});

test('recognises images by type or extension, rejects other files', () => {
  assert.equal(isProbablyImage(new FakeFile('a.jpg', 1, 'image/jpeg')), true);
  assert.equal(isProbablyImage(new FakeFile('a.HEIC', 1, '')), true);
  assert.equal(isProbablyImage(new FakeFile('notes.pdf', 1, 'application/pdf')), false);
  assert.equal(isProbablyImage(new FakeFile('run.sh', 1, 'application/x-sh')), false);
});

// --- passthrough vs re-encode ---------------------------------------------
test('small web-safe images pass through untouched', async () => {
  const file = new FakeFile('small.jpg', 120 * 1024, 'image/jpeg');
  const out = await prepareImage(file);
  assert.equal(out.converted, false);
  assert.equal(out.blob, file, 'the original blob should be reused');
  assert.equal(out.finalBytes, 120 * 1024);
});

test('large photos are downscaled and re-encoded as JPEG', async () => {
  encodeSize = 380 * 1024;
  const file = new FakeFile('big.jpg', 5 * 1024 * 1024, 'image/jpeg');
  const out = await prepareImage(file);

  assert.equal(out.converted, true);
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.finalBytes, 380 * 1024);
  assert.ok(out.finalBytes < out.originalBytes, 'should be smaller than the original');
});

test('downscaling caps the longest edge and preserves aspect ratio', async () => {
  encodeSize = 380 * 1024;
  await prepareImage(new FakeFile('big.jpg', 5 * 1024 * 1024, 'image/jpeg'));

  // Source stub is 4032x3024 (4:3); cap is 2560.
  assert.equal(drawnTo.width, 2560);
  assert.equal(drawnTo.height, 1920);
  assert.equal(drawnTo.type, 'image/jpeg');
});

test('never upscales an image that is already under the cap', async () => {
  globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
  encodeSize = 90 * 1024;
  await prepareImage(new FakeFile('medium.png', 900 * 1024, 'image/png'));

  assert.equal(drawnTo.width, 800);
  assert.equal(drawnTo.height, 600);
  globalThis.createImageBitmap = async () => ({ width: 4032, height: 3024, close() {} });
});

test('keeps the original when re-encoding would make it bigger', async () => {
  // An already-optimised JPEG can grow when re-encoded — the pipeline should
  // notice and keep whichever is smaller.
  encodeSize = 3 * 1024 * 1024;
  const file = new FakeFile('optimised.jpg', 600 * 1024, 'image/jpeg');
  const out = await prepareImage(file);

  assert.equal(out.converted, false);
  assert.equal(out.finalBytes, 600 * 1024);
});

test('rejects non-image files with a clear message', async () => {
  await assert.rejects(
    () => prepareImage(new FakeFile('notes.pdf', 1000, 'application/pdf')),
    /not an image/,
  );
});

// --- formatting ------------------------------------------------------------
test('formatBytes is human readable at each magnitude', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
