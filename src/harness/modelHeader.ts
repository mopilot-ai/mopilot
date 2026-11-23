// The model picker's header line: "harness · provider · model". The provider level only shows when the
// chat is served by someone other than the harness's own vendor (MoPilot, a gateway); with one provider
// there is nothing to choose, so it stays out.

export function modelHeader(o: { harness: string; provider?: { label: string; firstParty?: boolean } | null; model: string }): string {
  const provider = o.provider && !o.provider.firstParty ? o.provider.label : null;
  return [o.harness, provider, o.model].filter(Boolean).join(' · ');
}
