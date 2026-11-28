// Markdown in a chat on a machine (src/components/markdown/Markdown.tsx, #4062): its file links open on the machine, and nothing in its text is looked up in a folder on this Mac: no image from a local path, no skill, no repository, no visualization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, callsTo, impl, moduleCalls } from './support/thread-kit.ts';
import { useFakeNative } from './support/ports/native.ts';
import { RemoteFolderContext, parseRemoteCwd, remoteCwd } from '../src/lib/remoteFolder.ts';
import { createHostFs } from '../host/src/hostFs.mjs';
import { createHostFiles } from '../host/src/hostFiles.mjs';

mockStore();
const { openMessageLink } = await import('../src/session/open.ts');
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
autoMock('src/components/panels/DiffPanel.tsx', 'diff', { LangIcon: stubComponent('LangIcon') });
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { RemoteFilePreview } = await import('../src/components/panels/files/RemoteFiles.tsx');
const AT = remoteCwd('m', '/srv/app');
const text =
  '[a](src/a.ts) ![pic](/srv/app/pic.png) ![web](https://example.com/p.png) `/srv/app/SKILL.md` [skill](/srv/app/SKILL.md) `src/a.ts` :codex-file-citation{path="docs/c.md" page_number="2"} :codex-file-citation{path="~/n.md"} \uE200visualize\uE202{"path":"out/c.html"}\uE201';

test('sandbox artifact destinations become clickable file paths and image sources, without admitting other schemes', async () => {
  moduleCalls.length = 0;
  const v = await render(
    h(Markdown, {
      cwd: '/repo',
      text:
        '[Screenshot](sandbox:/repo/shot%20%231.png) ![Inline](sandbox:/repo/shot%20%231.png) ' +
        '[Remote authority](sandbox://host/shot.png) [Relative](sandbox:shot.png) [Script](javascript:alert%281%29)',
    }),
  );
  const [file, authority, relative, script] = v.$$('a');
  assert.equal(file.getAttribute('href'), '/repo/shot%20%231.png');
  await settle(() => file.click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['/repo/shot%20%231.png', '/repo']);
  assert.equal(v.$('[data-stub="ZoomableImage"]')?.dataset.src, 'codex-asset:///repo/shot%20%231.png');
  for (const link of [authority, relative, script]) {
    assert.ok(!link.getAttribute('href'));
    await settle(() => link.click());
  }
  assert.equal(callsTo('open:openMessageLink').length, 1);
  await v.unmount();
});

test('links in a chat on a machine open on the machine, and a local image, skill and visualization are not drawn from this Mac', async () => {
  resetStore({});
  const v = await render(
    h(RemoteFolderContext.Provider, { value: { machineId: 'm', folder: '/srv/app' } }, h(Markdown, { text, cwd: '/srv/app' })),
  );
  await settle(() =>
    v
      .$$('a')
      .find((a) => a.textContent === 'a')!
      .click(),
  );
  assert.deepEqual(callsTo('open:openMessageLink').at(-1)?.slice(0, 2), ['src/a.ts', AT]);
  assert.deepEqual(
    v.$$('[data-stub="ZoomableImage"]').map((i) => i.getAttribute('data-props') ?? i.outerHTML).length,
    1,
    'only the web image is drawn',
  );
  assert.equal(v.$('[data-stub="SkillLink"]'), null, 'no skill is read from this Mac');
  assert.equal(v.$('[data-stub="Visualization"]'), null, 'a visualization is a file on this Mac');
  // inline code naming a path stays plain code: it was not checked on the machine
  assert.equal(
    v.$$('code.inline-code').some((c) => c.textContent === 'src/a.ts'),
    true,
  );
  // a cited file opens from the machine's folder
  const chips = v.$$('.md-file-chip');
  assert.equal(chips[0].getAttribute('href'), '/srv/app/docs/c.md');
  assert.equal(chips[1].getAttribute('href'), '~/n.md', 'a path that cannot be said on the machine stays as written');
  await settle(() => chips[0].click());
  assert.deepEqual(callsTo('open:openMessageLink').at(-1)?.slice(0, 2), ['/srv/app/docs/c.md', AT]);
  await v.unmount();
});

test('the same text on this Mac keeps its own folder: links, images and skills resolve here', async () => {
  resetStore({});
  const v = await render(h(Markdown, { text: '[a](src/a.ts) ![pic](/srv/app/pic.png)', cwd: '/repo' }));
  await settle(() =>
    v
      .$$('a')
      .find((a) => a.textContent === 'a')!
      .click(),
  );
  assert.deepEqual(callsTo('open:openMessageLink').at(-1)?.slice(0, 2), ['src/a.ts', '/repo']);
  assert.equal(v.$$('[data-stub="ZoomableImage"]').length, 1);
  await v.unmount();
});

test('a Markdown result link reads and previews the cited file on the Host', async (t) => {
  resetStore({});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'mopilot%2f03a201f8');
  const file = path.join(folder, 'host.md');
  await fs.mkdir(folder);
  await fs.writeFile(file, '# Remote result\nRead from the Host\n');
  const reader = createHostFiles({ hostFs: createHostFs({ roots: [root] }) });
  let pending: Promise<unknown> | undefined;
  const bridge = useFakeNative(t, {
    host: {
      fsRead: (_id: string, request: { path: string }) =>
        (pending = reader.read(request).then(
          (value) => ({ value }),
          ({ code, message }) => ({ error: { code, message } }),
        )),
    },
  });
  impl['open:openMessageLink'] = openMessageLink;
  t.after(() => {
    delete impl['open:openMessageLink'];
  });

  const chat = await render(
    h(
      RemoteFolderContext.Provider,
      { value: { machineId: 'ssh:box', folder } },
      h(Markdown, {
        text: `[Remote result](sandbox:${file}:2) ![Do not load locally](sandbox:${folder}/shot.png)`,
        cwd: folder,
      }),
    ),
  );
  await settle(() => chat.$('a')!.click());
  assert.equal(chat.$('[data-stub="ZoomableImage"]'), null);
  const [kind, target] = callsTo('store:openPaneTab').at(-1)!;
  assert.equal(kind, 'file');
  const machine = parseRemoteCwd(target.cwd)!;
  const preview = await render(h(RemoteFilePreview, { machineId: machine.machineId, path: target.path, line: target.line }));
  await settle(() => pending);
  assert.equal(preview.$('.remote-file-hit')?.textContent, 'Read from the Host');
  assert.deepEqual(bridge.callsTo('host.fsRead'), [['ssh:box', { path: file }]]);
  assert.deepEqual(bridge.callsTo('fs.messagePath'), []);
  await preview.unmount();
  await chat.unmount();
});
