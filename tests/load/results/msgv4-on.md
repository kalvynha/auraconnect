# Load test: msgv4-on

Config: {"seed":20260927,"historyWeeks":2,"concurrency":24,"acceptConcurrency":4,"geminiLatencyMs":800,"messagesPerWeek":2000,"fcmLatencyMs":30,"tasksLatencyMs":15,"purge":true,"v4Prefs":true}  
Wall time: setup 169.26 s, week 420.81 s. Fakes: {"fcmCalls":3320,"fcmTokens":18269,"tasksEnqueued":1184,"geminiCalls":198}

## Busy week (per operation)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| callable:acceptReferral | 10 |  | 808 ms | 3.66 s | 3.66 s | 5 (5) | 5 (5) | 6 |  |  |  |
| callable:ackAlert | 294 |  | 190 ms | 1.52 s | 3.15 s | 2 (2) | 1.9 (2) | 3 |  |  |  |
| callable:admitPatient | 10 |  | 1.85 s | 3.49 s | 3.49 s | 14 (14) | 10 (10) | 7 |  |  |  |
| callable:assignTriageCall | 5 | 3 | 133 ms | 1.96 s | 1.96 s | 4.4 (5) | 1.2 (3) | 4.8 |  | 4 |  |
| callable:cancelVisit | 50 |  | 466 ms | 2.74 s | 3.42 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:changeLevelOfCare | 2 |  | 207 ms | 2.23 s | 2.23 s | 2 (2) | 3 (3) | 3 |  |  |  |
| callable:completeIdgMeeting | 2 |  | 41 ms | 59 ms | 59 ms | 61 (62) | 117.5 (118) | 8 |  |  |  |
| callable:completeMilestone | 10 |  | 511 ms | 2.75 s | 2.75 s | 5 (5) | 2 (2) | 6 |  |  |  |
| callable:completeVisit | 890 |  | 1.34 s | 2.79 s | 5.08 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:computeMetrics | 7 |  | 1.89 s | 4.76 s | 4.76 s | 896.1 (1132) | 1 (1) | 16 |  |  |  |
| callable:createAlert | 5 |  | 3.46 s | 5.83 s | 5.83 s | 6 (6) | 3 (3) | 8 |  |  |  |
| callable:createIdgMeeting | 2 |  | 342 ms | 1.28 s | 1.28 s | 66.5 (67) | 2 (2) | 6 |  |  |  |
| callable:createTask | 28 |  | 1.39 s | 2.89 s | 3.57 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:dischargePatient | 2 |  | 10.64 s | 34.48 s | 34.48 s | 23.5 (24) | 14 (14) | 13 | 4 |  |  |
| callable:generateHandoff | 70 |  | 3.87 s | 6.12 s | 8.46 s | 199.5 (304) | 2 (2) | 65.8 |  |  |  |
| callable:generateIdgPrep(bulk) | 2 |  | 9.00 s | 22.35 s | 22.35 s | 1249.5 (1279) | 27 (27) | 182 |  |  |  |
| callable:generateIdgPrep(single) | 52 |  | 4.50 s | 16.00 s | 17.04 s | 51.4 (63) | 3 (3) | 15.8 | 48 |  |  |
| callable:logTriageCall | 40 |  | 4.64 s | 7.73 s | 10.91 s | 25.8 (27) | 5 (5) | 9.8 |  |  |  |
| callable:recallMessage | 10 | 2 | 1.35 s | 4.78 s | 4.78 s | 3 (3) | 2.5 (4) | 3.8 |  |  |  |
| callable:recordDeath | 8 |  | 16.45 s | 37.39 s | 37.39 s | 29.1 (35) | 18.8 (21) | 15.1 | 14 |  |  |
| callable:recordRecertification | 6 |  | 1.80 s | 4.77 s | 4.77 s | 12.7 (13) | 7.3 (9) | 9.7 |  |  |  |
| callable:rejectReferral | 2 |  | 1.18 s | 2.04 s | 2.04 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:resolveAlert | 115 |  | 148 ms | 1.20 s | 2.50 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:resolveTriageCall | 34 | 3 | 1.73 s | 3.67 s | 5.06 s | 3.5 (6) | 4.4 (6) | 4.4 | 1 |  |  |
| callable:saveIdgNote | 102 |  | 20 ms | 12.17 s | 12.70 s | 6.5 (11) | 2 (2) | 8.0 | 103 |  |  |
| callable:scheduleVisit | 987 |  | 102 ms | 646 ms | 3.08 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:searchMessages(common) | 16 |  | 2.86 s | 6.33 s | 6.33 s | 977.8 (2323) | 2 (2) | 27.7 |  |  |  |
| callable:searchMessages(name) | 16 |  | 3.16 s | 5.34 s | 5.34 s | 1143.1 (2870) | 2 (2) | 33.7 |  |  |  |
| callable:searchMessages(rare) | 17 |  | 2.78 s | 5.65 s | 5.65 s | 932 (2349) | 2 (2) | 27.1 |  |  |  |
| callable:sendBroadcast(all) | 1 |  | 4.56 s | 4.56 s | 4.56 s | 71 (71) | 4 (4) | 5 |  |  |  |
| callable:sendBroadcast(discipline) | 1 |  | 4.37 s | 4.37 s | 4.37 s | 16 (16) | 4 (4) | 5 |  |  |  |
| callable:sendBroadcast(team) | 1 |  | 2.96 s | 2.96 s | 2.96 s | 38 (38) | 4 (4) | 6 |  |  |  |
| callable:sendRoleMessage | 20 |  | 1.70 s | 5.54 s | 5.58 s | 25 (25) | 2 (3) | 8 |  |  |  |
| callable:setVisitFrequencies | 10 |  | 465 ms | 2.22 s | 2.22 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:summarizeChannel | 14 |  | 2.56 s | 5.26 s | 5.26 s | 9.8 (21) | 2 (2) | 7 |  |  |  |
| callable:updateBereavementContact | 21 |  | 1.50 s | 2.34 s | 2.75 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:updateTask(done) | 175 |  | 1.51 s | 3.41 s | 5.83 s | 3.0 (5) | 2 (2) | 4.1 | 3 |  |  |
| callable:updateVisit | 18 |  | 1.51 s | 3.16 s | 3.16 s | 3 (3) | 2 (2) | 4 |  |  |  |
| client:message.create | 2002 |  | 1.79 s | 3.51 s | 6.91 s | 0 (0) | 1 (1) | 1 |  |  |  |
| client:referral.create | 12 |  | 923 ms | 2.40 s | 2.40 s | 0 (0) | 1 (1) | 1 |  |  |  |
| job:checkDeadlines | 7 |  | 634 ms | 18.50 s | 18.50 s | 146.4 (155) | 247 (1533) | 141.3 |  |  |  |
| job:checkMissedVisits | 336 |  | 41 ms | 125 ms | 200 ms | 2.7 (15) | 0.6 (12) | 2.7 |  |  |  |
| job:computeDailyMetrics | 7 |  | 183 ms | 335 ms | 335 ms | 157.1 (163) | 1 (1) | 15 |  |  |  |
| job:purgeExpiredMessages | 1 |  | 42 ms | 42 ms | 42 ms | 227 (227) | 0 (0) | 3 |  |  |  |
| task:escalateAlert | 1184 |  | 544 ms | 1.33 s | 2.25 s | 3.7 (8) | 1.4 (2) | 4.3 |  | 1602 | 403 |
| trigger:onAlertCreated | 951 |  | 78 ms | 179 ms | 297 ms | 3.0 (35) | 0 (0) | 1.8 |  | 4148 | 781 |
| trigger:onMessageCreated | 2115 |  | 1.59 s | 4.51 s | 11.11 s | 15.7 (139) | 1.2 (6) | 5.8 | 10 | 12515 |  |
| trigger:onReferralUploaded | 12 |  | 3.46 s | 7.06 s | 7.06 s | 8.6 (14) | 3 (3) | 7 |  |  |  |

## Scheduled jobs

| job | runs | total | avg | max |
|---|---:|---:|---:|---:|
| job:checkDeadlines | 7 | 22.01 s | 3.14 s | 18.50 s |
| job:computeDailyMetrics | 7 | 1.44 s | 205 ms | 335 ms |
| job:checkMissedVisits | 336 | 16.97 s | 50 ms | 200 ms |
| job:purgeExpiredMessages | 1 | 42 ms | 42 ms | 42 ms |

## Setup

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| setup:acceptInvite | 68 |  | 98 ms | 157 ms | 244 ms | 5.0 (6) | 5.0 (6) | 6.9 |  |  |  |
| setup:admitPatient | 100 |  | 404 ms | 495 ms | 518 ms | 14 (14) | 10 (10) | 7 |  |  |  |
| setup:admitPatient(history) | 40 | 1 | 375 ms | 412 ms | 17.41 s | 14.2 (18) | 9.8 (10) | 7.3 | 6 |  |  |
| setup:createChannel(direct) | 60 |  | 55 ms | 70 ms | 71 ms | 4 (4) | 2 (2) | 4 |  |  |  |
| setup:createChannel(group) | 1 |  | 7 ms | 7 ms | 7 ms | 10 (10) | 2 (2) | 3 |  |  |  |
| setup:createChannel(team) | 2 |  | 9 ms | 10 ms | 10 ms | 36 (37) | 2 (2) | 4 |  |  |  |
| setup:createOrg | 1 |  | 657 ms | 657 ms | 657 ms | 1 (1) | 22 (22) | 2 |  |  |  |
| setup:dischargePatient(history) | 21 | 14 | 17.05 s | 19.34 s | 20.36 s | 43.6 (53) | 4.7 (14) | 23.8 | 62 |  |  |
| setup:inviteMember | 68 |  | 363 ms | 789 ms | 791 ms | 4.0 (5) | 2 (2) | 5.9 |  |  |  |
| setup:recordDeath(history) | 172 | 158 | 18.11 s | 20.29 s | 21.71 s | 52.2 (54) | 1.5 (19) | 29.1 | 653 |  |  |
| setup:setVisitFrequencies | 100 |  | 170 ms | 304 ms | 323 ms | 2 (2) | 2 (2) | 3 |  |  |  |
| trigger:onMemberWritten | 68 |  | 29 ms | 61 ms | 86 ms | 1 (1) | 0 (0) | 2 |  |  |  |

## Errors

```
{
  "callable:assignTriageCall": {
    "permission-denied Only the assigned clinician, an alert recipient or an admin can do this.": 3
  },
  "callable:resolveTriageCall": {
    "permission-denied Only the assigned clinician, an alert recipient or an admin can do this.": 3
  },
  "callable:recallMessage": {
    "permission-denied You are not a member of this channel.": 2
  }
}
```