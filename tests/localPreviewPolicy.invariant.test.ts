// The shipped page must admit the local asset transport for both image and media preview representations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window } from 'happy-dom';

export const GUARDS = ['index.html'];

test('the shipped page CSP admits the preview asset scheme for images, audio and video', () => {
  const window = new Window();
  window.document.write(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  try {
    const content = window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    const policy = new Map(
      content.split(';').map((part) => {
        const [directive, ...sources] = part.trim().split(/\s+/);
        return [directive, sources];
      }),
    );
    for (const directive of ['img-src', 'media-src'])
      assert.ok(
        (policy.get(directive) || policy.get('default-src') || []).includes('codex-asset:'),
        `${directive} must admit local preview assets`,
      );
    // Saved-recording playback uses a data URL; blob playback already inherited admission before media-src was explicit.
    for (const scheme of ['data:', 'blob:'])
      assert.ok(policy.get('media-src')!.includes(scheme), `media-src must retain ${scheme} playback`);
  } finally {
    window.happyDOM.abort();
  }
});
