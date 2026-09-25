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

## 3. Security checklist before real PHI
- [ ] BAA signed. Every vendor that touches PHI is covered.
- [ ] MFA required for all users. Session and app-lock timeouts agreed with compliance.
- [ ] Firestore and Storage rules deployed. `tests/rules` pass in CI.
- [ ] Clinical/compliance staff have checked the milestone rules in `functions/src/domain/milestones.ts`.
- [ ] Data Access audit logs on. Log sinks exclude message bodies.
- [ ] Pen test done. Incident-response and breach-notification runbooks written.
- [ ] iOS MDM/AppConfig policy defined for agency-owned devices.
