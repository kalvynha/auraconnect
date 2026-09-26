import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const REQUIRED_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="center-screen">
      <div className="auth-card">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Shows startup/render errors instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Problem title="Something went wrong">
        <p className="muted">{this.state.error.message}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </Problem>
    );
  }
}

const root = createRoot(document.getElementById('root')!);
const missing = REQUIRED_ENV.filter((k) => !import.meta.env[k]);

if (missing.length > 0) {
  // Firebase would throw at import time without config, leaving a blank page.
  root.render(
    <Problem title="Firebase is not configured">
      <p className="muted">
        This build is missing {missing.join(', ')}. Create <code>web/.env.local</code> with your Firebase web app
        config (see <code>web/.env.example</code>), then run <code>npm run build</code> and deploy again.
      </p>
    </Problem>,
  );
} else {
  // Imported lazily so a Firebase init error is caught and shown.
  Promise.all([import('react-router-dom'), import('./lib/session'), import('./App')])
    .then(([{ BrowserRouter }, { SessionProvider }, { default: App }]) => {
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <BrowserRouter>
              <SessionProvider>
                <App />
              </SessionProvider>
            </BrowserRouter>
          </ErrorBoundary>
        </StrictMode>,
      );
    })
    .catch((err: unknown) => {
      root.render(
        <Problem title="AuraConnect failed to start">
          <p className="muted">{err instanceof Error ? err.message : String(err)}</p>
        </Problem>,
      );
    });
}
