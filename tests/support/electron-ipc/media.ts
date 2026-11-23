// Electron IPC media unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withPlatform, tornWrites, calls, ready } from './fixture';

export function registerRecordingsCases() {
  for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
    test(`recordings list reports ${code} instead of inventing an empty history`, async (t) => {
      const h = await ready();
      const dir = path.join(h.userData, 'recordings');
      const original = fs.promises.readdir;
      t.mock.method(fs.promises, 'readdir', async (file: any, ...args: any[]) => {
        if (String(file) === dir) throw Object.assign(new Error(`cannot read recordings: ${code}`), { code });
        return (original as any)(file, ...args);
      });
      await assert.rejects(async () => h.invoke('recordings:list'), { code });
    });
  }

  test('an inaccessible recording metadata file is a read failure, not an empty history', async (t) => {
    const h = await ready();
    await h.invoke('recordings:save', new Uint8Array([1]), 'saved');
    const dir = path.join(h.userData, 'recordings');
    const original = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', async (file: any, ...args: any[]) => {
      if (String(file).startsWith(dir + path.sep) && String(file).endsWith('.json'))
        throw Object.assign(new Error('metadata permission denied'), { code: 'EACCES' });
      return (original as any)(file, ...args);
    });
    await assert.rejects(async () => h.invoke('recordings:list'), { code: 'EACCES' });
  });

  test('metadata removed between listing and reading hides only that entry', async (t) => {
    const h = await ready();
    await h.invoke('recordings:save', new Uint8Array([1]), 'removed entry');
    await h.invoke('recordings:save', new Uint8Array([2]), 'kept entry');
    const dir = path.join(h.userData, 'recordings');
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const removed = path.join(dir, files[0]);
    const original = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', async (file: any, ...args: any[]) => {
      if (String(file) === removed) throw Object.assign(new Error('metadata removed'), { code: 'ENOENT' });
      return (original as any)(file, ...args);
    });
    const list = await h.invoke('recordings:list');
    assert.equal(list.length, 1);
    assert.equal(list[0].text, 'kept entry');
  });

  test('a denied clip is not mistaken for a missing clip by an existence probe', async (t) => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'denied.webm');
    fs.writeFileSync(file, new Uint8Array([1]));
    const exists = fs.existsSync;
    const read = fs.promises.readFile;
    t.mock.method(fs, 'existsSync', (target: any) => (String(target) === file ? false : exists(target)));
    t.mock.method(fs.promises, 'readFile', async (target: any, ...args: any[]) => {
      if (String(target) === file) throw Object.assign(new Error('clip permission denied'), { code: 'EACCES' });
      return (read as any)(target, ...args);
    });
    await assert.rejects(async () => h.invoke('recordings:read', 'denied'), { code: 'EACCES' });
  });

  test('a clip removed before its read is an ordinary missing clip', async (t) => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'removed.webm');
    fs.writeFileSync(file, new Uint8Array([1]));
    const read = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', async (target: any, ...args: any[]) => {
      if (String(target) === file) throw Object.assign(new Error('clip removed'), { code: 'ENOENT' });
      return (read as any)(target, ...args);
    });
    assert.equal(await h.invoke('recordings:read', 'removed'), null);
  });

  test('recordings: saved, listed newest first, read back, trimmed to 20, cleared', async () => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    assert.deepEqual(await h.invoke('recordings:list'), []);
    let t = 1000;
    const now = mock.method(Date, 'now', () => ++t);
    try {
      for (let i = 0; i < 22; i++) await h.invoke('recordings:save', new Uint8Array([i]), `text ${i}`);
    } finally {
      now.mock.restore();
    }
    const list = await h.invoke('recordings:list');
    assert.equal(list.length, 20);
    assert.deepEqual(list[0], { id: '1022', text: 'text 21', at: 1022 });
    assert.equal(fs.existsSync(path.join(dir, '1001.webm')), false, 'the oldest are removed');
    assert.equal(await h.invoke('recordings:read', '1022'), 'data:audio/webm;base64,FQ==');
    assert.equal(await h.invoke('recordings:read', '../../1022'), 'data:audio/webm;base64,FQ==', 'only a name');
    assert.equal(await h.invoke('recordings:read', 'nope'), null);
    await h.invoke('recordings:clear');
    assert.equal(fs.existsSync(dir), false);
  });
}

export function registerDictationCases() {
  test('dictation: engines get their credentials; the local helper only on macOS', async () => {
    const h = await ready();
    const dict = h.mod('platform/voice.cjs').createDictation.mock.calls[0].result;
    const o = dict.opts;
    assert.equal(o.apiBase, 'https://api.example');
    const acc = h.one('Accounts');
    acc.chatgptHeaders = () => ({ h: 1 });
    assert.deepEqual(o.chatgptHeaders(), { h: 1 });
    assert.equal(o.gatewayKey(), 'gw-key');
    h.one('MoPilotAccount').gatewayKey = () => undefined;
    assert.equal(o.gatewayKey(), null);
    assert.equal(o.helper(), h.inst.computerUse[0].helper);
    // every transcribe path reads the app-wide dictation switch
    assert.equal(o.enabled(), true);
    await o.fetch('https://u', { i: 1 });
    assert.deepEqual(calls(h.electron.net.fetch).at(-1), ['https://u', { i: 1 }]);
    // windows transcribe through speech:transcribe (ipc/speech.cjs), the side panel through main; nothing else does
    assert.equal(h.handlers.has('dictation:transcribe'), false);
    assert.equal(h.handlers.has('dictation:micStatus'), false);
    const helper = h.inst.computerUse[0].helper;
    // the local helper is a Mac's, whatever host the tests run on
    assert.equal(await withPlatform('darwin', () => h.invoke('dictation:localStatus', 'en')), 'status');
    assert.deepEqual(calls(helper.speechStatus), [['en']]);
    assert.equal(await withPlatform('win32', () => h.invoke('dictation:localStatus', 'en')), null);
    const request = () => withPlatform('darwin', () => h.invoke('dictation:localRequest', 'en'));
    assert.equal(await request(), 'req');
    helper.start = async () => {
      throw new Error('no helper');
    };
    assert.equal(await withPlatform('darwin', () => h.invoke('dictation:localStatus', 'en')), null);
    // off macOS, and a helper that can't start for no named reason: null, as before
    assert.equal(await withPlatform('win32', () => h.invoke('dictation:localRequest', 'en')), null);
    assert.equal(await request(), null);
    // a helper ended mid-request is named (macOS aborts it when a purpose string is missing, #5340); an outdated one says its fix
    helper.start = async () => {
      throw Object.assign(new Error('x'), { reason: 'helper_restarted' });
    };
    assert.match((await request()).failure, /helper stopped while asking for Speech Recognition/);
    helper.start = async () => {
      throw Object.assign(new Error('The helper is out of date: update MoPilot'), { reason: 'helper_outdated' });
    };
    assert.deepEqual(await request(), { failure: 'The helper is out of date: update MoPilot' });
  });
}

export function registerRecordingRecoveryCases() {
  for (const [prefix, suffix] of [
    ['', '.extra'],
    ['+', ''],
    [' ', ''],
  ]) {
    test(`saving after twenty large legacy recording IDs ${JSON.stringify([prefix, suffix])} retains the new clip`, async (t) => {
      const h = await ready();
      const dir = path.join(h.userData, 'recordings');
      fs.mkdirSync(dir, { recursive: true });
      const base = 9007199254740992n;
      for (let i = 0; i < 20; i++) {
        const id = prefix + String(base + BigInt(i)) + suffix;
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ text: `legacy ${i}`, at: i }));
        fs.writeFileSync(path.join(dir, `${id}.webm`), Buffer.from([i]));
      }
      t.mock.method(Date, 'now', () => 5000);
      await h.invoke('recordings:save', new Uint8Array([99]), 'newest');
      const list = await h.invoke('recordings:list');
      assert.equal(list.length, 20);
      assert.equal(list[0].text, 'newest');
      assert.equal(list[0].id, String(base + 20n));
      assert.equal(await h.invoke('recordings:read', list[0].id), 'data:audio/webm;base64,Yw==');
      assert.deepEqual(
        list.slice(1).map((entry: any) => entry.text),
        Array.from({ length: 19 }, (_, i) => `legacy ${19 - i}`),
      );
    });
  }

  test('legacy numeric prefixes and nonnumeric recording names have a stable order', async () => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ['-1', 'notes', '0002', '2.extra', '+3', ' 4'])
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ text: id, at: 1 }));
    const list = await h.invoke('recordings:list');
    assert.deepEqual(
      list.slice(0, 2).map((entry: any) => entry.id),
      [' 4', '+3'],
    );
    assert.deepEqual(new Set(list.slice(2, 4).map((entry: any) => entry.id)), new Set(['2.extra', '0002']));
    assert.deepEqual(
      list.slice(4).map((entry: any) => entry.id),
      ['notes', '-1'],
    );
  });

  for (const existing of ['9007199254740992', '1' + '0'.repeat(100)]) {
    test(`recording allocation preserves exact successors of ${existing.length}-digit IDs`, async (t) => {
      const h = await ready();
      const dir = path.join(h.userData, 'recordings');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${existing}.json`), JSON.stringify({ text: 'original', at: 1 }));
      fs.writeFileSync(path.join(dir, `${existing}.webm`), Buffer.from([42]));
      t.mock.method(Date, 'now', () => 5000);
      await h.invoke('recordings:save', new Uint8Array([1]), 'first successor');
      await h.invoke('recordings:save', new Uint8Array([2]), 'second successor');
      const first = (BigInt(existing) + 1n).toString();
      const second = (BigInt(existing) + 2n).toString();
      assert.equal(await h.invoke('recordings:read', existing), 'data:audio/webm;base64,Kg==');
      assert.deepEqual(
        (await h.invoke('recordings:list')).map((entry: any) => entry.id),
        [second, first, existing],
      );
      assert.equal(await h.invoke('recordings:read', first), 'data:audio/webm;base64,AQ==');
      assert.equal(await h.invoke('recordings:read', second), 'data:audio/webm;base64,Ag==');
    });
  }

  test('recording list and retention compare large IDs exactly regardless of directory order', async (t) => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const base = 9007199254740992n;
    for (let i = 0; i < 20; i++) {
      const id = String(base + BigInt(i));
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ text: `clip ${i}`, at: i }));
      fs.writeFileSync(path.join(dir, `${id}.webm`), Buffer.from([i]));
    }
    const readDir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (file: any, ...args: any[]) => {
      const names = await (readDir as any)(file, ...args);
      return String(file) === dir ? names.sort().reverse() : names;
    });
    assert.deepEqual(
      (await h.invoke('recordings:list')).map((entry: any) => entry.text),
      Array.from({ length: 20 }, (_, i) => `clip ${19 - i}`),
    );
    t.mock.method(Date, 'now', () => 5000);
    await h.invoke('recordings:save', new Uint8Array([99]), 'newest');
    assert.equal(fs.existsSync(path.join(dir, `${base}.webm`)), false, 'retention removes the exact oldest clip');
    const list = await h.invoke('recordings:list');
    assert.equal(list.length, 20);
    assert.deepEqual(
      list.map((entry: any) => entry.text),
      ['newest', ...Array.from({ length: 19 }, (_, i) => `clip ${19 - i}`)],
    );
  });

  test('recording identity strips only the terminal metadata extension', async () => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json.old.json'), JSON.stringify({ text: 'legacy name', at: 1 }));
    fs.writeFileSync(path.join(dir, '1.json.old.webm'), Buffer.from([1]));
    fs.writeFileSync(path.join(dir, '1.old.json.webm'), Buffer.from([2]));
    const [entry] = await h.invoke('recordings:list');
    assert.equal(entry.id, '1.json.old');
    assert.equal(await h.invoke('recordings:read', entry.id), 'data:audio/webm;base64,AQ==');
  });

  test('retention removes only the paired clip when a legacy name contains .json', async (t) => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 19; i++) {
      const id = i === 1 ? '1.json.old' : String(i);
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ text: `clip ${i}`, at: i }));
      fs.writeFileSync(path.join(dir, `${id}.webm`), Buffer.from([i]));
    }
    const decoy = path.join(dir, '1.webm.old.json');
    fs.writeFileSync(decoy, 'unrelated malformed metadata');
    const readDir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (file: any, ...args: any[]) => {
      const names = await (readDir as any)(file, ...args);
      return String(file) === dir ? names.sort() : names;
    });
    t.mock.method(Date, 'now', () => 9000);
    await h.invoke('recordings:save', new Uint8Array([99]), 'new');
    assert.equal(fs.existsSync(path.join(dir, '1.json.old.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '1.json.old.webm')), false, 'the actual paired audio is removed');
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'unrelated malformed metadata', 'a non-paired file is preserved');
  });

  test('recording metadata cannot override the filename identity or select another clip', async () => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ id: '2', text: 'first clip', at: 1, extra: 'legacy field' }));
    fs.writeFileSync(path.join(dir, '1.webm'), Buffer.from([1]));
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ text: 'second clip', at: 2 }));
    fs.writeFileSync(path.join(dir, '2.webm'), Buffer.from([2]));
    const list = await h.invoke('recordings:list');
    assert.deepEqual(list, [
      { id: '2', text: 'second clip', at: 2 },
      { id: '1', text: 'first clip', at: 1 },
    ]);
    assert.equal(await h.invoke('recordings:read', list[1].id), 'data:audio/webm;base64,AQ==');
  });

  for (const entry of [
    [],
    {},
    { text: {}, at: 1 },
    { text: ['bad'], at: 1 },
    { text: null, at: 1 },
    { text: 3, at: 1 },
    { text: 'bad' },
    { text: 'bad', at: null },
    { text: 'bad', at: '1' },
    { text: 'bad', at: {} },
    { text: 'bad', at: 1e100 },
  ]) {
    test(`malformed recording metadata is skipped without hiding a healthy sibling: ${JSON.stringify(entry)}`, async () => {
      const h = await ready();
      const dir = path.join(h.userData, 'recordings');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(entry));
      fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ text: '', at: 0 }));
      assert.deepEqual(await h.invoke('recordings:list'), [{ id: '2', text: '', at: 0 }]);
    });
  }

  test('recording timestamps must stay finite after JSON numeric parsing', async () => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), '{"text":"bad","at":1e1000}');
    assert.deepEqual(await h.invoke('recordings:list'), []);
  });

  for (const text of [null, {}, [], 42]) {
    test(`recording save refuses invalid text before writing files: ${JSON.stringify(text)}`, async () => {
      const h = await ready();
      await assert.rejects(async () => h.invoke('recordings:save', new Uint8Array([1]), text), /recording text.*string/i);
      assert.equal(fs.existsSync(path.join(h.userData, 'recordings')), false);
    });
  }

  for (const at of [5000, 99])
    test(`recordings saved in one clock tick ${at} retain distinct audio and the latest twenty clips`, async (t) => {
      const h = await ready();
      t.mock.method(Date, 'now', () => at);
      for (let i = 0; i < 22; i++) await h.invoke('recordings:save', new Uint8Array([i]), `same tick ${i}`);
      const list = await h.invoke('recordings:list');
      assert.equal(list.length, 20);
      assert.equal(new Set(list.map((recording: any) => recording.id)).size, 20);
      assert.deepEqual(
        list.map((recording: any) => recording.text),
        Array.from({ length: 20 }, (_, i) => `same tick ${21 - i}`),
      );
      for (const recording of list) {
        const value = Number(recording.text.split(' ').at(-1));
        assert.equal(recording.at, at);
        assert.equal(await h.invoke('recordings:read', recording.id), `data:audio/webm;base64,${Buffer.from([value]).toString('base64')}`);
      }
    });

  test('recordings: an unreadable entry hides only itself, and a save cut off halfway leaves no entry', async (t) => {
    const h = await ready();
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), '{"text":"half');
    fs.writeFileSync(path.join(dir, '2.json'), 'null');
    fs.writeFileSync(path.join(dir, '3.json'), '5');
    fs.writeFileSync(path.join(dir, '4.json'), JSON.stringify({ text: 'kept', at: 4 }));
    fs.writeFileSync(path.join(dir, '4.webm'), Buffer.from([4]));
    assert.deepEqual(await h.invoke('recordings:list'), [{ id: '4', text: 'kept', at: 4 }]);
    t.mock.method(Date, 'now', () => 9000);
    const restore = tornWrites(dir);
    try {
      await assert.rejects(async () => h.invoke('recordings:save', new Uint8Array([1, 2, 3, 4]), 'cut off'), /ENOSPC/);
    } finally {
      restore();
    }
    assert.deepEqual(await h.invoke('recordings:list'), [{ id: '4', text: 'kept', at: 4 }]);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('9000')),
      [],
      'neither half a clip nor a temporary file is left',
    );
  });

  test('saving a recording preserves an existing audio file without its metadata', async (t) => {
    const h = await ready();
    t.mock.method(Date, 'now', () => 6000);
    const dir = path.join(h.userData, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '6000.webm'), Buffer.from([42]));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a recording');
    await h.invoke('recordings:save', new Uint8Array([99]), 'new clip');
    const list = await h.invoke('recordings:list');
    assert.equal(list.length, 1);
    assert.notEqual(list[0].id, '6000');
    assert.equal(await h.invoke('recordings:read', '6000'), 'data:audio/webm;base64,Kg==');
    assert.equal(await h.invoke('recordings:read', list[0].id), 'data:audio/webm;base64,Yw==');
  });

  test('recording save order survives a backward clock adjustment', async (t) => {
    const h = await ready();
    let now = 7000;
    t.mock.method(Date, 'now', () => now);
    await h.invoke('recordings:save', new Uint8Array([1]), 'before clock change');
    now = 6000;
    await h.invoke('recordings:save', new Uint8Array([2]), 'after clock change');
    const list = await h.invoke('recordings:list');
    assert.deepEqual(
      list.map((recording: any) => recording.text),
      ['after clock change', 'before clock change'],
    );
    assert.deepEqual(
      list.map((recording: any) => recording.at),
      [6000, 7000],
    );
  });
}
