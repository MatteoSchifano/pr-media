import { describe, it, expect } from 'vitest';
import { buildMarkdown } from '../src/embed.js';
import type { UploadResult } from '../src/types.js';

const MARKER = '<!-- pr-media -->';

const imageFile = {
  path: '/tmp/shot.png',
  name: 'shot.png',
  mime: 'image/png',
  size: 123,
};

const videoFile = {
  path: '/tmp/clip.mp4',
  name: 'clip.mp4',
  mime: 'video/mp4',
  size: 456,
};

describe('buildMarkdown', () => {
  it('prefixes the output with the pr-media marker', () => {
    const results: UploadResult[] = [
      {
        file: imageFile,
        url: 'https://github.com/user-attachments/assets/abc',
        markdown: '![shot.png](https://github.com/user-attachments/assets/abc)',
        strategy: 'browser',
      },
    ];

    const block = buildMarkdown(results);
    expect(block.startsWith(MARKER)).toBe(true);
  });

  it('embeds images with markdown image syntax', () => {
    const results: UploadResult[] = [
      {
        file: imageFile,
        url: 'https://example.com/shot.png',
        markdown: '![shot.png](https://example.com/shot.png)',
        strategy: 'hidden-ref',
      },
    ];

    const block = buildMarkdown(results);
    expect(block).toContain('![shot.png](https://example.com/shot.png)');
    expect(block).not.toContain('<video');
  });

  it('embeds videos with a <video> tag instead of image syntax', () => {
    const results: UploadResult[] = [
      {
        file: videoFile,
        url: 'https://example.com/clip.mp4',
        markdown: '<video src="https://example.com/clip.mp4" controls></video>',
        strategy: 'release',
      },
    ];

    const block = buildMarkdown(results);
    expect(block).toContain('<video src="https://example.com/clip.mp4" controls></video>');
    expect(block).not.toMatch(/!\[/);
  });

  it('joins multiple results on their own lines, one marker at the top', () => {
    const results: UploadResult[] = [
      {
        file: imageFile,
        url: 'https://example.com/shot.png',
        markdown: '![shot.png](https://example.com/shot.png)',
        strategy: 'hidden-ref',
      },
      {
        file: videoFile,
        url: 'https://example.com/clip.mp4',
        markdown: '<video src="https://example.com/clip.mp4" controls></video>',
        strategy: 'release',
      },
    ];

    const block = buildMarkdown(results);
    const lines = block.split('\n');

    expect(lines[0]).toBe(MARKER);
    expect(lines[1]).toBe('![shot.png](https://example.com/shot.png)');
    expect(lines[2]).toBe('<video src="https://example.com/clip.mp4" controls></video>');
    expect(lines).toHaveLength(3);

    // Marker appears exactly once even with multiple results.
    expect(block.split(MARKER)).toHaveLength(2);
  });

  it('returns just the marker (plus trailing newline join) for an empty result list', () => {
    const block = buildMarkdown([]);
    // buildMarkdown always joins with `${MARKER}\n${lines.join('\n')}`, so an
    // empty result list still leaves a trailing newline after the marker.
    expect(block).toBe(`${MARKER}\n`);
  });
});
