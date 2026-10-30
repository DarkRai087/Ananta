import { Component } from "react";

/**
 * Keeps a rendering error inside one panel: it shows the message and a retry button instead of
 * blanking the whole page. `resetKey` changing (e.g. a new symbol) clears the error.
 */
export default class ErrorBoundary extends Component {
  state = { error: null, key: undefined };

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner error">
        {this.props.name || "This panel"} failed to show: {this.state.error.message}{" "}
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
