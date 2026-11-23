// Shared mount for the question card's tests (tests/questionCardUI.test.ts, tests/questionCardFlowUI.test.ts): renders a
// QuestionCard with its answers recorded, and the clicks, keys and typing the tests drive it with.
import { window } from './dom.ts';
import { iconStubs, mockSource } from './stubs.ts';

mockSource('src/components/ui/icons.tsx', iconStubs());
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
export const { QuestionCard, draftAnswers } = await import('../../src/components/thread/QuestionCard.tsx');
export { createElement, act, createRoot, window };

export const options = [
  { label: 'First', description: 'One option' },
  { label: 'Second', description: 'Another option' },
];
export const question = { id: 'q', header: 'View', question: 'Which view?', options, isOther: true };

export async function mount(questions = [question] as any[], id = 'request', props: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const replies: any[][] = [];
  const render = (extra: Record<string, unknown> = {}) =>
    act(() =>
      root.render(
        createElement(QuestionCard, {
          req: { id, params: { questions } },
          agent: 'Codex',
          onAnswer: (...args: any[]) => replies.push(args),
          ...props,
          ...extra,
        }),
      ),
    );
  await render();
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;
  const tiles = () => [...host.querySelectorAll('.question-option:not(.question-other)')] as HTMLButtonElement[];
  const click = (el: Element | null) => act(() => (el as HTMLElement).click());
  const key = async (value: string, target: any = window, init = {}) =>
    act(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })));
  const field = () => host.querySelector('.question-other-input') as HTMLTextAreaElement | HTMLInputElement;
  const input = async (value: string) => {
    const el: any = field();
    const prototype = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(() => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  return {
    host,
    replies,
    button,
    tiles,
    click,
    key,
    field,
    input,
    render,
    title: () => host.querySelector('.question-title')?.textContent,
    dispose: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
export const one = (id: string, answers: string[]) => ({ answers: { [id]: { answers } } });
