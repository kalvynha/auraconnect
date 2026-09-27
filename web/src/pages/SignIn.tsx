import { useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import { auth, usingEmulators } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { Button, ErrorBanner, Field } from '../components/ui';

export default function SignInPage() {
  // 'join' explains invites; only someone starting a new organization creates an account here (M5).
  const [mode, setMode] = useState<'signin' | 'join' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'join') return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'signin') {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email.trim()) {
      setError('Enter your email first.');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setInfo('Password reset email sent.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand brand-lg">
          <span className="brand-mark">A</span>
          <div className="brand-name">AuraConnect</div>
        </div>
        <h1>{mode === 'signin' ? 'Sign in' : mode === 'join' ? 'Get access' : 'Create your organization'}</h1>
        {usingEmulators && <div className="banner banner-info">Using local Firebase emulators</div>}
        <ErrorBanner error={error} />
        {info && <div className="banner banner-info">{info}</div>}
        {mode === 'join' && (
          <>
            <div className="banner banner-info">
              <strong>Joining your hospice's AuraConnect?</strong> Ask your administrator for an invite. You'll get an
              email with a sign-in link; open it to set up your account. You don't need to create an account here.
            </div>
            <p className="muted small">
              Only create an account yourself if you're setting up AuraConnect for a new organization.
            </p>
            <Button className="btn-block" onClick={() => setMode('signup')}>I'm starting a new organization</Button>
            <div className="row space-between">
              <button type="button" className="link" onClick={() => setMode('signin')}>Have an account? Sign in</button>
            </div>
          </>
        )}
        {mode !== 'join' && (
        <>
        {mode === 'signup' && (
          <Field label="Your name">
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            minLength={mode === 'signup' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
        </Field>
        <Button type="submit" variant="primary" busy={busy} className="btn-block">
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
        {mode === 'signup' && (
          <p className="muted small">Your account is for a new organization. To join an existing one, use the invite link from your administrator instead.</p>
        )}
        <div className="row space-between">
          <button type="button" className="link" onClick={() => setMode(mode === 'signin' ? 'join' : 'signin')}>
            {mode === 'signin' ? 'New here? Get access' : 'Have an account? Sign in'}
          </button>
          {mode === 'signin' && (
            <button type="button" className="link" onClick={() => void reset()}>
              Forgot password?
            </button>
          )}
        </div>
        </>
        )}
      </form>
    </div>
  );
}
