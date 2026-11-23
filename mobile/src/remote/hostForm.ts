// A question an agent asks on a machine, as the Host's form card carries it, drawn by the thread's own question card and answered as the form the Host asked (shared/acpForm.mjs): the Host checks the values against its form and declines what does not fit.
type Option = { value: string; label: string; description?: string | null };
type Field = {
  key: string;
  type: 'string' | 'array' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string | null;
  required?: boolean;
  options?: Option[] | null;
};
type Form = { fields: Field[] };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The fields of a form card, or null when the card carries none the phone can read. */
export function formOf(raw: unknown): Form | null {
  if (!record(raw) || !Array.isArray(raw.fields)) return null;
  const fields = raw.fields.filter((f): f is Field => record(f) && typeof f.key === 'string' && typeof f.type === 'string');
  return fields.length ? { fields } : null;
}

/** What the card's choices are: Send answers the form with the values, Skip cancels it. */
export const FORM_CHOICES = [
  { key: 'submit', label: 'Send' },
  { key: 'cancel', label: 'Skip', deny: true },
];

/**
 * The thread's question card for a form: a field with options is a question (one pick, or several for a list), the others are the plain fields
 * of a schema (text, number, yes or no).
 */
export function formCard(form: Form) {
  const questions: { id: string; question: string; header?: string; options: { label: string }[]; multiSelect: boolean; isOther: false }[] =
    [];
  const properties: Record<string, { title: string; description?: string; type: string }> = {};
  for (const f of form.fields) {
    const title = f.title || f.key;
    if (f.options?.length)
      questions.push({
        id: f.key,
        question: f.description ? `${title}: ${f.description}` : title,
        options: f.options.map((o) => ({ label: o.label })),
        multiSelect: f.type === 'array',
        isOther: false,
      });
    else
      properties[f.key] = {
        title,
        ...(f.description ? { description: f.description } : {}),
        type: f.type === 'boolean' ? 'boolean' : f.type === 'string' ? 'string' : 'number',
      };
  }
  return { ...(questions.length ? { questions } : {}), ...(Object.keys(properties).length ? { schema: { properties } } : {}) };
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const yes = /^(?:true|yes)$/i;
const no = /^(?:false|no)$/i;

/**
 * The values the person gave (the thread's own: picks as lists of labels, text, numbers, yes or no) as the form's content: a label becomes the
 * option's value, a single value is one value and a list stays a list. A value left empty is left out, so the Host says what is missing.
 */
export function formContent(form: Form, values: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const f of form.fields) {
    const given = values[f.key];
    if (given === undefined || given === null || given === '' || (Array.isArray(given) && !given.length)) continue;
    const valueOf = (x: unknown) => f.options?.find((o) => o.label === x)?.value ?? x;
    if (f.type === 'array') content[f.key] = (Array.isArray(given) ? given : [given]).map(valueOf);
    else if (f.type === 'boolean') {
      const v = first(given);
      content[f.key] =
        v === true || (typeof v === 'string' && yes.test(v)) ? true : v === false || (typeof v === 'string' && no.test(v)) ? false : v;
    } else if (f.type === 'number' || f.type === 'integer') content[f.key] = Number(first(given));
    else content[f.key] = valueOf(first(given));
  }
  return content;
}
