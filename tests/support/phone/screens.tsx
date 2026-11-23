// react-native-screens in the test DOM: the stack shows what the person sees (the top screen, and the screen under a sheet); a test swipes back through a button.
import React from 'react';

export const ScreenStack = ({ children }: any) => {
  const items = React.Children.toArray(children) as any[];
  const top = items[items.length - 1];
  // a sheet (a page-sheet modal or a form sheet) leaves the screen under it in view
  const sheet = ['modal', 'formSheet'].includes(top?.props.stackPresentation);
  // New chat stays mounted under the starting page it started (natively every screen under the top one keeps its state), hidden from the person
  const starting = top?.props.screenId?.startsWith('starting:');
  // natively every screen of the stack stays mounted: a test that counts what a covered screen draws asks for that (`__phoneKeepStack`)
  const kept = (globalThis as any).__phoneKeepStack
    ? items.map((item, i) => (i < items.length - 1 ? React.cloneElement(item, { hidden: true }) : item))
    : null;
  const shown = kept ?? (sheet ? items.slice(-2) : starting ? [React.cloneElement(items.at(-2), { hidden: true }), top] : items.slice(-1));
  return (
    <div data-stack={items.map((item) => item.props.screenId).join(' ')}>
      {items.length > 1 && (
        // the system's swipe back (or a sheet pulled down): it takes the top screen away and reports it
        <button aria-label="Swipe back" onClick={() => top.props.onDismissed?.({ nativeEvent: { dismissCount: 1 } })} />
      )}
      {shown}
    </div>
  );
};
export const ScreenStackItem = ({ children, screenId, stackPresentation, onDismissed, onWillAppear, contentStyle, hidden }: any) => {
  // each screen's dismissal handler, kept by name so a test can deliver one late (after the app moved on)
  ((globalThis as any).__screenDismiss ??= {})[screenId] = onDismissed;
  // and the system's "about to show this screen" (a swipe back began), for a test to deliver
  ((globalThis as any).__screenWillAppear ??= {})[screenId] = onWillAppear;
  return (
    <section
      data-screen={screenId}
      hidden={hidden}
      data-presentation={stackPresentation}
      // the screen's own style (its insets), flattened as React Native does
      data-content-style={JSON.stringify(Object.assign({}, ...[contentStyle].flat(Infinity).filter(Boolean)))}
    >
      {children}
    </section>
  );
};
