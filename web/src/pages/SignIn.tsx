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
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
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
        <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
        {usingEmulators && <div className="banner banner-info">Using local Firebase emulators</div>}
        <ErrorBanner error={error} />
        {info && <div className="banner banner-info">{info}</div>}
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
        <div className="row space-between">
          <button type="button" className="link" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'Create account' : 'Have an account? Sign in'}
          </button>
          {mode === 'signin' && (
            <button type="button" className="link" onClick={() => void reset()}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
