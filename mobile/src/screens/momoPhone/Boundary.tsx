// One bad row, card or page never blanks the screen: what fails to draw is replaced by its fallback, and drawn again when what it was given changes.
import { Component, type ReactNode } from 'react';

export class Boundary extends Component<{ resetKey: unknown; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(before: { resetKey: unknown }) {
    if (this.state.failed && before.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
