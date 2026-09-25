# AuraConnect

AuraConnect is secure clinical messaging and collaboration for **hospice** teams. It runs on Firebase and Google Cloud.

- **Messaging:** direct, group, team and patient care-team channels, with read receipts, priorities and attachments.
- **Alerts:** urgent and critical alerts with **automatic escalation** based on the on-call schedule.
- **Scheduling:** on-call scheduling and **message-the-role** routing (e.g. "On-call RN – North").
- **Referral intake:** scan a referral, then **Gemini on Vertex AI** extracts the data, and a person reviews it and accepts the referral.
- **Onboarding:** a patient onboarding wizard that computes hospice milestones: the NOE deadline, benefit periods, F2F windows and HOPE timing. A daily job sends deadline reminders.
- **Admin console:** members, teams, schedules, escalation policies, patients, referral queue, alerts and the audit log.

| Component | Path | Stack |
|---|---|---|
| iOS app | [`ios/`](ios/README.md) | SwiftUI, iOS 17, Firebase iOS SDK |
| Web console | [`web/`](web/README.md) | Vite, React, TypeScript |
| Backend | [`functions/`](functions/) | Cloud Functions 2nd gen, TypeScript |
| Security rules | `firestore.rules`, `storage.rules`, [`tests/rules/`](tests/rules/) | |

Docs:
- [Architecture](docs/ARCHITECTURE.md)
- [Data model and API contract](docs/DATA_MODEL.md)
- [Setup, deployment and HIPAA checklist](docs/SETUP.md)

## Quick start (local emulators)
```bash
(cd functions && npm install && npm run build)
firebase emulators:start --project demo-auraconnect
(cd scripts && npm install && npm run seed)
(cd web && npm install && cp .env.example .env.local && npm run dev)
```
