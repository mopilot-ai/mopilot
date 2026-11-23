// expo's native view lookup for the production entry test: node has no native views, so there is none.
export function requireNativeView(): never {
  throw new Error('no native views in node');
}
