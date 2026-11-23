// Mounts the real composer for list-document and keyboard regression tests.
import { mock } from 'node:test';
import { window } from './dom.ts';
import type { Attachment } from '../../src/store/types.ts';

mock.module('../../src/components/markdown/SkillLink.tsx', { namedExports: { openSkill() {} } });
mock.module('../../src/session/open.ts', { namedExports: { openPath() {} } });
const { createElement, createRef, act } = await import('react');
export { act };
const { createRoot } = await import('react-dom/client');
const { ComposerInput } = await import('../../src/components/composer/ComposerInput.tsx');

export async function mount(value = '', initial: Attachment[] = [], extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const ref = createRef<any>();
  let text = value;
  let attachments = initial;
  const render = () =>
    root.render(
      createElement(ComposerInput, {
        ref,
        value: text,
        attachments,
        disabled: false,
        hidden: false,
        placeholder: 'Message',
        onKeyDown() {},
        onPaste() {},
        onSelect() {},
        ...extra,
        onChange(value, nextAttachments) {
          text = value;
          attachments = nextAttachments;
          render();
        },
      }),
    );
  await act(render);
  return {
    el: ref.current,
    get text() {
      return text;
    },
    get attachments() {
      return attachments;
    },
    async update(value: string) {
      text = value;
      await act(render);
    },
    async input() {
      await act(() => ref.current.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })));
    },
    async close() {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
