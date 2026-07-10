/**
 * Validates and normalizes user-supplied file paths into `MediaFile`
 * records ready for upload: resolves absolute paths, checks existence,
 * maps extension -> MIME type, verifies magic bytes for the raster image
 * formats, enforces GitHub's own size limits, and sanitizes file names
 * (de-duplicating collisions with a numeric suffix).
 *
 * All checks for every input path are run before failing, so a single
 * error lists every problematic file instead of stopping at the first one.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MediaFile } from './types.js';

type MediaKind = 'image' | 'video';

interface ExtensionInfo {
  mime: string;
  kind: MediaKind;
}

/** Explicit extension -> MIME map. Lookup is done on the lower-cased extension. */
const EXTENSION_MIME_MAP: Record<string, ExtensionInfo> = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.svg': { mime: 'image/svg+xml', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
};

/** Same limits GitHub's web UI enforces for PR attachments. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Anything outside this set is replaced with '-' when sanitizing a file name. */
const UNSAFE_NAME_CHARS_RE = /[^a-zA-Z0-9._-]/g;

/**
 * Magic-byte signature checks. Only the raster formats called out in the
 * spec are checked (png/jpg/gif/webp) — svg is text-based and the video
 * containers have no single fixed signature worth hand-rolling here.
 */
const MAGIC_BYTE_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  '.png': (buf) =>
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a,
  '.jpg': (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  '.jpeg': (buf) => MAGIC_BYTE_CHECKS['.jpg'](buf),
  '.gif': (buf) =>
    buf.length >= 6 &&
    buf[0] === 0x47 && // G
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x38 && // 8
    (buf[4] === 0x37 || buf[4] === 0x39) && // 7 or 9
    buf[5] === 0x61, // a
  '.webp': (buf) =>
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP',
};

/** Bytes read from the start of the file to run magic-byte checks against. */
const MAGIC_HEADER_BYTES = 16;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Sanitizes a file name to `[a-zA-Z0-9._-]`, preserves the (lower-cased)
 * extension, and de-duplicates against names already used in this batch by
 * appending a numeric suffix (`name-2.png`, `name-3.png`, ...).
 */
function sanitizeFileName(originalName: string, lowerExt: string, usedNames: Set<string>): string {
  const base = originalName.slice(0, originalName.length - lowerExt.length);
  let safeBase = base.replace(UNSAFE_NAME_CHARS_RE, '-');
  if (!safeBase) safeBase = 'file';

  let candidate = `${safeBase}${lowerExt}`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${safeBase}-${suffix}${lowerExt}`;
    suffix++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function readHeader(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Validates every path and returns the corresponding `MediaFile` list.
 * Throws a single `Error` listing all problems if any path is invalid —
 * nothing is uploaded on a partially-valid batch.
 */
export async function validateFiles(paths: string[]): Promise<MediaFile[]> {
  const errors: string[] = [];
  const results: MediaFile[] = [];
  const usedNames = new Set<string>();

  for (const rawPath of paths) {
    const absPath = path.resolve(rawPath);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        errors.push(`${rawPath}: not a regular file.`);
        continue;
      }
      if (stat.size === 0) {
        errors.push(`${rawPath}: file is empty.`);
        continue;
      }

      const rawExt = path.extname(absPath);
      const lowerExt = rawExt.toLowerCase();
      const info = EXTENSION_MIME_MAP[lowerExt];
      if (!info) {
        errors.push(
          `${rawPath}: unsupported file extension "${rawExt || '(none)'}". ` +
            `Supported extensions: ${Object.keys(EXTENSION_MIME_MAP).join(', ')}.`,
        );
        continue;
      }

      const maxBytes = info.kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (stat.size > maxBytes) {
        errors.push(
          `${rawPath}: file is ${formatBytes(stat.size)}, which exceeds the ` +
            `${formatBytes(maxBytes)} limit GitHub applies to ${info.kind}s.`,
        );
        continue;
      }

      const magicCheck = MAGIC_BYTE_CHECKS[lowerExt];
      if (magicCheck) {
        const header = await readHeader(absPath, MAGIC_HEADER_BYTES);
        if (!magicCheck(header)) {
          errors.push(
            `${rawPath}: file content does not match its "${lowerExt}" extension ` +
              '(magic bytes mismatch) — the file may be corrupt, truncated, or mislabeled.',
          );
          continue;
        }
      }

      const originalName = path.basename(absPath);
      const sanitizedName = sanitizeFileName(originalName, lowerExt, usedNames);

      results.push({
        path: absPath,
        name: sanitizedName,
        mime: info.mime,
        size: stat.size,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        errors.push(`${rawPath}: file not found.`);
      } else if (e.code === 'EACCES') {
        errors.push(`${rawPath}: permission denied.`);
      } else {
        errors.push(`${rawPath}: ${e.message}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid media file(s):\n${errors.map((message) => `  - ${message}`).join('\n')}`,
    );
  }

  return results;
}
