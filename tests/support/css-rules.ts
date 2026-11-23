// Read final root declarations and serialized keyframes from a parsed stylesheet in CSS contract tests.
import type { Root } from 'postcss';

export function cssRules(css: Root) {
  function decls(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    css.walkRules((r) => {
      if (r.selectors.includes(selector) && r.parent?.type === 'root') r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  }

  function keyframes(name: string): string {
    let out = '';
    css.walkAtRules('keyframes', (a) => {
      if (a.params !== name) return;
      a.walkRules((r) => {
        const d: string[] = [];
        r.walkDecls((x) => void d.push(`${x.prop}:${x.value}`));
        out += `${r.selector}{${d.join(';')}}`;
      });
    });
    return out;
  }
  return { decls, keyframes };
}
