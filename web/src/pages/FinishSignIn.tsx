import { useState, type FormEvent } from 'react';
import { fetchSignInMethodsForEmail, getAdditionalUserInfo, signInWithEmailLink, updatePassword } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { Button, ErrorBanner, Field } from '../components/ui';

/**
 * Landing page for invitation emails. Completes email-link sign-in (which also
 * verifies the address), has the invitee set a password for the iOS app, then
 * hands off to onboarding where the pending invite can be accepted.
 *
 * M5: if the address already had an account (someone may have registered it with a
 * password before the real owner got the invite), setting a new password is required —
 * there is no "Skip" — so a previously set password stops working.
 */
export default function FinishSignInPage({ onDone }: { onDone: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [signedIn, setSignedIn] = useState(false);
  const [mustReset, setMustReset] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function completeSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Best effort: returns [] when email-enumeration protection is on; isNewUser covers that case.
      const methods = await fetchSignInMethodsForEmail(auth, email.trim()).catch(() => [] as string[]);
      const cred = await signInWithEmailLink(auth, email.trim(), window.location.href);
      const isNewUser = getAdditionalUserInfo(cred)?.isNewUser ?? false;
      setMustReset(methods.includes('password') || !isNewUser);
      setSignedIn(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      if (!auth.currentUser) throw new Error('Your sign-in expired. Open the invitation link again.');
      await updatePassword(auth.currentUser, password);
      finish();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function finish() {
    window.history.replaceState(null, '', '/');
    onDone();
  }

  return (
    <div className="center-screen">
      <div className="auth-card">
        <h1>{signedIn ? (mustReset ? 'Choose a new password' : 'Set your password') : 'Accept your invitation'}</h1>
        <ErrorBanner error={error} />
        {!signedIn ? (
          <form className="form" onSubmit={completeSignIn}>
            <p className="muted">Confirm the email address this invitation was sent to.</p>
            <Field label="Email">
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" busy={busy}>Continue</Button>
          </form>
        ) : (
          <form className="form" onSubmit={savePassword}>
            {mustReset ? (
              <div className="banner banner-warn">
                An account already existed for this email. For your security, choose a new password now; any
                password set before this invitation will stop working.
              </div>
            ) : (
              <p className="muted">
                Your email is verified. Choose a password so you can also sign in to the AuraConnect iOS app.
              </p>
            )}
            <Field label="Password">
              <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm password">
              <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <div className="row gap">
              <Button type="submit" variant="primary" busy={busy}>Save and continue</Button>
              {!mustReset && <Button type="button" variant="ghost" onClick={finish}>Skip for now</Button>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
