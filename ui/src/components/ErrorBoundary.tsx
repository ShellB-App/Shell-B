import { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full items-center justify-center p-4">
          <div className="max-w-2xl w-full space-y-4 rounded-xl border border-red-500/30 bg-[var(--bg-secondary)] p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-red-500">Shell:B Interface Crashed</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              An unexpected error occurred in the user interface.
            </p>
            {this.state.error && (
              <pre className="overflow-x-auto rounded-lg bg-[var(--bg-tertiary)] p-4 text-[11px] font-mono text-[var(--text-muted)] border border-[var(--border-subtle)] whitespace-pre-wrap">
                {this.state.error.stack || this.state.error.message}
              </pre>
            )}
            <div className="pt-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded bg-red-500/20 text-red-500 hover:bg-red-500/30 text-sm font-medium transition"
              >
                Reload UI
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
