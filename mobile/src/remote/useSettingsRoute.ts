// Whether Settings is open and on which page (#4593, #4603): a Host's card on the home opens it on that machine's own page, New session while the Mac is away on that machine's New chat, the list otherwise.
import { useCallback, useState } from 'react';

export function useSettingsRoute() {
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<`machine:${string}` | `newchat:${string}` | undefined>(undefined);
  const closeSettings = useCallback(() => {
    setSettings(false);
    setSettingsPage(undefined);
  }, []);
  const openMachine = useCallback((id: string) => {
    setSettingsPage(`machine:${id}`);
    setSettings(true);
  }, []);
  const openNewChat = useCallback((id: string) => {
    setSettingsPage(`newchat:${id}`);
    setSettings(true);
  }, []);
  return { settings, setSettings, settingsPage, closeSettings, openMachine, openNewChat };
}

/** MoMo's Computers section leaves MoMo for a machine's page or the pairing flow: MoMo closes (`setMomo(null)`) as they open. */
export const momoComputers = (
  setMomo: (open: null) => void,
  openMachine: (machineId: string) => void,
  setPairing: (on: boolean) => void,
) => ({
  open: (machineId: string) => {
    setMomo(null);
    openMachine(machineId);
  },
  pair: () => {
    setMomo(null);
    setPairing(true);
  },
});
