# AuraConnect web admin console

Vite + React 18 + TypeScript console for AuraConnect org admins, clinicians and intake coordinators.
Firestore/callable contracts come from `../functions/src/shared/types.ts` via the `@shared/*` alias
(type-only imports) and `../docs/DATA_MODEL.md`.

## Setup

```bash
cd web
cp .env.example .env.local   # fill in your Firebase web app config
npm install
npm run dev                  # http://localhost:5173
```

Scripts: `dev`, `build` (typecheck + production bundle in `dist/`), `preview`, `typecheck`.

## Environment variables

| Variable | Description |
|---|---|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` | Firebase web app config |
| `VITE_USE_EMULATORS` | `true` to use local emulators |
| `VITE_FIREBASE_VAPID_KEY` | Optional. Web Push certificate public key for browser notifications (see [Web push](#web-push)). Empty = web push is hidden |

Callable functions are called in `us-central1`. Firebase Analytics is intentionally not used (HIPAA).

## Web push

Browser notifications use Firebase Cloud Messaging (v4). They are opt-in: the user clicks
**Enable notifications** on *My notifications* (`/notifications`); nothing is requested on page load.

1. **Create the VAPID key.** Firebase console → Project settings → **Cloud Messaging** → *Web configuration* →
   **Web Push certificates** → **Generate key pair** (or import an existing pair). Copy the **public** key
   (it starts with `B…`, about 87 characters).
2. Put it in `web/.env.local` as `VITE_FIREBASE_VAPID_KEY=<public key>` and rebuild (`npm run build`) and redeploy.
   The key is public; the private half stays in Firebase.
3. **Service worker.** `public/firebase-messaging-sw.js` is copied to the site root (`/firebase-messaging-sw.js`)
   by Vite. It loads the Firebase **compat** SDK from `www.gstatic.com`, pinned to the `firebase` version in
   `package.json` (currently `11.10.0`; update `FIREBASE_VERSION` in the worker when you upgrade the package).
   The app registers it with its web config in the query string and the scope
   `/firebase-cloud-messaging-push-scope`, so no project values are hard-coded in the worker. It must be served
   from the site root over HTTPS (or `localhost`); Firebase Hosting does this with the existing config.
4. The token is added to `members/{uid}.fcmTokens` with `arrayUnion` (the member self-update path; at most 20
   tokens, the oldest are dropped when full). *Turn off on this browser* deletes the token and removes it.

Pushes carry only the generic text ("New message", "Urgent message", …), never message text or patient data.
Background pushes are shown by the service worker; while the app is open they appear as an in-app toast.
Clicking a notification opens the conversation or the Alerts page.

## Messaging (v4)

- **Templates**: type `/` at the start of the composer or click *Templates*. Org templates (`messageTemplates`,
  managed by admins at `/templates`, with *Seed defaults*) and personal ones (`members/{uid}/templates`,
  *Save as template* in the composer). Placeholders `{{patient}}`, `{{patientFirst}}`, `{{codeStatus}}`,
  `{{caregiver}}`, `{{caregiverPhone}}`, `{{me}}`, `{{myDiscipline}}`, `{{time}}`, `{{date}}` and the template's
  own fields are filled in the browser; the message is sent with a `[[tpl:{id}]]` prefix that the backend strips.
- **@mentions** (`@Display Name` / `@role-key`), **quick replies** on urgent messages and alerts, **reactions**,
  **edit** (15 minutes), **pins**, **channel details** panel, **read receipts** ("Read by N of M", nudge),
  **remind me if no reply**, **ack-required broadcasts** with a CSV report.
- **Per-conversation notifications** (header bell menu) write `channels/{cid}/prefs/{uid}`;
  status, out of office and quiet hours live on *My notifications*. **Directory** at `/directory`.

## Emulators

Start the emulators from the repo root (`firebase emulators:start`) and set `VITE_USE_EMULATORS=true`.
The app connects to Auth `localhost:9099`, Firestore `8080`, Functions `5001` and Storage `9199`.
`VITE_FIREBASE_PROJECT_ID` must match the emulator project id (e.g. `demo-auraconnect`).

## Required Firestore composite indexes

- `alerts`: `targetUids` (array-contains) + `createdAt` desc — Alerts page for non-admins / "Targeting me"
- `channels`: `memberUids` (array-contains) + `lastMessageAt` desc — Messages channel list

The dashboard uses `alerts`: `targetUids` (array-contains) + `status` + `createdAt` desc.

## Notes

- Don't log PHI: the app never writes patient or message data to the console.
- Pages: Dashboard, Messages, Alerts, Directory, Message templates, My notifications, Patients (list/detail/admit wizard), Referrals (upload/review),
  On-call schedule, and admin-only Members, Teams, Escalation policies and Audit log.
