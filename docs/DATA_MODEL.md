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
