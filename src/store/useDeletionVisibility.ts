// Component-local search results observe terminal receipts even when no subscribed store row changed.
import { useSyncExternalStore } from 'react';
import { deletionVisibility } from './deletionVisibility';
export const useDeletionVisibility = () => useSyncExternalStore(deletionVisibility.subscribe, deletionVisibility.snapshot);
