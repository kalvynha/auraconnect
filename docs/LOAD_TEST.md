# Load test: average daily census of 100

**Harness:** `tests/load/` runs against the Firestore and Auth emulators.
- **Commands:**
  - `npm --prefix tests/load run load`: the full simulated week.
  - `npm --prefix tests/load run bench`: sequential benchmarks.
  - `npm --prefix tests/load run compare`: compares two result files.
- **Raw results:** `tests/load/results/`.

## Scenario
**Staff (about 70):**
- admin, director of nursing, 2 intake
- 10 RN case managers, 4 LPNs, 14 aides
- 4 SW, 3 chaplains
- medical director, associate MD, NP
- bereavement coordinator, volunteer coordinator
- 25 volunteers

**Setup:** 2 teams, 3 on-call roles.

**Patients:** 100 admitted across all benefit periods and levels of care, plus about 40 discharged or deceased with bereavement plans.

**One simulated busy week:**
- about 12 referrals, 10 admissions, 8 deaths, 2 discharges, 6 recertifications
- about 900 visits (about 5% missed)
- about 5,000 messages
- 40 triage calls, 2 IDG meetings of about 50 patients each
- daily handoffs, 50 searches
- all scheduled jobs

**How to read the latency numbers:** the week is compressed about 250× with 24 operations in flight, which saturates the emulator. Treat latency under load as relative. The sequential benchmark gives clean before-and-after timings. **Read and write counts are exact.**

## Results after fixes

| Operation | Reads (avg / max) | Writes | Notes |
|---|---|---|---|
| New message (trigger) | 7 / 69 | 1.1 | About 10.8 push tokens per message, about 60k pushes a week |
| Alert created and escalated | 5–6 / 37 | 0–2 | |
| Schedule / complete visit | 2 | 2 | |
| **Message search** | **995 / 2,417** (common term) · 3,070 / 6,719 (rare term) | 1 | Largest read cost; see risks |
| Shift handoff (AI) | 239 / 307 | 1 | |
| IDG AI prep (25 patients) | 1,477 | 26 | 24.0 s → 6.9 s sequential |
| Complete IDG meeting (50 patients) | 50 | 124 | |
| Compute metrics | 447 / 629 | 1 | |
| Record death | 16 (was 22) | 10–17 | |
| Daily deadline check | 123 (was 411 avg, 961 max) | — | p95 2.42 s → 0.31 s |
| Missed-visit check (every 30 min) | about 3 per tick | — | |

**Weekly backend reads:** 248.6k → **189.8k**. Search alone went from 169k to 97k reads.

## Fixes made
- **Search** scans in pages and stops early. The results are provably identical to a full scan (a unit test checks this against a brute-force scan).
- **Deadline check** loads each care team once and processes patients 8 at a time.
- **Missed-visit check, handoff and IDG prep** process in bounded parallel batches.
  - IDG prep runs 4 model calls at a time. It still stops after the first patient on a setup or quota error.
- **Alert creation** is one batched create instead of a read-then-create transaction.
- **Record death** no longer reads the patient and care team twice.
- **Index exemptions** for the large text fields: message bodies, IDG notes and AI prep.

## Remaining risks (capacity)

| Risk | When it bites | Plan |
|---|---|---|
| Rare-term search reads up to about 15k docs | Now (cost); worse with more channels | Token index or external search |
| IDG meeting doc: one doc holds all notes (1 MiB limit; concurrent saves retry) | About 40 patients with very long notes | Per-discipline notes in a subcollection (phase 2 F5) |
| `completeIdgMeeting` single transaction: about 21 writes per patient | About 100 patients per meeting | Chunk into batches |
| End-of-care transactions that include queries | Heavy concurrency | Move queries outside the transaction |
| Invite acceptance contends on the shared team doc | Bulk onboarding morning | Use `arrayUnion` without a transaction |
| Bereavement plans never auto-close (+400 a year) | About 9 months (iOS list cap 300) | Auto-close job (phase 2 C1) |
| Metrics reads scale linearly with census | Census about 1,000 → about 5k reads per click | Incremental counters |

## Client-side query issues found
- **Fixed already:**
  - iOS My Visits (org-wide `limit(500)` silently dropped visits)
  - iOS patient list
  - web open-task and alert status filters
- **Remaining for phase 2:**
  - Web pages that load every patient ever (Tasks, Volunteers, IDG, Handoff pickers).
  - Unbounded patient visit and task lists.
  - The org-wide week of visits on the Visits page (about 900 docs).
  - Unbounded bereavement and volunteer lists.
