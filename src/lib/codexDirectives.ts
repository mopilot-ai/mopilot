// Inline Codex directives in answers: the parsing and stripping are shared with main (shared/codexDirectives.mjs); the
// link sanitizing is react-markdown's, here.
import { defaultUrlTransform } from 'react-markdown';
import { SCHEME } from '../../shared/codexDirectives.mjs';

export { parseDirectives, directiveFromHref, stripDirectives, type Directive } from '../../shared/codexDirectives.mjs';

/** react-markdown's default URL sanitizing, letting our directive links through. */
export const urlTransform = (url: string) => (url.startsWith(SCHEME) ? url : defaultUrlTransform(url));
