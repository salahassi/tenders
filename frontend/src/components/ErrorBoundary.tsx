import { Component, type ErrorInfo, type ReactNode } from "react";
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "Application view failed",
      error.message,
      errorInfo.componentStack,
    );
  }
  render() {
    return this.state.error ? (
      <main className="fatal-state">
        <h1>This view could not load</h1>
        <p>
          Your saved workspace is still in this browser. Reload the page to try
          again.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
