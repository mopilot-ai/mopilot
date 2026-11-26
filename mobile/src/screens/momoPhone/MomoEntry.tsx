// The one door to MoMo from the app: an invited account whose computer serves MoMo's home gets the home screens (with the composer, draft, voice note and push focus the classic screen has), everyone else the screens they have; a push tap on a channel opens the classic screen, which holds the channels.
import { type ComponentProps, useState } from 'react';
import { View } from 'react-native';
import { Pill } from '../MomoPill';
import { say } from '../../momoPhone/say';
import { BackLink } from '../../components/BackLink';
import { useTheme } from '../../theme';
import { Momo, type MomoFocus } from '../Momo';
import { MomoPhone } from './MomoPhone';
import { Body, Skeleton, Title } from './parts';
import { useMomoHome } from './useMomoHome';

export type { MomoFocus };

export function MomoEntry(props: ComponentProps<typeof Momo>) {
  const theme = useTheme();
  const home = useMomoHome(props.runtime, props.state.phase === 'online');
  // MoMo's channels, Pause and its page live on the classic screen: a push tap on a channel, or More on the home, opens it
  const [classic, setClassic] = useState(false);
  if (classic) return <Momo {...props} back={() => setClassic(false)} />;
  if (typeof props.focus?.channel === 'string') return <Momo {...props} />;
  // a computer that is online and does not answer is said so, with Try again
  if (home.failed)
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 54, paddingHorizontal: 16 }}>
        <BackLink onPress={props.back} />
        <Title>{say('momoIsnTReachable')}</Title>
        <Body>{home.failed}</Body>
        <Pill strong disabled={false} title={say('tryAgain')} onPress={home.retry} />
      </View>
    );
  // until the computer has said, nothing is drawn as the wrong screen: a Back and quiet bars stand in
  if (!home.settled)
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 54, paddingHorizontal: 16 }}>
        <BackLink onPress={props.back} />
        <Skeleton />
      </View>
    );
  return home.store ? (
    <MomoPhone
      store={home.store}
      back={props.back}
      drafts={props.drafts}
      focus={props.focus}
      classic={() => setClassic(true)}
      pairId={props.state.selectedPair}
      voice={
        props.media ? { runtime: props.runtime, media: props.media, listed: home.voice, online: props.state.phase === 'online' } : undefined
      }
    />
  ) : (
    <Momo {...props} />
  );
}
