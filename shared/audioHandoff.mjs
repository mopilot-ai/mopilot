// Audio history stays explicit in bounded handoff context without pretending references are transcripts or replaying tasks.
const MAX_REFERENCES = 20;

/** Model-facing references retain the original request's media when a text handoff cannot carry audio bytes. */
export function audioInputLines(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === 'localAudio')
    .map((c) => {
      const path = typeof c.path === 'string' && c.path ? JSON.stringify(c.path) : '(recording unavailable)';
      return `[Audio message: ${path}; not transcribed in this handoff]`;
    });
}

/** Keep references outside summaries and transcript trimming; old omitted recordings remain in the source history. */
export function audioHandoffText(turns) {
  const references = [
    ...new Set(turns.flatMap((t) => (t.items ?? []).flatMap((i) => (i.type === 'userMessage' ? audioInputLines(i.content) : [])))),
  ];
  if (!references.length) return '';
  return [
    '## Audio references',
    'These references are not transcripts or new audio submissions. Keep prior task outcomes; do not repeat audio tasks. If the recorded content is unavailable in your current session, ask the user to use Dictate or attach the recording to an audio-capable agent before relying on its contents.',
    ...references.slice(-MAX_REFERENCES),
    ...(references.length > MAX_REFERENCES
      ? [`${references.length - MAX_REFERENCES} older audio references remain in the source conversation.`]
      : []),
  ].join('\n');
}
