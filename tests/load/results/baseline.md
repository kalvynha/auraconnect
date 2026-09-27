# Load test: baseline

Config: {"seed":20260927,"historyWeeks":12,"concurrency":24,"acceptConcurrency":4,"geminiLatencyMs":800,"messagesPerWeek":5000,"fcmLatencyMs":30,"tasksLatencyMs":15,"purge":true}  
Wall time: setup 174.29 s, week 2424.61 s. Fakes: {"fcmCalls":5513,"fcmTokens":60718,"tasksEnqueued":605,"geminiCalls":198}

## Busy week (per operation)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| callable:acceptReferral | 10 |  | 4.24 s | 13.74 s | 13.74 s | 2 (2) | 5 (5) | 3 |  |  |  |
| callable:ackAlert | 140 |  | 315 ms | 11.46 s | 14.14 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:admitPatient | 10 |  | 8.67 s | 11.95 s | 11.95 s | 14 (14) | 10 (10) | 6 |  |  |  |
| callable:assignTriageCall | 3 |  | 3.78 s | 6.60 s | 6.60 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:cancelVisit | 37 |  | 7.44 s | 14.92 s | 14.92 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:changeLevelOfCare | 2 |  | 7.05 s | 11.96 s | 11.96 s | 1 (1) | 3 (3) | 2 |  |  |  |
| callable:completeIdgMeeting | 2 |  | 36 ms | 38 ms | 38 ms | 47.5 (49) | 112 (116) | 4 |  |  |  |
| callable:completeMilestone | 10 |  | 7.75 s | 12.04 s | 12.04 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:completeVisit | 906 |  | 8.45 s | 13.56 s | 33.74 s | 2.0 (8) | 2 (2) | 3.0 | 9 |  |  |
| callable:computeMetrics | 7 |  | 4.58 s | 12.26 s | 12.26 s | 448.3 (615) | 1 (1) | 15 |  |  |  |
| callable:createAlert | 5 |  | 11.88 s | 14.87 s | 14.87 s | 5 (5) | 2 (2) | 6 |  |  |  |
| callable:createIdgMeeting | 2 |  | 2.74 s | 13.42 s | 13.42 s | 65.5 (67) | 2 (2) | 5 |  |  |  |
| callable:createTask | 28 |  | 8.59 s | 13.73 s | 13.96 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:dischargePatient | 2 | 2 | 52.55 s | 53.28 s | 53.28 s | 20.5 (24) | 0 (0) | 13.5 | 8 |  |  |
| callable:generateHandoff | 70 |  | 8.21 s | 15.13 s | 26.77 s | 236.9 (295) | 1 (1) | 53.3 |  |  |  |
| callable:generateIdgPrep(bulk) | 2 |  | 145.16 s | 203.53 s | 203.53 s | 1465.5 (1568) | 26 (26) | 179 |  |  |  |
| callable:generateIdgPrep(single) | 52 | 20 | 16.56 s | 47.93 s | 50.34 s | 59.7 (79) | 1.6 (2) | 14.6 | 94 |  |  |
| callable:logTriageCall | 40 |  | 15.49 s | 32.54 s | 34.46 s | 25.4 (27) | 3.4 (5) | 8.4 |  |  |  |
| callable:recallMessage | 10 |  | 4.97 s | 13.64 s | 13.64 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:recordDeath | 8 | 1 | 12.47 s | 56.61 s | 56.61 s | 30 (40) | 14.1 (18) | 13.3 | 13 |  |  |
| callable:recordRecertification | 6 |  | 7.59 s | 11.93 s | 11.93 s | 8 (8) | 5 (5) | 5 |  |  |  |
| callable:rejectReferral | 2 |  | 3.68 s | 12.67 s | 12.67 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:resolveAlert | 66 |  | 1.94 s | 16.07 s | 21.69 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:resolveTriageCall | 37 |  | 6.63 s | 12.91 s | 14.71 s | 1.8 (3) | 3.6 (6) | 2.8 |  |  |  |
| callable:saveIdgNote | 102 |  | 15 ms | 10.96 s | 12.38 s | 5.0 (10) | 2 (2) | 6.4 | 80 |  |  |
| callable:scheduleVisit | 984 |  | 68 ms | 7.79 s | 14.30 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:searchMessages(common) | 19 |  | 8.54 s | 12.75 s | 12.75 s | 3246.4 (9479) | 1 (1) | 22 |  |  |  |
| callable:searchMessages(name) | 15 |  | 10.61 s | 24.24 s | 24.24 s | 3698.1 (10012) | 1 (1) | 25.2 |  |  |  |
| callable:searchMessages(rare) | 15 |  | 8.92 s | 18.94 s | 18.94 s | 3472.8 (10454) | 1 (1) | 23.4 |  |  |  |
| callable:sendBroadcast(all) | 1 |  | 5.25 s | 5.25 s | 5.25 s | 70 (70) | 3 (3) | 3 |  |  |  |
| callable:sendBroadcast(discipline) | 1 |  | 2.18 s | 2.18 s | 2.18 s | 15 (15) | 3 (3) | 3 |  |  |  |
| callable:sendBroadcast(team) | 1 |  | 10.60 s | 10.60 s | 10.60 s | 37 (37) | 3 (3) | 4 |  |  |  |
| callable:sendRoleMessage | 20 |  | 10.52 s | 19.31 s | 20.67 s | 24 (24) | 2.1 (3) | 7 |  |  |  |
| callable:setVisitFrequencies | 10 |  | 7.59 s | 10.83 s | 10.83 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:summarizeChannel | 14 |  | 7.98 s | 13.04 s | 13.04 s | 17.9 (37) | 1 (1) | 4 |  |  |  |
| callable:updateBereavementContact | 21 |  | 8.88 s | 12.26 s | 12.80 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:updateTask(done) | 175 |  | 8.30 s | 13.35 s | 30.25 s | 2.0 (6) | 2 (2) | 3.1 | 3 |  |  |
| callable:updateVisit | 21 |  | 7.68 s | 11.15 s | 11.73 s | 2 (2) | 2 (2) | 3 |  |  |  |
| client:message.create | 4998 |  | 8.94 s | 13.81 s | 32.45 s | 0 (0) | 1 (1) | 1 |  |  |  |
| client:referral.create | 12 |  | 9.06 s | 13.50 s | 13.50 s | 0 (0) | 1 (1) | 1 |  |  |  |
| job:checkDeadlines | 7 |  | 500 ms | 8.22 s | 8.22 s | 313.1 (1139) | 83.9 (473) | 169.7 |  |  |  |
| job:checkMissedVisits | 336 |  | 45 ms | 117 ms | 273 ms | 2.7 (16) | 0.5 (12) | 2.7 |  |  |  |
| job:computeDailyMetrics | 7 |  | 128 ms | 192 ms | 192 ms | 226.4 (645) | 1 (1) | 15 |  |  |  |
| job:purgeExpiredMessages | 1 |  | 60 ms | 60 ms | 60 ms | 228 (228) | 0 (0) | 2 |  |  |  |
| task:escalateAlert | 605 |  | 164 ms | 690 ms | 1.22 s | 4.8 (35) | 1.3 (2) | 4.3 |  | 2108 | 195 |
| trigger:onAlertCreated | 450 |  | 57 ms | 79 ms | 109 ms | 5.9 (35) | 0 (0) | 1.9 |  | 4391 | 410 |
| trigger:onMessageCreated | 5021 |  | 8.26 s | 15.88 s | 40.57 s | 7.0 (69) | 1.1 (4) | 3.3 | 71 | 54219 |  |
| trigger:onReferralUploaded | 12 |  | 19.36 s | 37.09 s | 37.09 s | 2 (2) | 3 (3) | 5 |  |  |  |

## Scheduled jobs

| job | runs | total | avg | max |
|---|---:|---:|---:|---:|
| job:checkDeadlines | 7 | 11.33 s | 1.62 s | 8.22 s |
| job:computeDailyMetrics | 7 | 947 ms | 135 ms | 192 ms |
| job:checkMissedVisits | 336 | 17.89 s | 53 ms | 273 ms |
| job:purgeExpiredMessages | 1 | 60 ms | 60 ms | 60 ms |

## Setup

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| setup:acceptInvite | 68 |  | 30 ms | 2.84 s | 6.54 s | 4.3 (12) | 5.0 (6) | 5.4 | 6 |  |  |
| setup:admitPatient | 100 |  | 205 ms | 324 ms | 432 ms | 14 (14) | 10 (10) | 6 |  |  |  |
| setup:admitPatient(history) | 40 |  | 166 ms | 231 ms | 235 ms | 14 (14) | 10 (10) | 6 |  |  |  |
| setup:createChannel(direct) | 60 |  | 94 ms | 114 ms | 118 ms | 3 (3) | 2 (2) | 3 |  |  |  |
| setup:createChannel(group) | 1 |  | 6 ms | 6 ms | 6 ms | 9 (9) | 2 (2) | 2 |  |  |  |
| setup:createChannel(team) | 2 |  | 15 ms | 19 ms | 19 ms | 35 (36) | 2 (2) | 3 |  |  |  |
| setup:createOrg | 1 |  | 828 ms | 828 ms | 828 ms | 1 (1) | 5 (5) | 2 |  |  |  |
| setup:dischargePatient(history) | 22 | 16 | 16.95 s | 18.88 s | 20.51 s | 42.2 (52) | 3.5 (13) | 22.5 | 64 |  |  |
| setup:inviteMember | 68 |  | 184 ms | 329 ms | 341 ms | 3.0 (4) | 2 (2) | 4.9 |  |  |  |
| setup:recordDeath(history) | 186 | 175 | 18.19 s | 20.29 s | 21.31 s | 56.2 (58) | 0.9 (16) | 29.0 | 706 |  |  |
| setup:setVisitFrequencies | 100 |  | 70 ms | 120 ms | 237 ms | 1 (1) | 2 (2) | 2 |  |  |  |
| trigger:onMemberWritten | 68 |  | 11 ms | 28 ms | 39 ms | 1 (1) | 0 (0) | 2 |  |  |  |

## Errors

```
{
  "callable:dischargePatient": {
    "10 10 ABORTED: The referenced transaction has expired or is no longer valid.": 2
  },
  "callable:generateIdgPrep(single)": {
    "internal AI generation failed. Try again.": 20
  },
  "callable:recordDeath": {
    "10 10 ABORTED: The referenced transaction has expired or is no longer valid.": 1
  }
}
```