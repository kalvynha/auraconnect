# AuraConnect data model and API contract

The TypeScript source of truth is [`functions/src/shared/types.ts`](../functions/src/shared/types.ts). This page covers two things the types can't show:
- **Access:** who can read and write each collection.
- **Server-side behavior:** which Cloud Function does what.

All client apps (iOS, web) must follow these rules.

## Identity
- Auth runs on Firebase Auth, upgraded to Identity Platform for MFA, SAML and OIDC.
- Every org member has **custom claims** `{ orgId, role }`. Cloud Functions set these; clients never do.
  - After `createOrg` or `acceptInvite`, the client must force-refresh its ID token (`getIdToken(true)`) to pick up the claims.
- `userOrgs/{uid}` holds `{ orgId, role }`, readable by that user only. Clients use it at launch to find their org, and to tell "no org yet" (onboarding) apart from "claims not refreshed yet".
- Roles:
  - `admin`: manages people, teams, schedules, policies; sees the audit log and all alerts.
  - `clinician`: messaging, patients, referrals, alerts.
  - `intake`: referrals and admissions, messaging.
  - `viewer`: read-only on patients and their own channels.

## Collections (`orgs/{orgId}/…`)

| Path | Read | Client write | Server behavior |
|---|---|---|---|
| `orgs/{orgId}` | members | admin (name, timezone, deadlineLeadDays, defaultEscalationPolicyId) | `createOrg` creates it |
| `members/{uid}` | members | admin (any field). Self: `fcmTokens`, `displayName`, `phone`, `title` only | `onMemberWritten` syncs the role and active flag into claims |
| `invites/{id}` | admin | none | `inviteMember`, `acceptInvite` |
| `teams/{id}` | members | admin | none |
| `onCallRoles/{roleKey}` | members | admin | none |
| `shifts/{id}` | members | admin | used by role routing |
| `escalationPolicies/{id}` | members | admin | used by the escalation engine |
| `channels/{id}` | channel members | none | `createChannel`, `updateChannelMembers`, `admitPatient` create it. `lastMessage`/`lastMessageAt` are set by `onMessageCreated` |
| `channels/{id}/messages/{id}` | channel members | **create** only, by a channel member, with `senderUid == auth.uid`, `createdAt == request.time`, `alertId == null`, body ≤ 8000 chars. No update or delete | `onMessageCreated`: updates `lastMessage`, sends PHI-free push, and raises an alert when priority ≥ urgent |
| `channels/{id}/reads/{uid}` | channel members | self (`lastReadAt`) | none |
| `alerts/{id}` | `auth.uid in targetUids`, or admin | none | `createAlert`, `ackAlert`, `resolveAlert`, escalation tasks |
| `patients/{id}` | members | none | `admitPatient`, `acceptReferral`. `checkDeadlines` updates `remindedMilestones` |
| `referrals/{id}` | admin, clinician, intake | **create** only, by admin, clinician or intake, with `status == 'uploaded'` and `uploadedBy == auth.uid` | the storage trigger extracts. `acceptReferral`, `rejectReferral` and `retryReferralExtraction` handle review |
| `auditLogs/{id}` | admin | none | written by functions |

### Storage
| Path | Access |
|---|---|
| `orgs/{orgId}/referrals/{referralId}/{file}` | read/write for admin, clinician and intake in that org. PDF or image only, ≤ 25 MB |
| `orgs/{orgId}/channels/{channelId}/attachments/{file}` | read/write for channel members. ≤ 25 MB |

## Messaging flow
1. **Send.** The client writes a `Message` straight to Firestore, so it works offline and appears instantly:
   ```
   { senderUid, senderName, body, priority, attachments: [], roleTarget: null,
     createdAt: serverTimestamp(), alertId: null }
   ```
2. **Update and push.** `onMessageCreated` updates the channel's `lastMessage` and sends FCM to the other members' `fcmTokens`. The push carries notification text `"New message"` / `"Urgent message"` / `"Critical message"` and data `PushData`. **No message text or patient data goes in the push.**
3. **Escalate urgent messages.** If `priority` is `urgent` or `critical`, it creates an `Alert` (source `message`) targeting the other channel members. The org's default escalation policy applies, and the message's `alertId` is set.
4. **Direct channels** have id `dm_{minUid}_{maxUid}`. `createChannel` with `type: 'direct'` is idempotent.
5. **Unread counts:** a channel is unread when `channel.lastMessageAt > reads/{uid}.lastReadAt` (and the last sender isn't you).
6. **Messaging a role** (e.g. "on-call RN North") uses the `sendRoleMessage` callable:
   - it resolves who is on duty from `shifts`, falling back to `onCallRoles.fallbackUids`
   - it reuses or creates a direct or group channel with them
   - it writes the message with `roleTarget` set

## Alerts and escalation
- **Levels map to policy steps.** Level `i` means `steps[i]`: step `i`'s target is notified, the alert then waits `steps[i].waitMinutes`, and moves to level `i + 1`.
  - At creation, level 0 notifies the explicit targets plus `steps[0].target`.
  - Step targets: `role` is whoever is on call right now, `uid` is a specific person, `original` is the first recipients.
- **Each level schedules one Cloud Task.**
  - When it fires, the payload's `{orgId, alertId, expectedLevel}` is checked. It does nothing if the alert isn't `open` or the level has already moved on.
  - Task ids are fixed per level, so enqueuing the same task twice is ignored.
  - Newly notified people are added to `targetUids` and the step is appended to `history`.
- **When the last step's wait runs out** with no ack, the alert is marked `exhausted: true`.
- **Acknowledge and resolve:**
  - `ackAlert` sets `status: 'acked'`, which stops escalation. Only someone in `targetUids`, or an admin, can acknowledge. Acking twice does nothing.
  - `resolveAlert` sets `status: 'resolved'` (and sets `ackedBy` if nobody had acknowledged yet).
- **Urgent and critical messages send a single alert push.** The data is `{type:'alert', orgId, alertId, channelId, priority}`, and clients open the channel when `channelId` is present. This push replaces the normal message push. The alert id is `msg_{channelId}_{messageId}`, so a retried trigger can't create a second alert.
- **Actions with no human actor** (escalation, deadlines, extraction) record `'system'` as `createdBy` / `actorUid`.
- **Push levels:**
  - `critical` uses the APNs `critical` interruption level with critical sound. This needs Apple's Critical Alerts entitlement; without it, iOS treats the alert as time-sensitive.
  - `urgent` uses `time-sensitive`.
  - `normal` uses `active`.

## Patient onboarding and milestones
- **`admitPatient`:**
  1. creates or updates the patient with `status: 'admitted'`
  2. computes `milestones`
  3. creates a `patient` channel named `"{Last}, {First} – Care Team"` whose members are the care team plus the caller
  4. writes an audit entry
- **Milestone rules** (in `functions/src/domain/milestones.ts`, admission date = election date = day 1):
  - **NOE** is due by admission + 5 calendar days.
  - **Benefit periods:** periods 1 and 2 are 90 days; period 3 and later are 60 days. When `startingBenefitPeriod > 1`, the first computed period uses that number's length.
  - **F2F** is required for period ≥ 3. The window is the 30 days before the period starts; due by the day before the period starts.
  - **HOPE:** the admission assessment is due by day 5. HUV1 falls on days 6–15 and HUV2 on days 16–30.
  - These rules follow CMS hospice regulations as understood at build time. **Compliance staff must check them.**
- **`checkDeadlines`** runs hourly and only handles orgs whose local hour is 07, so each org is checked once a day at 07:00 its own time:
  - For each admitted patient, it raises a `deadline` alert to the care team for any NOE, recert (period end), F2F or HOPE milestone due within `deadlineLeadDays` or overdue.
  - It skips keys already in `remindedMilestones`.
  - Overdue milestones raise `urgent` alerts, upcoming ones `normal`. The patient's name appears only in the alert body in Firestore, never in a push.
  - If the patient has no active care team, the alert goes to the org's admins.

## Referral scan and AI extraction
1. **Create the record.** The client creates `referrals/{id}` with `status: 'uploaded'`, `storagePath: orgs/{orgId}/referrals/{id}/{fileName}` and the remaining fields set to null. It then uploads the file.
   - iOS builds a PDF from the VisionKit scan; web uploads a PDF or image.
2. **Extract.** `onReferralUploaded`:
   1. sets `extracting`
   2. sends the file to **Gemini on Vertex AI** (`GEMINI_MODEL`, default `gemini-2.5-flash`) with a JSON response schema that matches `ReferralExtraction`
   3. normalizes the result, sets `extracted`, `model`, `status: 'needs_review'`
   - On error it sets `status: 'failed'` and `error`.
3. **Review.** A person reviews and edits the fields in the app. Fields with `fieldConfidence < 0.7` must be highlighted.
4. **Accept.** `acceptReferral({ patient })` (allowed from `needs_review` or `failed`; calling it again returns the same patient) creates a `referral`-status patient and links `patientId`. The onboarding wizard then calls `admitPatient({ patientId, … })`.
5. **Reject or retry.** `rejectReferral` and `retryReferralExtraction` are also available.

## Callable functions
All are HTTPS callables in `us-central1`. Each takes `orgId` and checks it against the caller's claims.

| Name | Who | Request → Response |
|---|---|---|
| `createOrg` | any signed-in user without an org | `CreateOrgRequest → CreateOrgResponse` |
| `inviteMember` | admin | `InviteMemberRequest → InviteMemberResponse` |
| `acceptInvite` | invitee (email must match and be **verified**; `INVITE_REQUIRE_VERIFIED_EMAIL` param, default true) | `AcceptInviteRequest → AcceptInviteResponse` |
| `listMyInvites` | signed-in user | `{} → ListMyInvitesResponse` |
| `createChannel` | member (not viewer) | `CreateChannelRequest → CreateChannelResponse` |
| `updateChannelMembers` | channel member (not viewer) | `UpdateChannelMembersRequest → {}` |
| `sendRoleMessage` | member (not viewer) | `SendRoleMessageRequest → SendRoleMessageResponse` |
| `createAlert` | member (not viewer) | `CreateAlertRequest → CreateAlertResponse` |
| `ackAlert` / `resolveAlert` | target or admin | `AlertActionRequest → {}` |
| `admitPatient` | admin, clinician, intake | `AdmitPatientRequest → AdmitPatientResponse` |
| `acceptReferral` | admin, clinician, intake | `AcceptReferralRequest → AcceptReferralResponse` |
| `rejectReferral` | admin, clinician, intake | `RejectReferralRequest → {}` |
| `retryReferralExtraction` | admin, clinician, intake | `RetryReferralRequest → {}` |

---

# v2: care workflows, coordination, messaging extras, dashboards

The types are in `functions/src/shared/types.ts` under the "v2" sections. All new fields on existing documents are **optional when read**, and clients must apply the defaults in `ORG_SETTING_DEFAULTS`. Unless stated otherwise, new collections are **written only by Cloud Functions**, which record an audit entry for each write. "Clinical" below means the roles admin, clinician and intake.

## Access (new collections under `orgs/{orgId}/…`)
| Path | Read | Client write |
|---|---|---|
| `patients/{id}/events/{id}` | members | none |
| `patients/{id}/documents/{id}` | members | **create** by a clinical role with the exact `PatientDocument` shape: `uploadedBy == auth.uid`, `createdAt == request.time`, `storagePath == orgs/{orgId}/patients/{pid}/documents/{docId}/{fileName}`, `fileName` a single path segment. No update or delete |
| `visits/{id}` | members | none |
| `tasks/{id}` | members | none |
| `taskTemplates/{event}` | members | none (edited with `saveTaskTemplate`, admin only) |
| `bereavementPlans/{id}` | members | none |
| `idgMeetings/{id}` | members | none |
| `triageCalls/{id}` | members | none |
| `metrics/{date}` | admin | none |
| `volunteerAssignments/{id}` | members | admin: create, update, delete (exact shape) |
| `volunteerLogs/{id}` | admin, or the volunteer whose uid is on the log | **create** by any active member for themselves: `volunteerUid == auth.uid`, `createdAt == request.time`, minutes 1–1440. No update or delete |

Changes to existing collections:
- **Org doc:** admins may also update `triageRoleKey`, `idgCadenceDays` (1–30), `missedVisitGraceMinutes` (15–1440) and `messageLifespanDays` (null or 7–3650).
- **Message create:** the same 8 fields as before, plus an **optional** `threadParentId` (a string or null). Nothing else is allowed.
- **Broadcast channels:** in a channel with `type == 'broadcast'`, only `channel.createdBy` may create messages.
- **New Storage path:** `orgs/{orgId}/patients/{pid}/documents/{docId}/{file}`.
  - Read: org members.
  - Create: clinical roles only. PDF or image, under 25 MB. No update or delete.

## Behavior
- **Milestones.**
  - The milestone key is `{kind}:{dueDate}`. `upcomingDeadlines` returns the keys; recert uses the period end date, F2F uses its due-by date.
  - `completeMilestone` sets `milestoneCompletions[key]`. `reopenMilestone` deletes it.
  - `checkDeadlines` skips any completed key.
  - "On time" means `completedAt` ≤ the due date, compared in the org's time zone.
- **Level of care.** `changeLevelOfCare` updates `levelOfCare` and appends a `level_of_care_change` event.
- **Recertification.** `recordRecertification`:
  1. Validates the period number.
  2. Requires `f2fDate` when the period has `f2fRequired`.
  3. Completes the `recert` key for the *previous* period end, and the `f2f` key if one exists.
  4. Appends a `recertification` event.
  5. Instantiates the `recertification` task template.
- **Discharge.** `dischargePatient`:
  1. Sets status `discharged`, `dischargeDate` and `dischargeReason`.
  2. Archives the patient channel (`archived: true`); archived channels accept no new messages.
  3. Cancels future scheduled visits and open tasks for the patient.
  4. Appends a `discharge` event and instantiates the `discharge` template.
- **Death.** `recordDeath`:
  1. Sets status `deceased` and `death`.
  2. Archives the channel.
  3. Cancels future visits and open tasks.
  4. Appends a `death` event and instantiates the `death` template.
  5. Creates a **bereavement plan**, which closes 13 months after the date of death. The default contacts are:
     - a condolence call at day 3
     - a sympathy letter at day 7
     - letters at months 1, 2, 3, 6 and 9
     - a pre-anniversary call at month 11
     - an anniversary letter at month 12
     - a closing call at month 13
- **Admission.** `admitPatient` also:
  - appends an `admission` event
  - instantiates the `admission` template
  - sets `nextIdgDueDate` = admission + `idgCadenceDays`
- **Task templates.** When an org has no templates, these defaults apply:

  | Event | Items (discipline, days after the event) |
  |---|---|
  | admission | Comprehensive assessment (RN, 5), Medication reconciliation (RN, 1), DME needs review (RN, 2), Social work assessment (SW, 5), Spiritual assessment (Chaplain, 5), Initial plan of care (MD, 5) |
  | recertification | Update plan of care (RN, 0), Physician narrative (MD, 0) |
  | discharge | Discharge summary (RN, 2), Notify attending physician (RN, 1), Coordinate DME pickup (SW, 3) |
  | death | Notify attending physician (RN, 0), Coordinate DME pickup (SW, 2), Medication disposal documentation (RN, 1), Bereavement assessment (SW, 7), Death summary (RN, 2) |

  A templated task goes to the care-team member with the matching discipline, otherwise it stays unassigned. Its due date is the event date plus the offset.
- **Visits.**
  - Only an assignee, the patient's care team, or an admin may complete, cancel or update a visit.
  - `checkMissedVisits` runs every 30 minutes. It marks scheduled visits `missed` once `scheduledEnd` is more than `missedVisitGraceMinutes` in the past, then raises a `visit_missed` alert (normal priority) to the assignee (or the care team) and to admins.
- **Tasks.** The creator, the assignee, the patient's care team or an admin may update a task. Completing it sets `completedAt` and `completedBy`.
- **IDG meetings.**
  - `createIdgMeeting` with no `patientIds` fills the agenda with admitted patients whose `nextIdgDueDate` ≤ `scheduledAt` + 7 days.
  - `saveIdgNote` is allowed for attendees, care team members and admins.
  - `completeIdgMeeting` does the following for every patient whose note is `reviewed`:
    - sets `lastIdgReviewDate` to the meeting date and `nextIdgDueDate` to that date + cadence
    - creates tasks for each action item (source `idg`)
    - locks the meeting
  - `generateIdgPrep` uses Gemini. For each patient it builds a summary from the last 15 days of events, visits, tasks, triage calls and patient-channel messages, then stores it in `aiPrep[patientId]`.
- **Triage.** `logTriageCall` creates the call and resolves who is on call now from `roleKey` or `org.triageRoleKey` (or uses `assignedUid`).
  - For `urgent`/`emergent` calls it raises an alert (source `triage`; priority `urgent`/`critical`) with the default escalation policy.
  - `resolveTriageCall` sets the disposition, resolves the linked alert, and can create a follow-up task.
- **Recall.** `recallMessage` is allowed for the sender or an admin.
  - It sets `recalledAt`, empties `body` and `attachments`, and deletes the attachment files.
  - If the recalled message is the channel's `lastMessage`, the preview changes to "Message recalled".
- **Threads.** `onMessageCreated` increments the parent's `replyCount` and sets its `lastReplyAt`.
  - Thread replies don't change the channel's `lastMessage` preview, but they do trigger push notifications.
- **Search.** `searchMessages` does a case-insensitive substring match over the caller's non-archived channels.
  - It looks back 90 days, reads at most 300 messages per channel, and returns up to 50 hits.
  - Matches are not full-text search; the documentation says so.
- **Broadcast.** `sendBroadcast` resolves the recipients, creates a `broadcast` channel (members = recipients plus the sender) and posts the message.
- **AI.** `summarizeChannel` and `generateHandoff` return an `AiTextResult` and are never stored.
  - The handoff covers the caller's care-team patients: the last `sinceHours` (default 12) of messages, triage calls, visits, open tasks and due deadlines.
  - Every AI output carries a disclaimer and is audited, without its content.
- **Message lifespan.** When `messageLifespanDays` is set, `purgeExpiredMessages` runs daily and deletes older messages and their attachments.
- **Metrics.** `computeDailyMetrics` runs hourly and processes each org at 01:00 local time, writing `metrics/{yesterday}`. The `computeMetrics` callable (admin) computes today's metrics on demand and writes `metrics/{today}`.

## New callables
All are in `us-central1`. Requests and responses are the `*Request` types; create-style callables return `IdResponse`.
- **Milestones and lifecycle:** `completeMilestone`, `reopenMilestone`, `changeLevelOfCare`, `recordRecertification`, `dischargePatient`, `recordDeath`
- **Visits:** `setVisitFrequencies`, `scheduleVisit`, `updateVisit`, `completeVisit`, `cancelVisit`
- **Tasks:** `createTask`, `updateTask`, `saveTaskTemplate` (admin)
- **Bereavement:** `updateBereavementContact`, `updateBereavementPlan`
- **IDG:** `createIdgMeeting`, `updateIdgMeeting`, `saveIdgNote`, `completeIdgMeeting`, `generateIdgPrep`
- **Triage:** `logTriageCall` (returns `LogTriageCallResponse`), `assignTriageCall`, `resolveTriageCall`
- **Messaging:** `recallMessage`, `searchMessages`, `sendBroadcast`
- **AI:** `summarizeChannel`, `generateHandoff` (both return `AiTextResult`)
- **Metrics:** `computeMetrics` (admin)

Who can call these:
- Viewers can call only read-only callables (`searchMessages`, `summarizeChannel`, `generateHandoff`).
- Lifecycle, visit, IDG and triage mutations require a clinical role.

## v3 — bereavement and volunteers

Covers docs/PERSONA_REVIEW.md C1 and C2, plus security finding H4 for bereavement. The types are in the "v3 — bereavement workload (C1) and volunteer program (C2)" section of `functions/src/shared/types.ts`. New fields are optional when read.

### Bereavement
- **Who may change a plan (H4):**
  - admins and holders of the `bereavement` capability
  - any SW or Chaplain
  - the plan's coordinator (`assignedUid`)
  - Every bereavement callable checks this per plan (`canWorkBereavementPlan`); no role check is needed. Volunteers still cannot read plans, because the rules deny them.
- **Schedule:**
  - Every plan now also gets a `Risk reassessment (month 1)` contact, of the new type `assessment`.
  - A `high` risk level, at creation or on reassessment, adds:
    - `hr-d14-visit`: a social work visit at day 14
    - `hr-m1-call`, `hr-m2-call`, `hr-m3-call`: monthly calls
  - On reassessment, a high-risk contact whose natural date has already passed is due today instead. Contacts are sorted by due date.
- **Survivors:**
  - Each entry in `BereavementPlan.survivors[]` has `id, name, relationship, phone, email, address, preferredContact ('phone'|'mail'|'email'), doNotContact, isPrimary`.
  - `recordDeath` seeds them from the caregiver (id `primary`). `Caregiver` gains the optional `address` and `email`. A seeded survivor prefers mail if the caregiver has an address, otherwise email if there is one, otherwise phone.
  - Plans created before v3 fall back to `primaryContact`.
  - `updateBereavementPlan({survivors})` replaces the list:
    - at most 20 survivors, with at most one `isPrimary`
    - `email` is required when `preferredContact` is `email`
    - missing ids are assigned `s1`, `s2`, …
    - `primaryContact` is kept as a mirror of the primary survivor
- **Default coordinator:**
  - `recordDeath` assigns, in order:
    1. `bereavementAssigneeUid`
    2. `org.defaultBereavementCoordinatorUid`, if that member is active
    3. the care team's first SW
    4. nobody
  - The logic is in `functions/src/bereavement/coordinator.ts` (`resolveBereavementCoordinator`).
  - Admins set the setting on the org doc; the rules already allow a string of at most 128 characters, or null.
- **Callables:**

  | Name | Request → Response | Notes |
  |---|---|---|
  | `updateBereavementContact` | `UpdateBereavementContactRequest → {}` | now permission-checked per plan |
  | `updateBereavementContacts` | `UpdateBereavementContactsRequest → UpdateBereavementContactsResponse` | 1–200 `{planId, contactId}` items; one transaction and one audit entry per plan; per-item failures are returned, not thrown |
  | `updateBereavementPlan` | `UpdateBereavementPlanRequest → {}` | also takes `survivors`. A `riskLevel` change is recorded in `riskHistory` (and `high` adds contacts). Closing sets `closedAt`/`closedBy` and clears `needsReview` |
  | `reassessBereavementRisk` | `{planId, level, note} → {addedContactIds}` | appends `{level, previous, note, at, by, addedContactIds}` to `riskHistory`, and completes the earliest pending `assessment` contact with the note |
  | `exportBereavementMailing` | `{from, to (≤ 92 days), types = ['letter'], markDone} → {rows, contactCount, marked, truncated}` | details below |
- **Mailing export (`exportBereavementMailing`):**
  - It returns one row per pending contact of the given types due in [from, to], for each survivor who is not do-not-contact and whose `preferredContact` isn't `phone`.
  - Scope: admins, capability holders, SWs and chaplains get every active plan. Anyone else gets only the plans they coordinate.
  - `markDone` marks the exported contacts `done` (pending ones only; one transaction per plan).
  - Rows contain names and addresses. They go to the caller only and are never logged or audited.
- **Auto-close:**
  - `closeExpiredBereavementPlans` runs daily at 06:30 UTC, using each org's local today.
  - It reads only active plans with `closesOn < today`, using the index `(status, closesOn)`.
  - If every contact is done or skipped, the plan gets `status: 'closed'`, `closedBy: 'system'`.
  - Otherwise it sets `needsReview: true`, only once. The next run closes the plan after the remaining contacts are handled.
- **Audit actions:**
  - `bereavement.update` (with `via: 'bulk' | 'mailing'` in the metadata)
  - `bereavement.reassess`
  - `bereavement.mailing_export` (counts only)
  - `bereavement.close` (actor `system`)
  - Notes, names and addresses are never put in audit metadata.

### Volunteers
- **`patients.volunteerUids`:** the sorted uids of volunteers with an ACTIVE assignment for the patient.
  - `onVolunteerAssignmentWritten` (Firestore trigger on `volunteerAssignments/{id}`) recomputes it for the patient before and after each write. This covers creates, status changes, volunteer changes, patient moves and deletes; edits that only touch notes or dates are skipped.
  - The recomputation runs inside a transaction from the current assignments, so retries converge.
  - `backfillVolunteerUids({orgId})` (admin) recomputes every patient that has an active assignment or a non-empty array.
  - Both write the audit action `volunteer.sync`. Clients never write the field.
- **Logs:**
  - `VolunteerLog.enteredBy` is set when a coordinator (holder of the `volunteers` capability) logs time for someone else; the rules require it then.
  - `voidVolunteerLog({logId, reason})` (admin or `volunteers` capability) sets `voidedAt`, `voidedBy` and `voidReason`, once, audited as `volunteer.void`. Clients can't set `voided*`: the create rule lists every allowed key, and update/delete are denied.
  - Voided logs are excluded from daily metrics (`volunteers.minutesLast30d`) and from the 5% report.
- **5% report:** `volunteerComplianceReport({from, to})` needs admin, `reports` or `volunteers`. The range can be at most 366 days. It returns a `VolunteerComplianceReportResponse`: `ratio = volunteerMinutes / staffMinutes`, the `target` 0.05, and a breakdown by month.
  - **Staff minutes per calendar month:**
    - With an override at `staffHours/{YYYY-MM}.paidCareHours`, the override's hours × 60, prorated by the share of that month's days inside the range.
    - Otherwise, the sum of `scheduledEnd − scheduledStart` for visits completed in that part of the range, in org-local days. Each visit is capped at 24 h.
  - **Read caps:** 20k logs, and 10k visits per month; hitting a cap sets `truncated`.
  - Audited as `volunteer.report`.

### Access (new and changed)
| Path | Read | Client write |
|---|---|---|
| `staffHours/{YYYY-MM}` | admin or `reports` | admin or `reports`. Exact keys `{paidCareHours: number 0–100000, updatedBy: auth.uid, updatedAt: request.time}`; the id must be a valid `YYYY-MM`. Delete is allowed. `onStaffHoursWritten` audits each write as `volunteer.staff_hours` |
| `volunteerLogs/{id}` | unchanged | unchanged. `voided*` are function-only |

### Indexes
- `bereavementPlans (status ASC, deathDate DESC)`: active and closed lists, paged.
- `bereavementPlans (status ASC, assignedUid ASC, closesOn ASC)`: the mailing export for coordinators without all-plan access.
- `volunteerAssignments (status ASC, startDate ASC)`: backfill paging.
- Queries that reuse existing indexes:

  | Index | Used by |
  |---|---|
  | `bereavementPlans (status, closesOn)` | auto-close and the mailing export |
  | `visits (status, scheduledStart)` | the 5% report |
  | `volunteerLogs (volunteerUid, date DESC)` | "my logs" |
  | `patients (volunteerUids CONTAINS, …)` | volunteer patient lists |

### Clients
- **Web Bereavement:**
  - **Tabs:**
    - Active: one bounded live query of up to 1,000 plans, shown in a table with 25 rows per page and a detail drawer.
    - Closed: loaded from the server 100 at a time.
    - Mailings: pick a date range, preview, download a CSV, then "Mark N letters sent".
  - "Due this week" is a checkbox table with bulk done/skip.
  - The drawer has a survivor editor and risk reassessment.
  - Settings gains a "Default bereavement coordinator" card.
- **Web Volunteers:**
  - The page appears in the navigation for admins, holders of the `volunteers` capability, and Volunteer-discipline members.
  - Coordinators see:
    - the 5% report card, and the payroll override editor if they have `reports`
    - the roster (members with discipline Volunteer)
    - assignments, with "Load more"
    - "Log time for a volunteer" (sets `enteredBy`)
    - logs, with Void
  - Volunteers see only their own data: `volunteerAssignments where volunteerUid ==`, `patients where volunteerUids array-contains`, and `volunteerLogs where volunteerUid ==`.
- **iOS:**
  - Bereavement:
    - The list has "Select" plus bulk Mark done / Skip (`updateBereavementContacts`).
    - Closed plans are paged.
    - The plan detail shows the survivor list.
    - Edit controls follow the per-plan permission.
  - Volunteer guards (`OrgStore.isVolunteerMember`, `canReadStaffCollections`):
    - The Patients tab queries `volunteerUids arrayContains uid`.
    - Today, patient detail and More never subscribe to visits, tasks, triage, IDG or bereavement for volunteers. Nothing staff-only starts until the member doc has loaded.

## v3 — clinical safety and patient lifecycle

Covers S1, S2, S4, S5, O1, H4 and the deadline part of V1. Code lives in `functions/src/lifecycle/*`, `patients/checkDeadlines.ts` and `domain/milestones.ts`. **Compliance staff must still verify the CMS rules below.**

### Deadline reminders (S1, V1)
- **No look-back cap.** `upcomingDeadlines` returns every NOE, HOPE, recert (each period end) and F2F due on or before today + lead, including overdue ones, whatever their age. `MAX_OVERDUE_DAYS` is gone from reminders, patient views and metrics counts. A deadline stays overdue until it is completed.
- **Lead days per kind:**
  1. `org.deadlineLeadDaysByKind[kind]` (0–90; admin-editable; the rules already allow it)
  2. otherwise the default for that kind: NOE 3, recert 15, F2F 30, HOPE (admission, HUV1, HUV2) 2
  3. otherwise `deadlineLeadDays`
- **Two reminders per key at most:**

  | | Upcoming | Overdue |
  |---|---|---|
  | Reminder key (in `remindedMilestones`) | `{key}` | `{key}#overdue` |
  | Alert id | `dl_{patientId}_{key}` | `dl_{patientId}_{key}_overdue` (sanitized) |
  | Priority | `normal` | `urgent` |
  | Escalation | `policyId: null` | org default policy |

  - The overdue alert is raised even if the upcoming one was already sent. If a key is first seen when it's already overdue, only the overdue alert is raised.
- **Recipients:** active care-team members whose discipline is RN/NP/MD. If there are none, the org's admins.
- **Resolution:** completing a milestone (`completeMilestone`, or a key completed by `recordRecertification`) resolves that key's open deadline alerts.

### Milestone completion (S5, H4)
- `completeMilestone` requires `effectiveDate`: the actual filing date, which must be ≤ today in the org time zone. Clients default it to today.
  - It is stored on `MilestoneCompletion.effectiveDate`. On time means `effectiveDate ≤ due date`.
  - Older completions fall back to the org-local date of `completedAt`; see `completionDate()` in `domain/milestones.ts`.
- `reopenMilestone({ reason? })` moves the completion into `patient.milestoneHistory[]` (`MilestoneHistoryEntry`: the completion plus `key`, `reopenedAt`, `reopenedBy`, `reopenReason`) instead of deleting it.
- **Who can do what:**

  | Action | Allowed |
  |---|---|
  | Complete a milestone | a licensed member (discipline RN/NP/MD) or an admin; the `intake` role may complete the **NOE only** |
  | Reopen a milestone | licensed members or admins |
  | `recordDeath`, `dischargePatient`, `changeLevelOfCare`, `recordRecertification` | `requireLicensed` (licensed members or admins) |

- Web and iOS hide these actions from other members.

### Benefit periods and recertification (S4)
- **Transfers.** `Patient.benefitPeriodStart` (≤ `admissionDate`; set from `AdmitPatientRequest.benefitPeriodStart`, which the intake flow wires) marks a transfer.
  - The first computed period continues from that start. The admission date must fall inside it (`benefitPeriodStartError`).
  - The continued period's F2F belonged to the prior hospice, so it is not tracked (`f2fRequired: false`).
  - NOE and HOPE stay tied to the admission date.
- **New admission in period ≥ 3** (no `benefitPeriodStart`, or one equal to admission): F2F window is admission − 30 through admission + 2 (`newAdmissionF2FWindow`).
- **Later periods:** the standard window, which is the 30 days before the period starts (`standardF2FWindow`).
- **Recompute:** `computeMilestones(…, { benefitPeriodStart })` and `recomputeBenefitPeriods(patient, count)`. `recordRecertification` uses the latter when it extends periods.
- **`recordRecertification` checks:**
  - `certificationDate` must be within [period start − 15 days, period start]; otherwise `invalid-argument`.
  - When the period requires a F2F, both `f2fDate` and `f2fBy` (the attesting physician or NP) are required.
  - An F2F outside its window is recorded (event `details.f2fInWindow: false`), and the response returns `warnings`. The F2F milestone is **not** completed.
  - The response is `RecordRecertificationResponse { warnings: string[] }`.
  - Completions carry `effectiveDate`: the certification date for the recert, the F2F date for the F2F.

### Clinical record edits (S2)
`updatePatientClinical(UpdatePatientClinicalRequest) → { changed: string[] }`
- **Who:** clinical role, licensed (RN/NP/MD) and on the care team, or an admin. Patient status must be `admitted` or `referral`.
- **Fields:**
  - `codeStatus`, `allergies`, `medications`, `caregiver`, `attendingPhysician`, `referringPhysician`, `phone`, `address`, `primaryDiagnosis`, `secondaryDiagnoses`
  - plus a required `reason`
- **Merge-only update:**
  - Fields not in the request are untouched.
  - Object fields are merged into the current value, so e.g. a caregiver's mailing address and email survive a phone change.
  - `null` clears caregiver, physicians or primary diagnosis. Lists replace the whole list.
  - A new caregiver or physician needs a `name`; a new diagnosis needs a `description`.
- **Writes:** only the fields that actually changed.
- **Timeline and audit:**
  - Appends a `clinical_update` `PatientEvent`: `details { fields, reason, codeStatus?: { from, to } }`.
  - Audits `patient.clinical_update`, with metadata limited to the field names (no values).
- **On a code-status change:**
  - A system message is posted in the patient channel ("Code status changed to X by Name.").
  - A normal, non-escalating alert ("Code status changed") goes to the rest of the active care team.
- Care-team editing is **not** here; see `updateCareTeam`.

### Death and discharge (O1)
- **Death visit.** `RecordDeathRequest.visitId` names the death visit in progress:
  - It must belong to the patient and be `scheduled` or `missed`.
  - Only its assignee, the care team or an admin may use it.
  - The visit is completed rather than cancelled. `completedAt` is the time of death (`date` + `time` in the org time zone, or now), clamped to [visit start, now].
- **Channel archiving.** The patient channel is no longer archived immediately on death or discharge:
  - It gets `channel.archiveAfter` = now + 72 h, and a system message says so.
  - `archiveEndedChannels` (hourly at :15, per org, `archiveAfter <= now`, up to 200 per run) sets `archived: true` and removes `archiveAfter`. It audits `channel.archive` with actor `system`.
  - If the patient was re-admitted in the meantime, the marker is just cleared.
- **Death notification.** `recordDeath` also posts "Patient death recorded by Name…" in the channel. It raises a normal, non-escalating alert "Patient death recorded" (id `death_{patientId}`, source `manual`) to the rest of the active care team.
  - Both pushes are generic ("New message" / "New alert"). The patient name is only in the Firestore alert body.
- **System messages** are written by functions with `senderUid: 'system'`, `senderName: 'AuraConnect'` and priority `normal`.

### New types and exports
- **Types:** `UpdatePatientClinicalRequest/Response`, `RecordRecertificationResponse`, `MilestoneHistoryEntry`, `DEADLINE_LEAD_DAYS_DEFAULTS`
- **Fields:**
  - `Org.deadlineLeadDaysByKind`
  - `Channel.archiveAfter`
  - `Patient.milestoneHistory`
  - `MilestoneCompletion.effectiveDate`
  - `CompleteMilestoneRequest.effectiveDate` (required)
  - `ReopenMilestoneRequest.reason`
  - `RecordDeathRequest.visitId`
- **Values:** `PatientEventType` `clinical_update`; `AuditAction` `patient.clinical_update` and `channel.archive`
- **Functions:** callable `updatePatientClinical`; scheduled `archiveEndedChannels`

### Rules and indexes
- **Rules:** none changed. Channels and patients stay server-written, and the org rule already validates `deadlineLeadDaysByKind`.
- **Indexes:** none. The archive job runs a single-field range query per org.

## v3 — on-call, messaging, triage, IDG and AI

Covers PERSONA_REVIEW O2–O5, S6, F5 and the security items H3, M2, M3, M4, L3, L4 and L6. New types are in the "v3 — on-call, messaging, triage, IDG" section at the end of `shared/types.ts`. New fields are optional when read.

### Access (new paths under `orgs/{orgId}/…`)
| Path | Read | Client write | Written by |
|---|---|---|---|
| `messageRecalls/{channelId}_{messageId}` | admin or `audit` capability | none | `recallMessage` (a copy of the original, `MessageRecall`) |
| `idgMeetings/{id}/notes/{docId}` | staff (not volunteers), same as the meeting | none | `saveIdgDisciplineNote` (`{patientId}_{discipline}`, kind `discipline`), `generateIdgPrep` (`{patientId}_aiPrep`, kind `ai_prep`) |
| `rateLimits/{uid}_{action}` | nobody | none | `enforceRateLimit` (token bucket) |

Changes to existing documents:
- **Org:** `patientChannelRetentionDays` (null, or an int from 2190 to 36500) is admin-editable (Settings, with a warning).
- **Channel:** `coverageMembers` (`{uid, until, reason, roleKey, grantedAt}`), `coverageExpiresAt` (the earliest `until`) and `legalHold`. All three are server-written only. There is no callable for `legalHold` yet, so set it with the Admin SDK.
- **IdgMeeting:** `completionPending` is true while `completeIdgMeeting` writes its batches. `aiPrep` is now legacy: it is no longer written, and clients fall back to it for old meetings.

### Behavior
- **O2, acknowledge from chat.**
  - Any message a member posts runs `ackMessageAlertsOnReply`. It acknowledges that member's open alerts whose source is `message`, whose `source.channelId` matches the channel, and which have the member in `currentTargetUids`.
  - Each acknowledgement is audited as `alert.ack` with `via: 'reply'`. The cost is one extra query per message.
  - Web and iOS show an inline **Acknowledge** button on urgent and critical messages that carry an `alertId` for an open alert targeting the viewer.
- **O3, triage.**
  - **Routine calls** with an assignee raise a `normal` alert to the assignee with `policyId: null`, so they don't escalate. The alert title is "Triage call".
  - **`resolveAlert` on a triage alert** also resolves the open call. The disposition is `other` and the note is "Resolved from alert" unless the caller passes `disposition` or `dispositionNote`. On web and iOS, **Resolve** on a triage alert opens the call's resolve form instead.
  - **`resolveTriageCall` with `visit: {start, end, assignedUid?}`** creates a visit using the same fields as `scheduleVisit`:
    - It is assigned to the resolver by default, with the discipline taken from the assignee's member doc.
    - A visit that has already ended and is assigned to the resolver is stored as `completed`.
    - It needs a patient-linked call for an admitted patient.
    - It returns `{taskId, visitId}`.
  - **`assignTriageCall`** adds the new assignee to `targetUids` and replaces the previous assignee in `currentTargetUids`, then pushes to the new assignee. If the call has no alert, it raises a routine `normal` alert to the new assignee.
  - **M3:** only the call's assignee, a recipient of its alert, or an admin may assign or resolve. A call with neither an assignee nor an alert is an open queue item that any clinical member can pick up.
- **O4, handoff.** `generateHandoff` takes `scope`:
  - **`care_team`** (the default) covers care-team patients who are admitted, or whose `death.date` or `dischargeDate` falls in the window.
  - **`my_activity`** covers patients from triage calls the caller received or was assigned in the window, and patients from visits the caller completed in the window, of any status. Triage calls not linked to a patient get their own prompt section.
  - Timeline events are now included in both scopes.
- **O5, on-call coverage.**
  - `joinPatientChannelForCoverage({patientId, reason})` is allowed when the caller has a shift that covers now (any on-call role), or is an admin.
  - It adds the caller to the patient channel's `memberUids` and to `coverageMembers`. `until` is the shift end, capped at 24 hours; admins with no shift get 12 hours. If the caller is already a regular member, it returns `alreadyMember: true`.
  - It is audited as `channel.coverage_join`, and the audit metadata includes the justification.
  - The hourly `expireChannelCoverageJob` removes expired entries. It also removes those members from `memberUids` unless they have since joined the patient's care team, and audits this as `channel.coverage_expire`.
  - `updateChannelMembers` drops explicitly added or removed uids from `coverageMembers`.
  - UI: opening a care-team channel you're not in offers **Join for on-call coverage** with a reason field. On web this is in the Messages page; on iOS it is in `ChatView`, which looks the patient up by `channelId`.
- **S6, retention and soft recall.**
  - `purgeExpiredMessages` never purges `patient` channels by `messageLifespanDays`. It purges them only when `patientChannelRetentionDays` is at least 2190, and then uses that value as their lifespan.
  - Channels with `legalHold == true` are never purged.
  - `recallMessage` copies the original to `messageRecalls` in the same transaction before emptying the message. Attachment files are kept in Storage.
- **F5 and H3, IDG.**
  - **`saveIdgDisciplineNote`** has the same audience as `saveIdgNote`: attendees, the care team and admins. It writes one document per patient and discipline, audited as `idg.discipline_note`. `saveIdgNote` still stores the summary note on the meeting doc.
  - **`updateIdgMeeting`**: only the creator or an admin may change `attendeeUids` or `patientIds`. Dropping patients from the agenda also deletes their subcollection notes.
  - **`completeIdgMeeting`** works in three steps:
    1. A small transaction claims the meeting (`status: completed`, `completionPending: true`).
    2. Patient updates and tasks are written in batches of 400 or fewer, using deterministic task ids `idg_{meeting}_{patient}_{i}`.
    3. `completionPending` is cleared.

    A retry while the meeting is still pending resumes the writes idempotently. The callable refuses meetings dated after today in the org's time zone. It returns `{reviewed, patientsUpdated, tasks, warnings}`, with a warning when the attendees include no MD, RN, SW or Chaplain.
  - **`generateIdgPrep`** is allowed for admins, or per patient for that patient's care team. Attendance alone is not enough.
    - It accepts `patientIds` (up to 25) and `skipFreshHours`, and returns `skippedPatientIds`.
    - Prep is stored in `notes/{patientId}_aiPrep` with a plain `set`, with no transaction on the meeting doc.
    - A failure to store prep is reported as `aborted` ("could not be saved"), not as "AI generation failed".
    - Web and iOS **Generate prep for all** loops over batches of 25 and skips prep from the last 12 hours.
- **M4, rate limits** (`lib/rateLimit.ts`, token bucket per uid and action):

  | Callable | Limit |
  |---|---|
  | `searchMessages` | 30/min |
  | `summarizeChannel`, `generateHandoff`, `generateIdgPrep`, `sendBroadcast`, `createAlert` | 10/min each |

  An exceeded limit returns `resource-exhausted`. Critical-priority broadcasts are admin-only.
- **L6.** `updateChannelMembers` rejects `broadcast` and archived channels. On `patient` channels, only admins or the patient's care team may change members.
- **M2.**
  - Web: `FileViewer` and message attachments use `getBlob` plus an object URL, which is revoked on unmount. The Storage bucket needs a CORS entry for the console origin (`gsutil cors set`).
  - iOS: `SecureDownload` uses `StorageReference.data(maxSize:)`. Neither client creates `getDownloadURL` bearer URLs for PHI.
- **L3.** iOS `SessionStore` wipes the Firestore cache and preview files whenever the auth uid becomes nil or changes. It persists the last uid, not PHI, so the wipe also happens across launches.
- **L4.** In Chat, Alerts, Triage and IDG, iOS removed `.textSelection(.enabled)` from PHI text and offers Copy through `SecurePasteboard` instead.

### Callables and jobs
- **New:** `joinPatientChannelForCoverage`, `saveIdgDisciplineNote`, and the scheduled `expireChannelCoverageJob` (hourly at :05 UTC).
- **Changed:** `resolveAlert`, `resolveTriageCall`, `assignTriageCall`, `logTriageCall`, `generateHandoff`, `generateIdgPrep`, `completeIdgMeeting`, `updateIdgMeeting`, `updateChannelMembers`, `recallMessage`, `sendBroadcast`, `createAlert`, `searchMessages`, `summarizeChannel`, and the jobs `purgeExpiredMessages` and `onMessageCreated`.

### Rules and indexes
- **Rules:**
  - `orgs/{orgId}` update allows `patientChannelRetentionDays`.
  - New matches: `messageRecalls` (read with the `audit` capability), `idgMeetings/{id}/notes` (staff read), and `rateLimits` (no access).
  - Tests are in `tests/rules/test/firestore.oncall.test.js`.
- **Indexes:**
  - `alerts` (source.channelId, currentTargetUids CONTAINS, status)
  - `triageCalls` (receivedBy, receivedAt)
  - `triageCalls` (assignedUid, receivedAt)
  - `visits` (completedBy, completedAt)
  - Field-index exemptions for `notes.text` and `messageRecalls.body`.
  - Existing indexes already cover the rest: `shifts` (uid, end) for the coverage check, and a single-field `coverageExpiresAt` for the expiry job.

## v3 — intake, admission and invites

The types are in `functions/src/shared/types.ts`: new fields inline plus the "v3 — intake" section at the end. Every new field is **optional when read**. Items refer to [PERSONA_REVIEW.md](PERSONA_REVIEW.md) (H2, I1–I6) and the security review (M2, M5, L2, L5).

### Referrals
- **New fields on `Referral`** (all written only by functions):
  - `extractionStartedAt`
  - `retryRequestedAt`
  - `claimedBy` and `claimedAt`
  - `possibleDuplicates: DuplicateMatch[]`
  - `nonAdmit: NonAdmitRecord`
- **Phone referrals.** `fileName`, `contentType` and `storagePath` are `null` for a phone referral (`source: 'phone'`). Clients can't create one directly: the rules still require a file-backed `uploaded` record with `source` in `scan`, `upload` or `fax`.
- **New `ReferralStatus` `non_admit`.**
- **Referral files (I1).** The allowed types are `REFERRAL_MIME_TYPES`: PDF, PNG, JPEG, WebP, HEIC and HEIF.
  - The Firestore create rule, the Storage rule, the extractor, the web picker and iOS all use this same list.
  - TIFF and other image types are refused, because Gemini can't read them.
  - iOS always uploads a PDF: scanned or imported images are combined into one PDF.
- **Extraction (I1).**
  - `onReferralUploaded` and retries set `extractionStartedAt`.
  - The file goes to Gemini as `fileData.fileUri = gs://{bucket}/{path}` (with `maxOutputTokens` 16384), so the function never downloads or inlines the file.
  - After extraction, a duplicate check writes `possibleDuplicates`.
- **Stuck referrals (I1).** A referral is stale when it has been `uploaded` (since `updatedAt`) or `extracting` (since `extractionStartedAt`) for more than **6 minutes**.
  - `retryReferralExtraction` is allowed from `failed`, `needs_review`, or a stale `uploaded`/`extracting` referral.
  - The **cooldown is 2 minutes per referral**; a retry inside it fails with `resource-exhausted`.
  - `rejectReferral` is allowed from a stale `uploaded`/`extracting` referral too.
  - Web and iOS show **Retry** and **Reject** for stale rows.
- **`claimReferral({referralId, force?, release?})` → `{claimedBy}` (I2).**
  - The review pages claim a referral when they open it and re-claim it every 10 minutes. They release it on leaving.
  - A claim expires after **30 minutes**, and `force` takes it over. Both are audited as `referral.claim`, with `previousClaimant`.
  - `acceptReferral`, `rejectReferral` and `closeReferralNonAdmit` require the caller to be the claimant, or the referral to be unclaimed or expired.
  - The UI shows "X is reviewing" with a **Take over** button.
  - Claiming never touches `updatedAt`, because `updatedAt` is the staleness clock.
- **`acceptReferral`.**
  - Accepting an already-accepted referral returns **`already-exists`**, instead of the old silent success.
  - **I3:** optional `referralDate`, `referralSource` and `reasonForReferral` override the extracted values. They're stored on the patient, together with `referralReceivedAt` (the referral's `createdAt`).
  - **I4:** duplicates are re-checked against the edited patient. When there are matches and `confirmNotDuplicate` isn't `true`, it fails with `failed-precondition` and refreshes `possibleDuplicates`.
- **Duplicate matching (I4).**
  - Patients match on the same Medicare MBI (normalized, with a few variants) or on the same last name (case variants) plus DOB.
  - Referrals created in the last **30 days** match on the extracted MBI or on last name plus DOB.
  - Rejected referrals, the referral itself, and its own patient are excluded.
- **`createManualReferral({patient, referralDate?, referralSource?, reasonForReferral?})` → `IdResponse` (I5).**
  - Creates a phone referral with no file, straight into `needs_review` and claimed by the creator.
  - The entered data is stored as `extracted`, with an empty `fieldConfidence`.
  - Audited as `referral.create`.
- **`closeReferralNonAdmit({referralId, reason, note?, deathDate?})` (I5).**
  - Allowed from `needs_review`, `failed` or `accepted`. Calling it again on a `non_admit` referral does nothing.
  - The referral becomes `non_admit` with a `nonAdmit` record.
  - For an accepted referral whose patient is still `referral`, the patient also becomes **`non_admit`**, and their open tasks and future visits are cancelled. If the patient has already been admitted, the call is refused; use discharge or death instead.
  - With `died_before_admission`, the patient gets `death.date` (default: today in the org time zone; future dates are refused), and **no bereavement plan is created**.
  - `reason: 'other'` requires a note.
  - Audited as `referral.non_admit`.
  - **`NonAdmitReason` values:** `died_before_admission`, `not_eligible`, `declined_hospice`, `chose_other_provider`, `unable_to_contact`, `moved_out_of_area`, `no_payer`, `other`.

### Admission (`admitPatient`, H2 and I6)
- **Modes, chosen from the stored patient:**
  - **New:** no patient yet, or `referral`.
  - **Update:** `admitted` requires `update: true` from an admin or a care-team member. Without it the call fails with **`already-exists`**, so a second wizard can't overwrite the patient. Update changes demographics, consents, admission date, benefit period and start, milestones and visit frequencies. It leaves the care team and level of care alone (`updateCareTeam` and `changeLevelOfCare` own those), and it adds no event or tasks.
  - **Readmission:** `discharged` requires `readmission: true`.
    - A new `admission` event is appended, with `details.readmission`, `priorAdmissionDate`, `priorDischargeDate`, `priorDischargeReason`, `priorMilestones` and `priorMilestoneCompletions`.
    - Milestones are recomputed. `milestoneCompletions`, `remindedMilestones`, the discharge fields and `lastIdgReviewDate` are reset.
    - The channel is un-archived, and admission tasks are created.
  - **Refused:** `deceased` and `non_admit` patients can't be admitted.
- **Writes.** An existing patient is only ever changed with `update()`. Server-maintained fields are never dropped: completions, history, `volunteerUids`, referral metadata, and so on.
- **`joinChannel`.** The caller is added to the care-team channel only on a new admission or readmission, and only when `joinChannel` is set. The default is `true` for RN/NP/MD members whose role isn't intake, and `false` otherwise.
- **`benefitPeriodStart` (transfers).** It must be on or before the admission date and cover it. It's validated with `benefitPeriodStartError`, passed to `computeMilestones(..., {benefitPeriodStart})`, and stored on the patient.
- **`visitFrequencies`** replaces the patient's list when it's given.
- **Audit.** `patient.admit` records metadata `mode`, `joinedChannel` and `transfer`; update mode is audited as `patient.update`.
- **The wizards (web and iOS)** match the server's validation: name, DOB (not in the future), election statement **and HIPAA notice**, the transfer period window, a non-empty care team, and frequencies of 0 to 28 per week with one per discipline. They also:
  - default the care team to the caller's Team (when the caller is on exactly one) instead of the caller alone
  - offer a Team picker
  - add a Visit frequencies step
  - add a Transfer section (current period number and when it started)
  - handle update and readmission
- **iOS "Admit now"** loads the patient document rather than the raw extraction.

### Invites and sign-up (M5, L2, S7)
- **`Invite.expiresAt`.** It's 14 days after `inviteMember`, and a re-invite or resend renews it. Invites without it expire at `createdAt` + 14 days.
- **`acceptInvite`** rejects revoked and expired invites with `failed-precondition`. Team membership is added with `arrayUnion` **after** the transaction, which removes the shared-team-doc contention found in the load test. Teams are read before the transaction, and deleted teams are skipped.
- **`revokeInvite({orgId, inviteId})`** is admin only and works on `pending` invites. It sets `status: 'revoked'`, `revokedBy` and `revokedAt`, and is audited as `invite.revoke`. The web Members invite list shows the expiry, **Resend** and **Revoke**.
- **`listMyInvites`** returns `{invites: [], verificationRequired: true}` when the caller's email isn't verified. It follows `INVITE_REQUIRE_VERIFIED_EMAIL`, and it hides expired invites.
- **Sign-up.** The web sign-up path tells people to ask their administrator for an invite; creating an account is offered only for starting a new organization (`createOrg` is unchanged). See SETUP.md §3 for disabling self sign-up in Identity Platform.
- **Email-link finish (web).** If the email already had an account (it had a password sign-in method, or `isNewUser` is false), the invitee must choose a new password. There's no Skip.

### Client notes
- **M2.** The referral review page reads the file with `getBlob` under the user's own Storage-rule check and shows it through an object URL, which is revoked on unmount. No long-lived `getDownloadURL` token URL is created.
- **L5.** Storage metadata errors are logged by error code only.
- **Web multi-file upload** checks every file first (type, size, empty), so nothing is uploaded if any file is invalid. It then creates one referral per file. Combining files into one referral isn't offered, because merging PDFs in the browser isn't trivial.
- **iOS import** keeps every selected PDF, one referral each; before, only the first was kept.

### Indexes
- `patients` (lastName, dob): name + DOB duplicate check.
- `referrals` (extracted.patient.medicareMbi, createdAt) and (extracted.patient.lastName, createdAt): recent-referral duplicate check.
- The MBI lookup on `patients` uses the automatic single-field index.

## v3 — visits, staffing, admin guardrails and compliance reports

Types are in `functions/src/shared/types.ts`, in the section "v3 — visits planning, bulk reassign, staffing/offboarding, compliance reports". New fields are optional when read.

### Data changes
| Where | Field | Notes |
|---|---|---|
| `orgs/{orgId}` | `missedVisitAlertMode?` | `assignee` (default) · `assignee_admins` · `digest` · `off`. Admins write it directly; the rules already allow it. |
| `patients/{id}.visitFrequencies[]` | `preferredDays?`, `preferredStart?`, `durationMinutes?`, `assignedUid?` | These are planning hints for `generateVisitPlan`. `preferredDays` uses 0 = Sunday … 6 = Saturday, and `preferredStart` is org-local `HH:mm`. Clients must send them back unchanged when they re-save frequencies. |
| `visits/{id}` | `type?` | `routine` (the default when absent) · `admission` · `evaluation` · `prn` · `aide_supervision`. |
| `patients/{id}/events` | type `care_team_change` | `details: { added, removed }`. Offboarding adds `offboard: uid`. |
| `alerts/{id}.source` | `{ type: 'visit_missed_digest', date, count, patientId: null }` | This is the daily digest; its id is `vmd_{localDate}`. |

### New audit actions
- `visit.reassign`, `visit.plan`, `patient.care_team`
- `member.update`, `member.deactivate`, `member.offboard`
- `org.settings_update`
- `report.compliance`, `report.census`

### New indexes
- patients (status, dischargeDate)
- patients (status, death.date)
- visits (discipline, scheduledStart)
- tasks (status, createdAt desc)

### Behavior

**Missed visits (V1).** `checkMissedVisits` still marks visits `missed`. What happens next depends on `missedVisitAlertMode`:
- **Per-visit alert** `vm_{visitId}`, with normal priority and no escalation:
  - Recipient: the assignee. If the visit is unassigned, the care-team RN(s), else the whole active care team, else the admins.
  - `assignee_admins` adds the admins.
  - `digest` and `off` raise no per-visit alert.
- **Daily digest:** once a day at 07:00 org-local time, a PHI-free alert counts the visits missed in the last 24 hours.
  - It goes to admins and `scheduling` holders.
  - It is sent in every mode except `off`.
- **Clearing the alert:** completing a missed visit (late documentation) or rescheduling it resolves its `vm_` alert, audited as `alert.resolve`.

**Visit permissions (V4)** (`functions/src/domain/visits.ts` `canManageVisit`):

| Action | Allowed |
|---|---|
| Schedule, update, cancel | A clinical role or the `scheduling` capability, **and** one of: admin, `scheduling`, the patient's care team, the assignee, or the visit's `createdBy`. |
| Complete | The same people, plus an Aide/LPN (`FIELD_DISCIPLINES`) with role `viewer` completing a visit **assigned to them**. |
| Cancel | Only `scheduled` visits can be cancelled; clients show Cancel only then. |

- **Missed visits:** they can be completed late, or rescheduled with `updateVisit` and a new `start` in the **future**. Rescheduling sets `status: 'scheduled'`.
- **Moving a start:** moving only `start` keeps the visit's length.
- **Referral patients:** `scheduleVisit` accepts `type: 'admission' | 'evaluation'` for referral-status patients. Every other type needs an admitted patient.

**`generateVisitPlan({weekStart, patientIds?, dryRun})` (V2)** is for admins and `scheduling` holders. The plan covers the 7 days from `weekStart`, in the org's time zone. The pure rules are in `domain/visitPlan.ts`:
- **Weekly target:** `floor(perWeek)`, plus one extra visit in some weeks when `perWeek` is fractional.
  - The extra visit is spread over consecutive Monday-aligned weeks. For `x.5` this is week parity.
  - Weeks are counted continuously across ISO years.
- **Existing visits count:**
  - For the same patient and discipline in the window, every visit that is not cancelled counts toward the target.
  - Cancelled `plan_` visits also count, so a plan visit someone deliberately cancelled is not re-created.
- **Ids:** `plan_{patientId}_{discipline}_{weekStart}_{n}`, with n = 1…target, written with `create`, so re-running is idempotent.
- **Days and times:**
  - Days come from `preferredDays`; otherwise visits are spread over Mon–Fri (1 → Wed, 2 → Tue/Thu, 3 → Mon/Wed/Fri).
  - The start is `preferredStart` (default 09:00) and the length is `durationMinutes` (default 60).
- **Assignee:** the frequency's `assignedUid` if that member is active, else the first active care-team member with the discipline, else unassigned.
- **Conflicts:**
  - `unassigned`
  - `overlap`: the assignee already has a visit at that time
  - `past`: the slot is in the past, so it is not proposed
  - `inactive_assignee`
- **Dry run** returns `{visits, conflicts, existing}`. A real run also returns `created` and writes a `visit.schedule` audit per visit plus one `visit.plan`.

**`reassignVisits({visitIds ≤ 200, assignedUid, reason})` (V3)**
- **Who:** admins, `scheduling` or `staffing` holders.
- **What moves:** only `scheduled` visits. Anything else is returned in `skipped` with a reason code.
- **How:** transactions of 50 visits, one `visit.reassign` audit per visit (the audit includes the staffing reason).
- **Notification:** one PHI-free push to the new assignee.

**`updateCareTeam({patientId, add?, remove?})` (L1)**
- **Who:** admins, `staffing` holders, or an RN/NP/MD (not a viewer) already on the care team. Only admitted and referral patients can be changed.
- **What it writes,** in one transaction:
  - the patient's `careTeamUids` (at most 50)
  - the patient channel's `memberUids`: added members join, removed members leave and lose any coverage entry
  - a `care_team_change` event
  - a `patient.care_team` audit entry

**`offboardMember({uid, reassignTo: {default?, byDiscipline?}, shiftAction, dryRun})` (L1)**
- **Who:** admins and `staffing` holders. You can't offboard yourself, only an admin can offboard another admin, and the last active admin can't be offboarded.
- **Choosing the replacement:**
  - Each item goes to `byDiscipline[work discipline]`, else `default`, else it is left unassigned.
  - The work discipline is the task's or visit's discipline. For on-call roles and shifts it is the role's discipline; otherwise it is the member's own.
- **What moves:**

  | Item | Treatment |
  |---|---|
  | Care teams (admitted and referral patients) | Through `updateCareTeam` logic. |
  | Open tasks, future `scheduled` visits, active bereavement plans, open triage calls | Reassigned. |
  | Future shifts | Deleted, or reassigned. |
  | `onCallRoles.fallbackUids`, `teams.memberUids` | The member is removed and the replacement added. |
  | Active volunteer assignments | Ended (`endDate` = today). |
  | Escalation policies with a `uid` step for the member | Only reported. |

- **Writes:** batches of 400 or fewer, each change with a `member.offboard` audit entry. Finally the member doc is set `active: false, teamIds: []`.
- **Dry run** returns counts only.

**Admin guardrails.**
- **`onMemberWritten`** (now `onDocumentWrittenWithAuthContext`, so the actor is the signed-in uid or `system`):
  - It audits changes to role, discipline, active, capabilities and teamIds as `member.update`, or as `member.deactivate` when an active member is deactivated. Token and profile edits are not audited.
  - It reverts any write that leaves the org with **zero active admins**: the member is set back to `role: 'admin', active: true`, claims are left untouched, and the revert is audited with `reverted: true`.
- **`onOrgSettingsUpdated`** audits every change to `orgs/{orgId}` as `org.settings_update`, with `{fields, changes: {key: {from, to}}}`.

**Reports (L4).** `complianceReport({from, to, kinds})` and `censusReport({from, to})`:
- **Who:** admins and `reports` holders. Each run is audited.
- **Range:** up to 400 days.
- **Patients scanned:** admitted patients, plus discharged patients (by `dischargeDate`) and deceased patients (by `death.date`) whose care ended on or after `from`.
- **Compliance rows:** one per milestone due in the range, of the requested kinds.
  - Timeliness is judged from `completionDate()`: `effectiveDate`, else the org-local date of `completedAt`.
  - Status: `on_time` · `late` (with `daysLate`) · `overdue` (not filed and past due) · `open`.
  - Milestones due after the end of care are left out unless they were completed.
- **Census:**
  - A patient is on census from the admission date until the day before discharge or death.
  - The report returns census at the start and end, average daily census, admissions, live discharges by reason, deaths, and a roster with days in range.
- **Metrics:** `loadMetricsInput` now judges on-time completions with `completionDate()` too.

### Clients
- **Web:**
  - **Visits:**
    - A "Plan week…" button opens a grid preview, then Confirm.
    - Visits can be multi-selected and bulk-reassigned.
    - There is a "By clinician" day-lane layout.
    - Missed visits get Reschedule; actions are shown only where the server allows them.
    - Visit type can be chosen, and referral patients can be scheduled.
  - **Queries:** they are server-bounded by assignee, "Mine" or discipline. Tasks history queries filter by status and cap at 500, and patient pickers load only active patients.
  - **Patient frequency editor:** edits and preserves the planning hints.
  - **Settings:** a "Missed-visit alerts" card.
  - **Members:** an "Offboard…" wizard (dry-run table, then typed confirmation).
  - **PatientDetail → Care team:** an "Edit" button.
  - **Reports:** `/reports/compliance` (tabs by kind, CSV, print) and `/reports/census`, in the nav and on the Dashboard for admins and `reports` holders.
- **iOS:**
  - **Members:** tapping a member opens an admin sheet to change role, capabilities and active status, and to offboard with a preview.
  - **Today and My Visits:** Reschedule for missed visits.
  - **Visit detail:**
    - Reschedule and Record death (licensed staff, at a scheduled or in-progress visit).
    - Permission-aware Complete and Cancel; Aide/LPN viewers can complete their own visits.
  - **Patient detail:** an "Edit care team" row.

---

# v4: messaging

The types are in the "v4" section of `functions/src/shared/types.ts`. The client message-create shape does **not** change: the create rule is near Firestore's 1,000-expression limit. So the new per-message fields (`mentions`, `mentionRoles`, `templateId`, `editedAt`, `reactionCounts`) are written only by the backend.

## Access
| Path | Read | Client write |
|---|---|---|
| `messageTemplates/{id}` | staff (not volunteers) | none. Admins use `saveTemplate` / `deleteTemplate` |
| `members/{uid}/templates/{id}` | owner | none. The owner uses `saveTemplate` with `scope: 'personal'` |
| `channels/{cid}/prefs/{uid}` | self | self: exactly `{mode, mutedUntil, updatedAt == request.time}`. The caller must be a channel member |
| `channels/{cid}/acks/{uid}` | channel members | self **create** only: exactly `{messageId, ackedAt == request.time}`. The channel must have `requireAck == true` and the caller must be a member. No update or delete |
| `channels/{cid}/messages/{mid}/reactions/{uid}` | channel members | self create, update and delete: exactly `{emoji in ALLOWED_REACTIONS, at == request.time}`. The caller must be a member and able to post |
| `reminders/{id}` | owner | none |
| `messageEdits/{id}` | admin, or members with the `audit` capability | none |
| `members/{uid}` self-update | | the allowlist also gains `status`, `outOfOffice` and `notificationSettings` (shape-validated) |

## Behavior
- **Templates.**
  - `createOrg` seeds the default org templates, and a `seedDefaultTemplates` admin callable adds them to existing orgs. The defaults:
    - SBAR MD escalation (fields S, B, A, R; urgent)
    - Fall report
    - Symptom crisis (pain or dyspnea)
    - Death notification to the team
    - Visit update
    - Medication refill request
    - Comfort kit request
    - DME order or pickup
    - Family update
    - Running late
    - Call me when free
    - Quick replies
  - Clients fill placeholders locally. A message sent from a template may begin with `[[tpl:{id}]]`. `onMessageCreated` strips the marker, rewrites the body and sets `templateId`.
- **Mentions.** `onMessageCreated` parses `@` followed by a channel member's display name (longest match, case-insensitive) or `@{roleKey}` for on-call roles.
  - Role mentions resolve to whoever is on call now and are added to `mentions`.
  - A mentioned user gets pushed even if their channel mode is `mentions`. A mentioned user who isn't a member of the channel is **not** added; the sender gets a system note instead.
- **Notification delivery** (normal priority only; urgent and critical always push). A member is skipped when any of these is true:
  - their channel prefs are `mutedUntil > now`
  - their channel mode is `mentions` and they aren't mentioned
  - their channel mode is `urgent_only`
  - they are in quiet hours (org time zone)
  - `offShiftQuiet` is on, they have on-call shifts, and none covers now
  - they are out of office, unless mentioned

  Direct messages always push unless the channel is muted.
- **Out of office.** When a DM goes to a member whose `outOfOffice.until > now`, `onMessageCreated` posts a system message: "{name} is out of office until {date}. Contact {delegate} instead."
  - Role routing (`sendRoleMessage`, triage, @role) skips members who are off or out of office and falls through to the next shift holder or fallback.
- **Delivery tracking.**
  - `messageReadStatus` returns read and unread members from `reads/{uid}.lastReadAt ≥ message.createdAt`.
  - `nudgeUnread` re-pushes a generic "Reminder: unread message" to the unread members. The sender or an admin may use it, with a rate limit of 1 per message per 10 minutes.
  - `remindIfNoReply` creates `reminders/{id}` and a Cloud Task. When the task fires and nobody else has posted in the channel since the message, it raises a normal self-alert, "No reply yet". A later reply cancels the reminder.
- **Ack-required broadcasts.** `sendBroadcast` gains `requireAck`, which sets `channel.requireAck`. Recipients acknowledge with a self-written `acks/{uid}`.
  - `broadcastAckReport` (the sender, admins, or the `reports` capability) returns who has acked and who is pending. The web page has CSV export.
- **Pins.** `pinMessage` is available to any channel member who can post. It keeps at most 10 pins, each with a snippet of 140 characters or fewer, and writes an audit entry.
- **Channel management.**
  - `renameChannel` applies to group and team channels, for the creator or admins.
  - `leaveChannel` applies to group and team channels, but not patient channels or the last member.
  - Adding and removing members uses the existing `updateChannelMembers`.
- **Reactions.** A trigger on `reactions/{uid}` writes updates `message.reactionCounts` (transactional increment and decrement).
- **Edits.** `editMessage` is limited to the sender, within 15 minutes, on messages that aren't recalled.
  - It saves the prior body to `messageEdits/{id}` (`{channelId, messageId, previousBody, editedBy, editedAt}`), sets `body` and `editedAt`, and re-parses mentions.
  - It doesn't re-push.
- **Web push.** The web app registers an FCM token (VAPID key from `VITE_FIREBASE_VAPID_KEY`) into `members/{uid}.fcmTokens`, using the same self-update path as iOS. The payloads are the existing generic ones.
- **iOS lock-screen actions.** The categories are `AURA_ALERT` (Acknowledge, which requires authentication) and `AURA_MESSAGE` (Reply, a text input that requires authentication, and Mark read). The backend sets `apns.payload.aps.category` in `notify.ts`.
