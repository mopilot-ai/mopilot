// Phone-side seam for the desktop momo.* methods: the shapes the MoMo tab reads, each checked before it reaches a screen.
import type { RemoteMessage } from '../../../shared/remote/transport.mjs';

export type Fact = { id: string; text: string; expired?: boolean };
/** MoMo's brain as its chip shows it: the model's name and, when MoMo runs it at one, the effort (absent: the model's default). */
export type Brain = { label: string; effort?: string };
export type Docs = { aboutYou: string; persona: string; unreadable: string[] };
export type Proposal = { id: string; name: string; prompt: string; schedule: string; sources: string; rev: number };
/** `prompt` is what an approved routine does, from a Mac that lists it. */
export type Routine = { id: string; name: string; schedule: string; paused: boolean; prompt?: string };
export type Routines = { proposals: Proposal[]; routines: Routine[] };
export type MomoTopic = 'memory' | 'routines' | 'brain' | 'sources' | 'prefs' | 'chat';
export type Sources = { calendar: boolean; reminders: boolean };

const unreadable = (what: string) => new Error(`Could not read ${what}.`);
const obj = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable(what);
  return value as Record<string, unknown>;
};
const list = (value: unknown, what: string, ok: (item: Record<string, unknown>) => boolean): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw unreadable(what);
  const items = value.map((item) => obj(item, what));
  if (!items.every(ok)) throw unreadable(what);
  return items;
};
const str = (v: unknown) => typeof v === 'string';

/** Whether machine.hello says MoMo is allowed for this account; anything else means no MoMo tab. */
export const momoAllowed = (hello: unknown): boolean =>
  !!hello && typeof hello === 'object' && (hello as { capabilities?: { momo?: unknown } }).capabilities?.momo === true;

/** Whether the Mac lets this phone change MoMo's brain (MoMo allowed and the Mac's own setting on). */
export const momoBrainSet = (hello: unknown): boolean =>
  momoAllowed(hello) && (hello as { capabilities: { momoBrainSet?: unknown } }).capabilities.momoBrainSet === true;

/** The brain the user chose, by the model's name; null when none is chosen or it has no model name (a basic harness). */
export function parseBrain(value: unknown): Brain | null {
  const v = obj(value, 'the brain');
  if (v.brain == null) return null;
  const brain = obj(v.brain, 'the brain');
  const label = [brain.modelLabel, brain.model].find((name) => str(name) && name);
  if (!label) return null;
  return { label: label as string, ...(str(brain.effort) && brain.effort ? { effort: brain.effort as string } : {}) };
}

export function parseFacts(value: unknown): Fact[] {
  const v = obj(value, 'memory');
  const now = typeof v.now === 'number' ? v.now : Date.now();
  const facts = list(v.facts, 'memory', (f) => str(f.id) && str(f.text));
  return facts.map((f) => ({ id: f.id as string, text: f.text as string, expired: typeof f.expiresAt === 'number' && f.expiresAt <= now }));
}

export function parseDocs(value: unknown): Docs {
  const v = obj(value, 'memory');
  if (!str(v.aboutYou) || !str(v.persona)) throw unreadable('memory');
  const bad = Array.isArray(v.unreadable) ? v.unreadable.filter(str) : [];
  return { aboutYou: v.aboutYou as string, persona: v.persona as string, unreadable: bad as string[] };
}

/** Whether Calendar and Reminders are connected on the Mac. */
export function parseSources(value: unknown): Sources {
  const v = obj(value, 'sources');
  if (typeof v.calendar !== 'boolean' || typeof v.reminders !== 'boolean') throw unreadable('sources');
  return { calendar: v.calendar, reminders: v.reminders };
}

export function parseRoutines(value: unknown): Routines {
  const v = obj(value, 'routines');
  const proposals = list(
    v.proposals,
    'routines',
    (p) => str(p.id) && str(p.name) && str(p.prompt) && str(p.schedule) && Number.isSafeInteger(p.rev),
  );
  const routines = list(v.routines, 'routines', (r) => str(r.id) && str(r.name) && str(r.schedule));
  return {
    proposals: proposals.map((p) => ({
      id: p.id as string,
      name: p.name as string,
      prompt: p.prompt as string,
      schedule: p.schedule as string,
      sources: str(p.sources) ? (p.sources as string) : '',
      rev: p.rev as number,
    })),
    routines: routines.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      schedule: r.schedule as string,
      paused: r.paused === true,
      ...(str(r.prompt) ? { prompt: r.prompt as string } : {}),
    })),
  };
}

/** The topic of a momo.changed event (the Mac tells windows and phones alike that something changed, with no data), else null. */
export function changedTopic(event: RemoteMessage): MomoTopic | null {
  if (event.ev !== 'momo.changed') return null;
  const topic = (event as { area?: unknown }).area;
  return topic === 'memory' || topic === 'routines' || topic === 'brain' || topic === 'sources' || topic === 'prefs' || topic === 'chat'
    ? topic
    : null;
}
