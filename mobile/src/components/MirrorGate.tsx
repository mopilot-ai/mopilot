// Asks the Mac whether the terminal and screen are on for this phone before a mirror screen opens, so an "off" switch reads clearly and no approval prompt is raised for nothing.
import { type ReactNode } from 'react';
import { Text } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { capabilities } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { Loadable } from './Loadable';
import { useStyles } from './ui';

export const MIRRORS_OFF = 'Terminal and screen are off for this phone. Turn them on in MoPilot on your computer.';

export function MirrorGate({ runtime, children }: { runtime: MobileRuntime; children: ReactNode }) {
  const styles = useStyles();
  const request = useOwnedRequest(runtime);
  return (
    <Loadable what="settings" load={() => capabilities(request)}>
      {(caps) =>
        caps.mirrors === false ? (
          <Text accessibilityRole="alert" style={{ ...styles.muted, textAlign: 'center', padding: 24 }}>
            {MIRRORS_OFF}
          </Text>
        ) : (
          children
        )
      }
    </Loadable>
  );
}
