import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@/components/ui/surface';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI error', error, info.componentStack); }
  override render() {
    if (this.state.error) {
      return <div className="page"><ErrorState title="This page hit a problem" message="Your data is safe. Try again, or go back to the dashboard." onRetry={() => this.setState({ error: null })} /></div>;
    }
    return this.props.children;
  }
}
