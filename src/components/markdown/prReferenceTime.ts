// The saved turn timestamp available to PR links anywhere inside the turn’s Markdown.
import { createContext } from 'react';

export const PullRequestReferenceTime = createContext<number | null>(null);
