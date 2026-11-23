// What a phone UI source file shows a person without going through the catalog: JSX text, and string literals given as a child or to a text-bearing prop (read from the syntax tree, so types, arrow returns and comparisons are never mistaken for text).
import ts from '../../../mobile/node_modules/typescript/lib/typescript.js';

/** The props whose string is read aloud or drawn. */
const SHOWN_PROPS = new Set(['accessibilityLabel', 'accessibilityHint', 'placeholder', 'title', 'label', 'alt', 'aria-label']);
const HAS_LETTERS = /[A-Za-z一-鿿]/;

/** The literal words an expression can show: a string, a template's fixed parts, and each branch of a choice (`a ? 'x' : 'y'`, `ok && 'x'`, `a ?? 'x'`). Calls, names and anything else show nothing a scan can read. */
function shown(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return shown(node.expression);
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
  if (ts.isConditionalExpression(node)) return [...shown(node.whenTrue), ...shown(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const logical =
      op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken;
    return logical ? [...shown(node.left), ...shown(node.right)] : [];
  }
  return [];
}

/** The user-visible literals in one source file, in order. `testID`, style strings, keys and every other prop are not shown text. */
export function uiLiterals(source: string, file = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) found.push(node.text.trim());
    // a child written as an expression: {'Hello'}, {busy ? 'Sending' : 'Send'}
    else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)))
      found.push(...shown(node.expression));
    else if (ts.isJsxAttribute(node) && SHOWN_PROPS.has(node.name.getText())) {
      const value = node.initializer;
      if (value && ts.isJsxExpression(value)) found.push(...shown(value.expression));
      else if (value && ts.isStringLiteral(value)) found.push(value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.map((text) => text.trim()).filter((text) => HAS_LETTERS.test(text));
}
