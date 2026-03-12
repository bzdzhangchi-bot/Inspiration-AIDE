import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import App from './App.tsx'

type RootErrorBoundaryState = {
  error: Error | null;
};

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
    console.error('[root-error-boundary]', error, errorInfo.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--bg)',
        color: 'var(--text)'
      }}>
        <div style={{
          width: 'min(760px, 100%)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          background: 'var(--panel)',
          padding: '18px 20px',
          boxShadow: 'var(--shadow-1)'
        }}>
          <div style={{ fontSize: '13px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--danger)', marginBottom: '10px' }}>
            Renderer crashed
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, marginBottom: '10px' }}>
            The app hit a runtime error during startup.
          </div>
          <pre style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            lineHeight: 1.5,
            color: 'var(--text-soft)'
          }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      </div>
    );
  }
}

window.addEventListener('error', (event) => {
  console.error('[window:error]', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[window:unhandledrejection]', event.reason);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
