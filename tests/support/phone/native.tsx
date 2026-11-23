// DOM implementations of native controls for focused mobile component tests.
import React from 'react';
/** Nested style arrays and nulls as one object, as React Native reads them. */
const flatten = (style: any): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style : {};
/** React Native throws when a string or number is a direct child of a View (or a Pressable): text belongs in a <Text>. The DOM would show it. */
export function assertNoRawText(children: React.ReactNode, parent: string) {
  React.Children.forEach(children, (child: any) => {
    if (child?.type === React.Fragment) return assertNoRawText(child.props.children, parent);
    if ((typeof child === 'string' && child !== '') || typeof child === 'number')
      throw new Error(`Text strings must be rendered within a <Text> component. Text: "${child}" inside <${parent}>.`);
  });
}
const node =
  (tag: string, holdsText = false) =>
  ({
    children,
    style,
    accessibilityLabel,
    accessibilityRole,
    accessibilityHint,
    accessibilityState,
    accessibilityLiveRegion,
    onLongPress,
    onPress,
    selectable,
    allowFontScaling,
    adjustsFontSizeToFit,
    minimumFontScale,
    ...props
  }: any) => {
    if (!holdsText) assertNoRawText(children, tag === 'div' ? 'View' : tag);
    return React.createElement(
      tag,
      {
        ...props,
        // a pressable text (a link) is clicked like a button
        onClick: onPress,
        style: undefined,
        // the style is kept as data (the DOM would not apply React Native styles) so a test can read what a component asked for
        'data-style': Object.keys(flatten(style)).length ? JSON.stringify(flatten(style)) : undefined,
        'data-selectable': selectable === undefined ? undefined : String(selectable),
        'data-allow-font-scaling': allowFontScaling === undefined ? undefined : String(allowFontScaling),
        'data-fit': adjustsFontSizeToFit ? String(minimumFontScale ?? 'fit') : undefined,
        'aria-label': accessibilityLabel,
        'aria-description': accessibilityHint,
        role: accessibilityRole,
        'aria-disabled': accessibilityState?.disabled,
        'aria-selected': accessibilityState?.selected,
        'aria-live': accessibilityLiveRegion,
        // a long press is kept on the element for a test to trigger
        // (a block body: React treats a function a ref callback returns as its clean-up and would call it)
        ref: (el: any) => {
          if (el) {
            el.__longPress = onLongPress;
            el.__touchStartCapture = (props as any).onTouchStartCapture;
            el.__touchEnd = (props as any).onTouchEnd;
            el.__touchCancel = (props as any).onTouchCancel;
            el.__onLayout = (props as any).onLayout;
            el.__onAccessibilityAction = (props as any).onAccessibilityAction;
            // the window position a test says the view has (`__phoneWindowTop`), as `measureInWindow` reports it
            if (!(globalThis as any).__phoneNoMeasure)
              el.measureInWindow = (done: (x: number, y: number, w: number, h: number) => void) =>
                done(0, (globalThis as any).__phoneWindowTop ?? 0, 300, 40);
            // the place in the list's content a test says the view has (`__phoneContentTop`), as `measureLayout` reports it; none says it could not be measured
            el.measureLayout = (_node: unknown, done: (x: number, y: number, w: number, h: number) => void, fail?: () => void) => {
              const top = (globalThis as any).__phoneContentTop;
              if (top === undefined) fail?.();
              else done(0, top, 300, 40);
            };
          }
          const own = (props as any).ref;
          if (typeof own === 'function') own(el);
          else if (own) own.current = el;
        },
      },
      children,
    );
  };
export const View = node('div');
export const Text = node('span', true);
export const SafeAreaView = node('div');
export const ActivityIndicator = ({ accessibilityLabel }: any) => <div role="progressbar" aria-label={accessibilityLabel} />;
const Scroll = node('div');
/** A pull to refresh is a button in the test DOM; `refreshing` shows as its label. */
export const ScrollView = React.forwardRef(
  (
    {
      refreshControl,
      children,
      onContentSizeChange,
      onLayout,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      ...props
    }: any,
    ref: any,
  ) => {
    // a test drives what the native view reports (growth, layout) through these, and reads where the view was asked to scroll
    React.useImperativeHandle(ref, () => ({
      scrollToEnd: (options: unknown) => ((globalThis as any).__scrolledToEnd ??= []).push(options),
      scrollTo: (options: unknown) => ((globalThis as any).__scrolledTo ??= []).push(options),
      scrollResponderZoomTo: (rect: unknown) => ((globalThis as any).__zoomedTo ??= []).push(rect),
    }));
    const scrollEvents = {
      onContentSizeChange,
      onLayout,
      onScroll: props.onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
      contentContainerStyle: props.contentContainerStyle,
    };
    (globalThis as any).__scrollEvents = scrollEvents;
    // each scroll view by its testID, for a test that has several on screen (a pager of zooming pictures)
    ((globalThis as any).__scrollViews ??= {})[props.testID ?? 'scroll'] = scrollEvents;
    return (
      <Scroll {...props} data-scrollview="true" data-horizontal={props.horizontal ? 'true' : undefined}>
        {refreshControl && (
          <button
            aria-label={refreshControl.props.refreshing ? 'Refreshing' : 'Pull to refresh'}
            onClick={refreshControl.props.onRefresh}
          />
        )}
        {children}
      </Scroll>
    );
  },
);
export const RefreshControl = () => null;
/** A test raises a keyboard event by name; removing a listener is recorded. */
export const Keyboard = {
  /** Counted, so a test reads that the keyboard was put away. */
  dismiss: () => {
    const g = globalThis as any;
    g.__keyboardDismissed = (g.__keyboardDismissed ?? 0) + 1;
  },
  addListener: (name: string, fn: () => void) => {
    const g = globalThis as any;
    (g.__keyboardListeners ??= {})[name] = fn;
    return { remove: () => ((g.__keyboardRemoved ??= []).push(name), delete g.__keyboardListeners[name]) };
  },
};
/** The screen a test says it has (`__phoneScreen`), else an iPhone 13 Pro Max's 428 × 926 pt. */
export const Dimensions = { get: () => (globalThis as any).__phoneScreen ?? { width: 428, height: 926, scale: 3, fontScale: 1 } };
const AvoidingView = node('div');
/** Lifts its content above the keyboard; the DOM has no keyboard, so a test reads which behavior the app asked for. */
export const KeyboardAvoidingView = ({ behavior, keyboardVerticalOffset, ...props }: any) => (
  <AvoidingView data-keyboard-behavior={behavior ?? 'none'} data-keyboard-offset={keyboardVerticalOffset ?? 0} {...props} />
);
const styleAt = (style: any, pressed: boolean) => {
  const flat = flatten(typeof style === 'function' ? style({ pressed }) : style);
  return Object.keys(flat).length ? JSON.stringify(flat) : undefined;
};
export const Pressable = ({
  children,
  onPress,
  onLongPress,
  onPressOut,
  delayLongPress,
  disabled,
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityValue,
  accessibilityActions,
  onAccessibilityAction,
  style,
  // what the native button shows while held (the Tap primitive passes these)
  activeOpacity,
  underlayColor,
  activeUnderlayOpacity,
  defaultOpacity,
  animationDuration,
}: any) => {
  assertNoRawText(children, 'Pressable');
  if (accessibilityLabel === 'Send message') (globalThis as any).__queuedPhoneSend = onPress;
  return (
    <button
      // the press handlers a touch would call, for a test to trigger
      ref={(el: any) => {
        if (el) el.__press = { onLongPress, onPressOut, delayLongPress, accessibilityActions, onAccessibilityAction };
      }}
      disabled={disabled}
      onClick={onPress}
      // kept as data, like a View's, so a test can read the tint of a row that is a button
      // a style that depends on the press is read as it is at rest
      data-style={styleAt(defaultOpacity === undefined || defaultOpacity === 1 ? style : [style, { opacity: defaultOpacity }], false)}
      // and as it is held down, for a test to read the press feedback
      data-pressed-style={typeof style === 'function' ? styleAt(style, true) : undefined}
      data-active-opacity={activeOpacity}
      data-press-ms={animationDuration ? `${animationDuration.in}/${animationDuration.out}` : undefined}
      data-active-underlay={activeUnderlayOpacity ? underlayColor : undefined}
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      aria-description={accessibilityHint}
      aria-selected={accessibilityState?.selected}
      aria-expanded={accessibilityState?.expanded}
      aria-busy={accessibilityState?.busy}
      aria-valuetext={accessibilityValue?.text}
      aria-disabled={accessibilityState?.disabled}
      aria-checked={accessibilityState?.checked}
    >
      {children}
    </button>
  );
};
export const TextInput = ({ onChangeText, onSelectionChange, selection, ...p }: any) => (
  <input
    placeholder={p.placeholder}
    aria-label={p.accessibilityLabel}
    value={p.value}
    // a read-only text view (editable false) is how iOS gets selectable text
    readOnly={p.editable === false}
    // the whole text, for a test: a one-line input cannot hold the line breaks of a multiline field
    data-text={p.value}
    // the field's style, kept as data like a View's, for a test to read
    data-style={styleAt(p.style, false)}
    // what a keyboard is told about the field, for a test to read
    data-auto-correct={String(p.autoCorrect ?? true)}
    data-spell-check={String(p.spellCheck ?? p.autoCorrect ?? true)}
    // whether the field takes the keyboard as its screen opens
    data-auto-focus={String(p.autoFocus ?? false)}
    // a test moves the caret the way the native field reports it: through this handler, and reads the position the screen asked for
    ref={(el: any) => {
      if (!el) return;
      el.__selectionChange = onSelectionChange;
      // a test reports the height the native field laid out at
      el.__onLayout = p.onLayout;
      el.__focus = p.onFocus;
      el.__blur = p.onBlur;
      (el.__selections ??= []).push(selection);
    }}
    onChange={(e) => onChangeText?.(e.target.value)}
    onKeyDown={(e) => e.key === 'Enter' && p.onSubmitEditing?.()}
  />
);
export const StyleSheet = { create: (value: any) => value, flatten };
/** A switch is a button that says whether it is on; a tap flips it the way a person's would. */
export const Switch = ({ accessibilityLabel, accessibilityRole, accessibilityState, value, disabled, onValueChange }: any) => (
  <button
    role="switch"
    aria-label={accessibilityLabel}
    aria-checked={(accessibilityState?.checked ?? value) ? 'true' : 'false'}
    data-accessibility-role={accessibilityRole}
    disabled={disabled}
    // a native switch takes the touch itself: the row it sits in is not pressed
    onClick={(e) => (e.stopPropagation(), onValueChange?.(!value))}
  />
);
/** Links a person opens: a test reads the URLs, and may make opening fail. */
/** A one-button alert: kept for a test to read (`__alerts`, newest last, each its title and message). */
export const Alert = {
  alert: (title: string, message?: string) => void (((globalThis as any).__alerts ??= []) as unknown[]).push({ title, message }),
};
/** The iOS action sheet: the open sheet's options are kept for a test to pick one by its label (component-kit's click does). */
export const ActionSheetIOS = {
  showActionSheetWithOptions: (options: { options: string[]; cancelButtonIndex?: number }, pick: (index: number) => void) => {
    (globalThis as any).__actionSheet = { options: options.options, cancel: options.cancelButtonIndex, pick };
  },
};
/**
 * Links both ways: `openURL` records what the app opened (`__openedUrls`, `__linkFails` makes it fail); a test delivers
 * links to the app through `__phoneInitialUrl` (opened at start) and `__phoneLinkListeners` (the rest).
 */
export const AppState = {
  addEventListener: (_type: string, listener: (state: string) => void) => {
    (globalThis as any).__phoneForeground = () => listener('active');
    return { remove: () => void ((globalThis as any).__phoneForeground = undefined) };
  },
};
export const Linking = {
  openSettings: async () => void ((globalThis as any).__phoneOpenedSettings = true),
  // a scheme is installed when a test lists it in __phoneSchemes (iOS answers only for the schemes the app declares)
  canOpenURL: async (url: string) => {
    if ((globalThis as any).__phoneProbeFails) throw new Error('cannot ask');
    return ((globalThis as any).__phoneSchemes ?? []).includes(url.split(':')[0]);
  },
  openURL: (url: string) => {
    ((globalThis as any).__openedUrls ??= []).push(url);
    return (globalThis as any).__linkFails ? Promise.reject(Error('cannot open')) : Promise.resolve();
  },
  getInitialURL: async () => (globalThis as any).__phoneInitialUrl ?? null,
  addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
    const listeners: Array<(event: { url: string }) => void> = ((globalThis as any).__phoneLinkListeners ??= []);
    listeners.push(listener);
    return {
      remove: () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  },
};
/** The colour scheme override: a test reads what the app last asked for. */
export const Appearance = {
  setColorScheme: (scheme: string) => void ((globalThis as any).__phoneScheme = scheme),
};
/** The share sheet: a test reads what it was asked to share and may make it refuse. */
export const Share = {
  share: async (content: { message: string }) => {
    if ((globalThis as any).__phoneShareFails) throw new Error('share failed');
    ((globalThis as any).__phoneShared ??= []).push(content.message);
    return { action: 'sharedAction' };
  },
};
export const useColorScheme = () => ((globalThis as any).__phoneDark ? 'dark' : 'light');
export const Image = ({ source, accessibilityLabel }: any) => <img src={source?.uri} alt={accessibilityLabel} />;
export const Platform = {
  get OS() {
    return (globalThis as any).__phonePlatform ?? 'ios';
  },
};
/** The hardware back listeners the mounted screens registered, newest last: a test presses back with `pressHardwareBack`. */
export const BackHandler = {
  addEventListener: (_event: string, handler: () => boolean) => {
    const listeners: Array<() => boolean> = ((globalThis as any).__phoneBackListeners ??= []);
    listeners.push(handler);
    return {
      remove: () => {
        // a second remove of the same subscription does nothing, as in React Native, and never drops another screen's listener
        const at = listeners.indexOf(handler);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  },
};
export const useWindowDimensions = () => ({
  width: (globalThis as any).__phoneWidth ?? 390,
  height: 800,
  fontScale: (globalThis as any).__phoneFontScale ?? 1,
});

/** The responder a screen asks for: the last one created is kept for a test to feed touches to. */
/** A modal draws its children while visible, as a dialog. */
export const Modal = ({ visible, children, onRequestClose }: any) =>
  visible ? (
    <div
      role="dialog"
      ref={(el: any) => {
        if (el) el.__requestClose = onRequestClose;
      }}
    >
      {children}
    </div>
  ) : null;
export const PanResponder = {
  create: (config: any) => {
    (globalThis as any).__phonePan = config;
    return { panHandlers: {} };
  },
};

/** Virtualized list boundary: native owns viewport scrolling; tests inspect its configuration and select rows. */
export const FlatList = ({ data, renderItem, keyExtractor, keyboardShouldPersistTaps, ...props }: any) => (
  <View {...props} data-flat-list="true" data-keyboard-taps={keyboardShouldPersistTaps}>
    {data.map((item: any, index: number) => (
      <React.Fragment key={keyExtractor(item, index)}>{renderItem({ item, index })}</React.Fragment>
    ))}
  </View>
);

/** The system's Reduce Motion: read once, then changes arrive through the listener a test fires with `__phoneReduceMotionChange(value)`. */
export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => !!(globalThis as any).__phoneReduceMotion,
  addEventListener: (_event: string, listener: (value: boolean) => void) => {
    (globalThis as any).__phoneReduceMotionChange = listener;
    return { remove: () => void ((globalThis as any).__phoneReduceMotionChange = undefined) };
  },
};
