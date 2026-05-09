import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  declare props: Readonly<Props>;
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen px-4 text-center">
          <p className="text-gray-700 mb-2 font-medium">
            Something went wrong.
          </p>
          <p className="text-gray-400 text-sm mb-6">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => globalThis.location.reload()}
            className="px-4 py-2 rounded-lg text-white text-sm"
            style={{ backgroundColor: "var(--coral)" }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
