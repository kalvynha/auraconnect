# Setup: Google Cloud, Firebase and HIPAA

## 1. Local development (emulators)
Prerequisites: Node 22, Java 17+, `npm i -g firebase-tools`.

```bash
cd functions && npm install && npm run build && cd ..
firebase emulators:start --project demo-auraconnect      # Emulator UI at http://localhost:4000
cd scripts && npm install && npm run seed                 # demo org + users (password123)
cd web && npm install && cp .env.example .env.local && npm run dev   # set VITE_USE_EMULATORS=true
```

The iOS app talks to the emulators when launched with the environment variable `USE_FIREBASE_EMULATORS=1` (see `ios/README.md`).

The emulator has no Vertex AI. Referral extraction there fails unless you run with Application Default Credentials for a real GCP project (`gcloud auth application-default login` and `GCLOUD_PROJECT`).

## 2. Production project

### Fast path: automated setup
Create the project in the Firebase console, **with Google Analytics turned off**, and upgrade it to the **Blaze** plan. Then, from the repo root on your machine:
```bash
gcloud auth login && firebase login
./scripts/gcp-setup.sh YOUR_PROJECT_ID --deploy
```
The script does steps 3–10 below for you:
- enables the APIs
- sets up Identity Platform with email/password
- creates Firestore and Storage
- grants the IAM roles
- registers the iOS and web apps and writes `GoogleService-Info.plist` and `web/.env.local`
- deploys

It's safe to re-run. You still sign the BAA, upload the APNs key, turn on MFA and enable audit logs yourself.

### Manual steps

1. **Create the project.** Make a GCP project (e.g. `auraconnect-prod`) under an organization and add Firebase to it. Update `.firebaserc`.
2. **Sign Google Cloud's BAA** (Console → IAM & Admin → Legal/Compliance). Use only covered products for PHI.
3. **Upgrade Firebase Auth to Identity Platform** (Firebase console → Authentication → Settings):
   - Enable email/password.
   - Turn on **MFA** (TOTP or SMS).
   - Configure SAML/OIDC providers for agencies that use SSO.
4. **Enable the APIs:** Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Cloud Scheduler, **Cloud Tasks**, **Vertex AI** (`aiplatform.googleapis.com`), Firestore, Cloud Storage, FCM.
5. **Create Firestore** in native mode, in a US region (e.g. `nam5`), and set up the default Storage bucket.
6. **Grant IAM:**
   - The Functions runtime service account needs `roles/aiplatform.user`, `roles/cloudtasks.enqueuer` and `roles/iam.serviceAccountTokenCreator`, plus `roles/firebaseauth.admin` (usually granted already).
   - Before enabling Vertex AI calls, confirm the Gemini model you picked is available in `VERTEX_LOCATION`.
7. **Set function params.** When you deploy, answer the prompts, or set them in `functions/.env.<projectId>`:
   - `GEMINI_MODEL` (default `gemini-2.5-flash`)
   - `VERTEX_LOCATION` (default `us-central1`)
   - `INVITE_REQUIRE_VERIFIED_EMAIL` (default `true`; set it to false only for tenants that sign in with SSO only)
   - `FIRESTORE_TRIGGER_REGION` / `STORAGE_TRIGGER_REGION` (default `us-central1`): must match the Firestore database and Storage bucket regions. A `nam5` database maps to `us-central1`. `gcp-setup.sh` detects both.
8. **Set up push:**
   - Create an APNs Auth Key (.p8) in the Apple Developer portal.
   - Upload it in Firebase console → Project settings → Cloud Messaging.
   - For critical alerts that bypass mute and Do Not Disturb, apply for the **Critical Alerts entitlement** from Apple. After approval, add `com.apple.developer.usernotifications.critical-alerts` to the entitlements and set `AppConfig.criticalAlertsEnabled = true`.
9. **Turn on audit logging.** Enable Cloud Audit Logs → Data Access (read and write) for Firestore and Cloud Storage. Set log retention to meet your policy (HIPAA documentation retention is 6 years). Route logs to a locked bucket.
10. **Deploy:**
    ```bash
    cd web && npm run build && cd ..
    firebase deploy --only firestore,storage,functions,hosting
    ```
11. **Bootstrap.**
    - Sign in to the web console, create the organization, and invite staff.
    - Set up on-call roles, shifts, and the default escalation policy.

## 3. Inviting your team
1. **Invite.** In the web console, open **Members → Invite a member**. Enter the email, name, role and discipline. Firebase emails the person a sign-in link: a **Firebase Auth email-link** message with no PHI, sent by Firebase itself. **Resend email** is on the pending-invites list.
   - iOS admins can invite from **More → Members**. The share sheet opens with a message to text or email.
2. **Accept.** The invitee opens the link. It confirms their email (which also verifies it) and asks them to set a password for the iOS app. Then they tap **Accept** on the welcome screen.
3. **Prerequisites** (`gcp-setup.sh` does the first one):
   - **Authentication → Sign-in method → Email/Password → Email link (passwordless sign-in)** is on.
   - The console's domain is listed under **Authentication → Settings → Authorized domains**. `localhost` and `<project>.web.app` are included by default.
   - Optionally, edit the email text under **Authentication → Templates**.
4. **Expiry and revocation.** Invites expire 14 days after they're sent. **Resend** on the pending-invites list sends the invite again and restarts the 14 days. **Revoke** cancels an invite so its link can no longer be used to join.
5. **Accounts that already existed.** If someone already had an account for the invitee's email (for example, they self-registered with a password), the invite link makes the invitee choose a new password. There's no Skip, so the old password stops working.
6. **Disabling self sign-up (recommended once your organization exists).** The web sign-up screen tells people to ask their administrator for an invite. Only someone starting a new organization creates an account themselves; `createOrg` stays open for them. To enforce this server-side, open **Identity Platform → Settings → User actions** in the Google Cloud console.
   - **Simplest:** clear **Enable create (sign-up)**. Clients can then no longer create accounts, including through a first email-link sign-in. An administrator has to create each invitee's account first: Firebase console → **Authentication → Add user**, or the Admin SDK. The invite link then signs them in. New organizations are set up by your platform operator.
   - **Invite-only alternative:** keep sign-up enabled and deploy a `beforeUserCreated` blocking function. It should allow an account only when a pending, unexpired invite exists for that email (a collection-group query on `invites`), plus any bootstrap emails you allow-list. AuraConnect doesn't ship this function; add it if you need self-service onboarding with enforcement.

## 4. Test accounts for manual testing
`scripts/test-accounts.ts` creates one login per role and discipline: TestAdmin, TestDON, TestRN, TestOnCallRN, TestLPN, TestAide, TestMD, TestNP, TestSW, TestChaplain, TestIntake, TestScheduler, TestBereavement, TestVolCoord, TestVolunteer, TestQA and TestViewer.
- Each signs in as `<username lowercase>@auraconnect.test` (e.g. `testrn@auraconnect.test`). Accounts are created pre-verified.
- The shared password defaults to `test1234`, because Firebase requires at least 6 characters. Change it with `--password`.
```bash
cd scripts && npm install
gcloud auth application-default login
npx tsx test-accounts.ts --project YOUR_PROJECT_ID --yes            # add --org <orgId> if there are several orgs
npx tsx test-accounts.ts --project YOUR_PROJECT_ID --delete --yes   # remove them all
```
Re-running the script resets each account's password, role and capabilities. **Delete these accounts before any real PHI is entered.**

## 5. Security checklist before real PHI
- [ ] Test accounts removed (`test-accounts.ts --delete`).
- [ ] BAA signed. Every vendor that touches PHI is covered.
- [ ] MFA required for all users. Session and app-lock timeouts agreed with compliance.
- [ ] Self sign-up disabled or invite-only in Identity Platform (section 3, step 6).
- [ ] Firestore and Storage rules deployed. `tests/rules` pass in CI.
- [ ] Clinical/compliance staff have checked the milestone rules in `functions/src/domain/milestones.ts`.
- [ ] Data Access audit logs on. Log sinks exclude message bodies.
- [ ] Pen test done. Incident-response and breach-notification runbooks written.
- [ ] iOS MDM/AppConfig policy defined for agency-owned devices.
