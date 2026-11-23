// Whether the welcome page is open: it stays until the user presses Continue, even once a harness already works.
import { create } from 'zustand';

/** `dismissed`: left for Settings this launch; a new install isn't welcomed again until the next one (#2034) */
export const useWelcome = create<{ open: boolean; dismissed?: boolean }>(() => ({ open: false }));
export const openWelcome = () => useWelcome.setState({ open: true });
export const closeWelcome = () => useWelcome.setState({ open: false });
export const dismissWelcome = () => useWelcome.setState({ open: false, dismissed: true });
