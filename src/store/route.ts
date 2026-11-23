// The main window's routes: which page or chat it shows.
import type { Route } from '../../shared/model/window';
export type { Route } from '../../shared/model/window';

/** Cloud tasks open as a primary page rather than a pane. */
export const activeCloudTask = ({ route }: { route: Route }) => (route.name === 'cloud' ? route.id : null);
