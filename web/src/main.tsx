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
const validKey = (v: unknown) => typeof v === 'string' && /^AIza[0-9A-Za-z_-]{35}$/.test(v);

/** Problems with the config baked into this build, or [] if it is usable. */
function envProblems(): string[] {
  const problems: string[] = REQUIRED_ENV.filter((k) => isBlank(import.meta.env[k]));
  const apiKey = String(import.meta.env.VITE_FIREBASE_API_KEY ?? '');
  if (!problems.includes('VITE_FIREBASE_API_KEY') && !validKey(apiKey)) {
    const chars = [...apiKey];
    const bad = chars.findIndex((ch, i) => (i < 4 ? ch !== 'AIza'[i] : !/[0-9A-Za-z_-]/.test(ch)));
    problems.push(
      bad >= 0
        ? `VITE_FIREBASE_API_KEY: character ${bad + 1} is "${chars[bad]}" (U+${chars[bad]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}), not a plain letter/digit`
        : `VITE_FIREBASE_API_KEY: ${apiKey.length} characters, expected 39`,
    );
  }
  return problems;
}

/**
 * On Firebase Hosting, /__/firebase/init.json always serves this project's
 * correct web config, so a missing or mangled .env.local can't break the site.
 */
async function hostingConfig(): Promise<Record<string, string> | null> {
  try {
    const res = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = (await res.json()) as Record<string, string>;
    return validKey(cfg.apiKey) && cfg.projectId ? cfg : null;
  } catch {
    return null;
  }
}

async function start() {
  const problems = envProblems();
  if (problems.length > 0) {
    const cfg = await hostingConfig();
    if (!cfg) {
      root.render(
        <Problem title="Firebase is not configured">
          <p className="muted">
            This build has missing or invalid values: {problems.join('; ')}. Create <code>web/.env.local</code> with
            your Firebase web app config (see <code>web/.env.example</code>), then run <code>npm run build</code> and
            deploy again.
          </p>
        </Problem>,
      );
      return;
    }
    if (import.meta.env.VITE_USE_EMULATORS !== 'true') {
      console.warn('Using Firebase Hosting config because the build config is invalid:', problems.join('; '));
    }
    window.__AURA_FIREBASE_CONFIG__ = cfg;
  }

  // Imported lazily so Firebase initializes with the chosen config, and init errors are shown.
  const [{ BrowserRouter }, { SessionProvider }, { default: App }] = await Promise.all([
    import('react-router-dom'),
    import('./lib/session'),
    import('./App'),
  ]);
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
}

start().catch((err: unknown) => {
  root.render(
    <Problem title="AuraConnect failed to start">
      <p className="muted">{err instanceof Error ? err.message : String(err)}</p>
    </Problem>,
  );
});
