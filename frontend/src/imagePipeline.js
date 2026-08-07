/**
 * Browser-side image preparation for ticket photos.
 *
 * The shop floor reality this solves:
 *   - iPhones shoot HEIC by default. No browser can render HEIC in an <img>,
 *     so an unconverted upload is a permanently broken thumbnail.
 *   - A modern phone photo is 3-6 MB. On shop wifi, uploading a dozen of those
 *     raw is slow enough that people stop bothering.
 *   - Photos straight off a phone carry EXIF orientation, so they arrive
 *     sideways unless the rotation is baked into the pixels.
 *
 * So every file is normalised before it leaves the browser: HEIC decoded to
 * JPEG, orientation baked in, longest edge capped, re-encoded as JPEG. A 5 MB
 * HEIC becomes a ~400 KB correctly-rotated JPEG that renders anywhere.
 *
 * heic2any is ~1.4 MB, so it is imported lazily — only a tech who actually
 * uploads a HEIC ever downloads it.
 */

const MAX_EDGE = 2560;       // plenty for before/after documentation and zooming
const JPEG_QUALITY = 0.85;
const PASSTHROUGH_MAX_BYTES = 400 * 1024;

const HEIC_EXTENSIONS = /\.(heic|heif)$/i;
const HEIC_MIME = /^image\/(heic|heif)/i;

/**
 * iOS often hands over a HEIC with an empty or wrong `type`, so the filename
 * has to be part of the test.
 */
export function isHeic(file) {
  return HEIC_MIME.test(file.type || '') || HEIC_EXTENSIONS.test(file.name || '');
}

export function isProbablyImage(file) {
  return (file.type || '').startsWith('image/') || isHeic(file)
    || /\.(jpe?g|png|webp|gif)$/i.test(file.name || '');
}

const swapExtension = (name, ext) => `${(name || 'photo').replace(/\.[^.]+$/, '')}.${ext}`;

async function heicToJpeg(file) {
  const { default: heic2any } = await import('heic2any');
  const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: JPEG_QUALITY });
  // heic2any returns an array for multi-image HEICs (burst / live photos).
  return Array.isArray(converted) ? converted[0] : converted;
}

/**
 * Decode to a bitmap with EXIF rotation already applied where the browser
 * supports it, falling back to an <img> element on older Safari.
 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Safari <16 rejects the options bag; fall through.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image'));
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToCanvas(source, maxEdge) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;

  // Never upscale — a small photo stays its own size.
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  // White matte: JPEG has no alpha, and a transparent PNG would otherwise
  // flatten onto black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  if (source.close) source.close(); // release the ImageBitmap
  return canvas;
}

const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode that image'))),
    type,
    quality,
  );
});

/**
 * Normalise one file for upload.
 *
 * @returns {Promise<{blob: Blob, name: string, type: string,
 *                    originalBytes: number, finalBytes: number,
 *                    width: number, height: number, converted: boolean}>}
 */
export async function prepareImage(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  if (!isProbablyImage(file)) {
    throw new Error(`${file.name || 'That file'} is not an image`);
  }

  const originalBytes = file.size;
  const heic = isHeic(file);
  let working = file;

  if (heic) {
    try {
      working = await heicToJpeg(file);
    } catch (err) {
      throw new Error(
        `Could not convert ${file.name} from HEIC. Set the camera to `
        + '"Most Compatible" in iOS Settings → Camera → Formats, or upload a JPEG.',
      );
    }
  }

  // Already small, already web-safe, and no rotation to bake in — leave it be.
  if (!heic && working.size <= PASSTHROUGH_MAX_BYTES
      && /^image\/(jpeg|png|webp)$/.test(working.type)) {
    return {
      blob: working,
      name: file.name || 'photo',
      type: working.type,
      originalBytes,
      finalBytes: working.size,
      width: 0,
      height: 0,
      converted: false,
    };
  }

  const source = await decode(working);
  const canvas = drawToCanvas(source, maxEdge);
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);

  // If re-encoding somehow made it bigger (already-optimised small JPEGs can
  // do this), keep whichever is smaller — as long as it's web-safe.
  if (!heic && blob.size >= working.size && /^image\/(jpeg|png|webp)$/.test(working.type)) {
    return {
      blob: working,
      name: file.name || 'photo',
      type: working.type,
      originalBytes,
      finalBytes: working.size,
      width: canvas.width,
      height: canvas.height,
      converted: false,
    };
  }

  return {
    blob,
    name: swapExtension(file.name, 'jpg'),
    type: 'image/jpeg',
    originalBytes,
    finalBytes: blob.size,
    width: canvas.width,
    height: canvas.height,
    converted: true,
  };
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const pipelineDefaults = { MAX_EDGE, JPEG_QUALITY, PASSTHROUGH_MAX_BYTES };
