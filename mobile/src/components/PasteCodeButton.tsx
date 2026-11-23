// The system's own Paste button (iOS 16+): one tap pastes what was copied without the "Allow Paste" question, and it is only live while the clipboard holds text; where the system has none, nothing is drawn and the caller offers its paste field.
import { ClipboardPasteButton, isPasteButtonAvailable } from 'expo-clipboard';
import { View, useWindowDimensions } from 'react-native';
import { useTheme } from '../theme';

export function PasteCodeButton({ onText }: { onText: (text: string) => void }) {
  const theme = useTheme();
  // the system draws its own label, which grows with the text size: the box must too, or the word is cut
  const { fontScale } = useWindowDimensions();
  if (!isPasteButtonAvailable) return null;
  return (
    <View style={{ alignSelf: 'stretch' }}>
      <ClipboardPasteButton
        acceptedContentTypes={['plain-text']}
        displayMode="iconAndLabel"
        cornerStyle="capsule"
        backgroundColor={theme.btn}
        foregroundColor={theme.btnInk}
        style={{ height: Math.round(52 * Math.min(Math.max(fontScale, 1), 1.6)), alignSelf: 'stretch' }}
        onPress={(data) => {
          // a text only: the button can also hand over an image, which is no code
          if (data.type === 'text') onText(data.text);
        }}
      />
    </View>
  );
}
