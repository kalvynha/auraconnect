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
const isBlank = (v: unknown) => typeof v !== 'string' || !v.trim() || v === 'undefined' || v.startsWith('your-');
const missing: string[] = REQUIRED_ENV.filter((k) => isBlank(import.meta.env[k]));
const apiKey = String(import.meta.env.VITE_FIREBASE_API_KEY ?? '');
// Browser API keys are always "AIza" + 35 characters; anything else is a copy/paste or config problem.
if (!missing.includes('VITE_FIREBASE_API_KEY') && !/^AIza[0-9A-Za-z_-]{35}$/.test(apiKey)) {
  const bad = [...apiKey].findIndex((ch, i) => (i < 4 ? ch !== 'AIza'[i] : !/[0-9A-Za-z_-]/.test(ch)));
  const where =
    bad >= 0
      ? `character ${bad + 1} is "${[...apiKey][bad]}" (U+${[...apiKey][bad]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}), which is not a plain letter/digit — retype it`
      : `${apiKey.length} chars; expected AIza… with 39 chars`;
  missing.push(`VITE_FIREBASE_API_KEY (${where})`);
}

if (missing.length > 0) {
  // Firebase would throw at import time without config, leaving a blank page.
  root.render(
    <Problem title="Firebase is not configured">
      <p className="muted">
        This build has missing or invalid values: {missing.join(', ')}. Create <code>web/.env.local</code> with your Firebase web app
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
