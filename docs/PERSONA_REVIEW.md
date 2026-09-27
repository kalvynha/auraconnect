# Persona review: AuraConnect at an average daily census of 100

**Method.** Three expert reviews read the code as specific staff would use it (web `web/src`, iOS `ios/AuraConnect`, backend `functions/src`, security rules):
- **Field clinicians:** RN case manager, on-call RN, aide, SW, chaplain, LPN.
- **Leadership:** owner/administrator, director of nursing, medical director, compliance/QAPI.
- **Intake and coordinators:** intake, scheduler, bereavement, volunteers.

A separate load test ran one simulated week of hospice activity against the Firebase emulators; see [LOAD_TEST.md](LOAD_TEST.md).

**Workload at census 100** (per week unless noted):

| Item | Volume |
|---|---|
| Scheduled visits | ~900 |
| Messages | ~5,000 |
| Referrals | ~12 |
| Admissions | ~10 |
| Deaths | ~8 |
| Active bereavement plans (at any time) | **~450**, which is 8 deaths × 56 weeks |
| Bereavement contacts due | ~80 |

## Summary

The core flows work. Four kinds of problem show up across all personas:
1. **Safety and compliance bugs.**
   - Overdue deadlines never escalate.
   - Code status, allergies and the care team are frozen after admission.
   - Transfer patients get wrong recertification dates.
   - Aides and LPNs can record deaths, but aides can't message the team.
2. **Dead ends.**
   - The on-call death visit at 2am.
   - Referrals stuck in "extracting".
   - Patients who are never admitted.
   - Readmission after discharge.
   - Staff offboarding.
3. **One record at a time, at scale.**
   - ~900 visits a week are scheduled one modal at a time.
   - ~80 bereavement contacts are completed one at a time.
   - Staff are invited one by one.
   - There is no bulk reassignment when someone calls in sick.
4. **Alert noise.** Missed-visit alerts go to every admin, and paperwork deadlines escalate like clinical emergencies. Staff will learn to ignore alerts.

## Phase 2: fixes and streamlining (being implemented)

### Safety and compliance
| # | Fix |
|---|---|
| S1 | Overdue deadlines get their own alert key, so they escalate as urgent even after an "upcoming" reminder. The 30-day overdue cutoff is removed from views and counts. |
| S2 | New `updatePatientClinical` (code status, allergies, meds summary, contacts, physicians) and `updateCareTeam` (channel members kept in sync). Changes are audited and recorded in the timeline; a code-status change is posted to the patient channel. |
| S3 | Discipline-based permissions. Death, discharge, level-of-care change, recertification and milestone reopen are limited to RN/NP/MD disciplines (admins can override). Aides can message and complete their own visits. |
| S4 | Benefit periods for transfers continue from the prior agency's period start. For a new admission in period 3 or later, the F2F is due 2 days after admission. Recert warns when the F2F is out of window and requires the attesting physician. |
| S5 | Milestone completion records the actual filing date (`effectiveDate`), and reopening keeps history instead of deleting. |
| S6 | Retention. Patient channels are exempt from the message auto-delete unless it is set to ≥ 6 years. Recall keeps an admin-only copy. Settings, member-role and deactivation changes are audited. |
| S7 | The last admin can't be demoted or deactivated. Invites can be revoked. |

### On-call and end of life
| # | Fix |
|---|---|
| O1 | Death visit. `recordDeath` accepts the in-progress `visitId` and completes it instead of cancelling it. The patient channel stays open 72 hours before archiving. The care team is notified of the death (no PHI in the push). |
| O2 | Replying in a channel acknowledges your open urgent-message alert, and chat has an inline Acknowledge button. |
| O3 | Routine triage calls notify the assignee without escalating. Resolving a triage alert resolves the call too. Resolving a call can create a PRN visit assigned to the resolver. Reassigning a call notifies the new assignee. |
| O4 | Handoff includes the caller's overnight activity (their triage calls and visits), patients who died or were discharged in the window, and lifecycle events. |
| O5 | The on-call holder can open a patient's care-team channel. It's audited, and they're added for the duration of the shift. |

### Intake
| # | Fix |
|---|---|
| I1 | Stuck referrals: retry is allowed once `extracting` or `uploaded` is older than 6 minutes, and the web shows Retry and Reject. Large PDFs are sent to Gemini by `gs://` reference instead of being inlined in the request. |
| I2 | Referral claim/lock ("X is reviewing"). Accepting a referral someone else already accepted is an error, not a silent no-op, and a second admission wizard can't overwrite an admitted patient. |
| I3 | Referral date, source and reason are editable and carried onto the patient. |
| I4 | Duplicate detection by Medicare MBI and name + DOB. |
| I5 | Phone referrals (no file); non-admit with a reason (also covers referral patients who die before admission); readmission after discharge. |
| I6 | iOS "Admit now" loads the reviewed patient, not the raw AI extraction. Client and server admission validation match. The intake coordinator isn't auto-added to every care team. |

### Scheduling and alerts
| # | Fix |
|---|---|
| V1 | Missed-visit alerts go to the assignee only, plus one daily digest for admins (configurable). Deadline reminders go to RN/MD/admin and don't escalate; the overdue ones do. |
| V2 | "Generate week from frequencies" does a dry-run preview, then creates the visits idempotently. Admission and evaluation visits can be scheduled for referral patients. |
| V3 | Bulk reassign visits with the new assignee notified (sick calls). Assignee filter, and a view grouped by clinician. |
| V4 | A `scheduling` capability for non-admin schedulers. Missed visits can be rescheduled or completed late (iOS too), and late completion clears the missed alert. |

### Coordinators
| # | Fix |
|---|---|
| C1 | Bereavement: complete contacts in bulk, editable survivors with mailing address, CSV mailing export, a default bereavement coordinator setting, and auto-close at 13 months. |
| C2 | Volunteers: coordinators can enter logs for volunteers, and logs can be voided with a reason. The 5% report takes paid care hours as the denominator. The volunteer role only sees assigned patients. |

### Leadership and reporting
| # | Fix |
|---|---|
| L1 | Staff offboarding wizard: a dry-run preview, then reassign care teams, tasks, visits, shifts, on-call fallbacks, bereavement and triage. |
| L2 | CSV export and print layouts on the main tables. Dashboard date ranges. Audit log filters. |
| L3 | Capabilities (`reports`, `audit`, `staffing`, `scheduling`, `volunteers`, `bereavement`) so the DoN, compliance and coordinators don't need full admin. |
| L4 | Compliance report for NOE, recert, F2F and HOPE timeliness (CSV and print). |
| L5 | Settings: org name, time zone, and deadline lead time per milestone kind. |

### iOS field usability
| # | Fix |
|---|---|
| F1 | A "Today" tab with my alerts, visits today and tasks due. "My patients" as the default list. Server-side queries (my visits by assignee; admitted patients only). |
| F2 | Tap to call or navigate for patient, caregiver and physician. A visit context card (code status, allergies, address, caregiver). |
| F3 | In-app camera for wound photos (never saved to the photo library). Pending/failed indicators for offline messages. AI text can't leave the app. |
| F4 | Better form defaults: PRN visits start now and are assigned to me; the death form's pronounced-by defaults to me with location choices, and bereavement risk is required. |
| F5 | IDG notes per discipline, so saves no longer overwrite each other. Bulk AI prep for the whole agenda. |

## Critical missing workflows (designs; not built yet)

These need your go-ahead because each is a meaningful addition. Items marked **EMR** stay in your EMR; AuraConnect tracks only timeliness and status.

| # | Workflow | Why it's critical | Belongs |
|---|---|---|---|
| W1 | **Physician order and signature tracking** (verbal, CTI, F2F attestation, level-of-care orders), with unsigned-order alerts | Survey finding risk; required for GIP/continuous care | App tracks status; order content is **EMR** |
| W2 | **Certification tracking** (verbal and written CTI, attending and hospice MD) before admission | Billing and eligibility | App |
| W3 | **Eligibility and prior-hospice capture** feeding the benefit period | Wrong periods mean wrong recert dates | App; the HETS lookup is external |
| W4 | **Aide supervision** every 14 days as a milestone | 42 CFR 418.76(h) survey item | App |
| W5 | **Incident / complaint / grievance log** with QAPI flags | 418.52 and 418.58 | App |
| W6 | **Emergency preparedness lists** (priority patients, staff call-down, offline on iOS) | 418.113 survey item | App |
| W7 | **Credential and license expiry tracker** | Survey item | App (lightweight); full HR file in an HRIS |
| W8 | **Visit check-in/out with actual times and an offline queue** (EVV-lite) | Continuous-care hours, rural connectivity | App; full EVV is the vendor's or **EMR** |
| W9 | **11th-hour vigil requests** with volunteers claiming slots | Standard hospice volunteer program | App |
| W10 | **Survey packet**: census, admissions/discharges/deaths, IDG attendance, on-call coverage, volunteer ratio, audit exports | Survey readiness | App |
| W11 | **Structured aide observations** ("Report to RN" with tags and photo) | Early detection of decline and skin breakdown | App (coordination only) |
| W12 | **HOPE Symptom Follow-up Visit** reminder (2 days) | HOPE compliance | App; the assessment is **EMR** |
| W13 | Referral-source CRM, fax/portal ingestion, EMR export (FHIR) | Marketing and fewer re-keyed records | Integrations |

**Out of scope for AuraConnect (EMR):** visit notes and assessments, the MAR, plan-of-care content, HOPE submission to iQIES, claims and NOE submission, and e-signing clinical documents.
