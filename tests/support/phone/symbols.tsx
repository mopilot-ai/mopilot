// expo-symbols in the test DOM: a symbol keeps its name for a test to read and shows its text fallback, as a platform without the symbol does.
export const SymbolView = ({ name, fallback }: { name: string; fallback?: any }) => <span data-symbol={name}>{fallback}</span>;
