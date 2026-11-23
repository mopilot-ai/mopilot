// How a screenshot attached to a form reads in the chat (#1530): the step line counts screenshots given by id as files and
// names browser_save_screenshot, and the Claude in Chrome approval card lists each screenshot it would upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { chromeApproval } from '../src/harness/chromeApproval.ts';

const narrationUrl = new URL('../src/lib/agentNarration.ts', import.meta.url).href;
// the renderer's bundler resolves extensionless imports; Node needs the file's own extension
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === narrationUrl && s === './toolOutput')
      return { shortCircuit: true, url: new URL('../src/lib/toolOutput.ts', import.meta.url).href };
    return next(s, c);
  },
});
const { controlStep } = await import(narrationUrl);

const step = (tool: string, args: any = {}) =>
  controlStep({ type: 'mcpToolCall', server: 'sage', tool, arguments: args, status: 'completed', result: { content: [] } });

test('browser_file_upload counts screenshots by id as files; browser_save_screenshot says it saved one to upload', () => {
  assert.equal(step('browser_file_upload', { paths: ['/a'], screenshots: ['ss_1', 'ss_2'] })?.done, 'Uploaded 3 files');
  assert.equal(step('browser_file_upload', { screenshots: ['ss_1'] })?.done, 'Uploaded 1 file');
  assert.equal(step('browser_file_upload', { paths: [] })?.done, 'Uploaded 1 file');
  assert.equal(step('browser_save_screenshot', { full_page: true })?.done, 'Saved a screenshot to upload');
  assert.equal(step('browser_save_screenshot')?.doing, 'Saving a screenshot to upload');
});

test('the Claude in Chrome upload card names each screenshot beside the files', () => {
  const v = (tool: string, input: any) => chromeApproval(`mcp__claude-in-chrome__${tool}`, input)!;
  assert.deepEqual(v('upload_image', { imageId: 'ss_1' }).rows, [{ label: 'Screenshot', value: 'ss_1' }]);
  assert.deepEqual(v('file_upload', { paths: ['/tmp/a.png'], screenshots: ['ss_2'] }).rows, [
    { label: 'File', value: '/tmp/a.png' },
    { label: 'Screenshot', value: 'ss_2' },
  ]);
  assert.deepEqual(v('upload_image', {}).rows, []);
});
