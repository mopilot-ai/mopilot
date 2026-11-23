// The route on the model pill: "⇄ magpie" beside the model while the harness's own config sends its requests somewhere else, with the sentence that says so as its tooltip.
import { routeSentence, useHarnessRoute } from '../../harness/routes';

/** Hidden while the chat runs on a provider MoPilot chose (MoPilot credits, a custom endpoint): that provider is the route. */
export function RouteMark({ harness, label, hidden = false }: { harness: string; label: string; hidden?: boolean }) {
  const r = useHarnessRoute(harness);
  if (hidden || r?.kind !== 'external') return null;
  const text = routeSentence(r, label);
  return (
    <span className="route-mark" title={text} aria-label={text}>
      <span aria-hidden="true">⇄ </span>
      {r.label ?? 'custom model'}
    </span>
  );
}
