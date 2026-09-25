# AuraConnect architecture

AuraConnect is a secure clinical messaging and collaboration platform for **hospice** teams, similar to TigerConnect. This repo covers Phase 1 and Phase 2 of the roadmap:
- **Phase 1:** identity and org/role model, direct and group messaging, patient care-team channels, PHI-free push notifications, audit log, admin console.
- **Phase 2:** referral scan with AI extraction (Gemini on Vertex AI), the patient onboarding wizard with hospice milestones, on-call scheduling with role-based routing, escalating alerts.

## System overview

```
 ┌───────────────┐      ┌──────────────────┐
 │  iOS app      │      │  Web console     │   Vite + React (Firebase Hosting)
 │  SwiftUI      │      │  admins, intake  │
 └──────┬────────┘      └────────┬─────────┘
        │ Firebase SDKs (Auth, Firestore, Functions, Storage, Messaging)
        ▼                        ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Identity Platform: email/password, MFA, SAML/OIDC SSO          │
 │ custom claims {orgId, role}                                     │
 ├────────────────────────────────────────────────────────────────┤
 │ Cloud Firestore: orgs/{orgId}/… (realtime, offline cache)       │
 │ Cloud Storage: referral PDFs and message attachments            │
 ├────────────────────────────────────────────────────────────────┤
 │ Cloud Functions (2nd gen, Node 22, us-central1)                │
 │  • callables: org, invites, channels, role messages, alerts,   │
 │               admissions, referral review                      │
 │  • triggers:  onMessageCreated → push + alert                  │
 │               onAlertCreated → Cloud Tasks escalation          │
 │               onReferralUploaded → Gemini extraction           │
 │               onMemberWritten → custom claims                  │
 │  • scheduled: checkDeadlines (NOE, recert, F2F, HOPE)          │
 ├────────────────────────────────────────────────────────────────┤
 │ Cloud Tasks (escalation timers) · Vertex AI Gemini ·            │
 │ FCM → APNs (payloads carry IDs only, never PHI)                 │
 └────────────────────────────────────────────────────────────────┘
```

## Repository layout
| Path | Contents |
|---|---|
| `functions/` | Cloud Functions (TypeScript). `src/shared/types.ts` is the data contract. `src/domain/` holds pure, unit-tested hospice logic: milestones, escalation, role routing |
| `firestore.rules`, `storage.rules`, `firestore.indexes.json` | Security rules and indexes. Tests are in `tests/rules/` |
| `web/` | Admin and intake console |
| `ios/` | SwiftUI app (XcodeGen `project.yml`) |
| `scripts/` | Seed script for the emulator |
| `docs/` | This file, [DATA_MODEL.md](DATA_MODEL.md) (contract and access matrix), [SETUP.md](SETUP.md) (GCP and HIPAA setup) |

## Key design decisions
- **Firestore for everything in the MVP.** It gives realtime sync and offline support for messaging, and keeps the whole stack emulator-testable. Relational reporting can come later by exporting to BigQuery.
- **Clients write messages directly** for instant send and offline queueing, under strict rules (sender identity, server timestamp, create-only). Everything with side effects or cross-document invariants goes through callables: channel membership, admissions, alerts, referral acceptance. That keeps an audit trail and validation on the server.
- **Custom claims** (`orgId`, `role`) are the main authorization gate. They're synced from `members/{uid}` by a trigger.
- **Escalation runs on Cloud Tasks**, not polling. Each alert level enqueues one delayed task. The task handler is idempotent (it checks `expectedLevel` and `status`).
- **Hospice rules** (NOE 5-day deadline, 90/90/60 benefit periods, F2F before period 3+, HOPE admission/HUV windows) live in pure functions so compliance staff can review them and tests pin them down. **Clinical and compliance staff must check these rules before production.**
- **AI stays human-in-the-loop.** Gemini's extraction always lands in `needs_review`. A person confirms every field, and low-confidence fields are highlighted, before a patient record is created.

## HIPAA posture
- **Only BAA-covered Google Cloud services handle PHI:** Firestore, Cloud Functions/Run, Cloud Storage, Identity Platform, Vertex AI, Cloud Tasks, Cloud Logging. Check against Google's current "HIPAA covered products" list.
- **Push notifications contain no PHI.** They carry generic text plus IDs, and the app fetches content after authenticating.
- **Not used:** Firebase Analytics, Crashlytics, Remote Config or Dynamic Links.
- **Encryption:** at rest via Google-managed keys (CMEK optional). On iOS, `NSFileProtectionComplete` covers the Firestore cache, with a Face ID app lock and a privacy blur in the app switcher.
- **Audit trail:** functions write `auditLogs` for PHI-affecting actions. Enable Cloud Audit Logs "Data Access" for Firestore and Storage as well (see SETUP.md).
- **Least privilege:** rules deny by default, and viewers are read-only.

## Roadmap (beyond this build)
- **Phase 3:**
  - voice and video calls (CallKit/PushKit + WebRTC provider under a BAA)
  - family/caregiver access
  - EHR integration through Redox (WellSky, HCHB, Axxess)
  - AI summaries and shift handoffs
- **Phase 4:** analytics, SOC 2 / HITRUST, Android.
