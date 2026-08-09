import { Component, type ReactNode } from "react";
import { Panel } from "../components/ui";

interface RouteErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly onReload?: () => void;
}

interface RouteErrorBoundaryState {
  readonly failed: boolean;
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  override state: RouteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { failed: true };
  }

  override componentDidUpdate(previousProps: RouteErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="page-section narrow-page page-stack route-error">
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <Panel>
            <p className="eyebrow">Trail interrupted</p>
            <h1>This part of camp did not arrive.</h1>
            <p>
              The page file may have changed while Firelight was open. Reload to fetch the
              current version, or return to the campfire.
            </p>
            <div className="button-row">
              <button
                className="pixel-button"
                type="button"
                onClick={this.props.onReload ?? (() => { window.location.reload(); })}
              >
                Reload this page
              </button>
              <a className="pixel-button pixel-button--secondary" href="/">
                Return to the campfire
              </a>
            </div>
          </Panel>
        </div>
      </div>
    );
  }
}
