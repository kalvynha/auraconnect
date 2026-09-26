import { sendSignInLinkToEmail } from 'firebase/auth';
import { auth } from './firebase';

/** Path the invitation email links back to. Handled by `FinishSignInPage`. */
export const FINISH_SIGN_IN_PATH = '/finish-signin';

/**
 * Emails an invitee a Firebase Auth sign-in link. Firebase sends the email
 * itself (Authentication → Templates → Email link), so no third-party mail
 * provider is involved. The email carries no PHI — only the app link.
 *
 * Requires "Email link (passwordless sign-in)" to be enabled and this site's
 * domain to be in Authentication → Settings → Authorized domains.
 */
export async function sendInvitationEmail(email: string): Promise<void> {
  const url = new URL(FINISH_SIGN_IN_PATH, window.location.origin);
  url.searchParams.set('email', email);
  await sendSignInLinkToEmail(auth, email, { url: url.toString(), handleCodeInApp: true });
}
