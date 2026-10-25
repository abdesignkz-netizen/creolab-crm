import { Component, type ReactNode } from "react";
import { useUiText } from "../lib/uiText";
import "./page-error-boundary.css";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: string;
  title: string;
  description: string;
  reloadLabel: string;
  homeLabel: string;
};

class RecoveryBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidUpdate(previous: Props) {
    // Navigation can recover another section without remounting healthy forms.
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return <section className="page-recovery" role="alert">
      <span className="page-recovery-symbol" aria-hidden="true">!</span>
      <h1>{this.props.title}</h1>
      <p>{this.props.description}</p>
      <div className="page-recovery-actions">
        <button className="btn" type="button" onClick={() => window.location.reload()}>{this.props.reloadLabel}</button>
        <a className="btn secondary" href="/today">{this.props.homeLabel}</a>
      </div>
    </section>;
  }
}

/** Covers render failures and rejected lazy imports; never retries a submitted action. */
export function PageErrorBoundary({ children, resetKey, fallback }: { children: ReactNode; resetKey?: string; fallback?: ReactNode }) {
  const text = useUiText();
  return <RecoveryBoundary resetKey={resetKey} fallback={fallback}
    title={text("Не удалось открыть этот раздел")}
    description={text("Попробуйте перезагрузить страницу или открыть другой раздел. Несохранённые изменения на этой странице могут быть потеряны.")}
    reloadLabel={text("Перезагрузить страницу")}
    homeLabel={text("На главную")}>
    {children}
  </RecoveryBoundary>;
}
