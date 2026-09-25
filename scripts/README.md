# scripts

`npm install && npm run seed` seeds the **local emulators** with the demo org "Sunrise Hospice (Demo)": six users (`admin@`, `rn@`, `md@`, `sw@`, `chaplain@`, `intake@demo.test`, password `password123`), a team, on-call roles, this week's shifts, an escalation policy, two fictitious patients, channels, and an open alert.
Start the emulators from the repo root first (`firebase emulators:start`), then run `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run seed`. You can also use `firebase emulators:exec --only firestore,auth "npm --prefix scripts run seed"`, which sets both variables for you.
The script won't run unless both emulator variables are set, and it only uses project `demo-auraconnect`. Running it again overwrites the same documents.
`npm run typecheck` checks the seed data against `functions/src/shared/types.ts`.
