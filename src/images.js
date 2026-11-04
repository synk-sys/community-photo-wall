/**
 * Identifies an image from its bytes. The client's declared type and filename are never trusted,
 * and because only these raster formats pass, a stored file can't execute as HTML or SVG.
 */
export function sniffImage(bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}
