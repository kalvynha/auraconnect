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

Callable functions are called in `us-central1`. Firebase Analytics is intentionally not used (HIPAA).

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
- Pages: Dashboard, Messages, Alerts, Patients (list/detail/admit wizard), Referrals (upload/review),
  On-call schedule, and admin-only Members, Teams, Escalation policies and Audit log.
