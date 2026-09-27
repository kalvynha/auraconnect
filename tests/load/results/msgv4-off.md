# Load test: msgv4-off

Config: {"seed":20260927,"historyWeeks":2,"concurrency":24,"acceptConcurrency":4,"geminiLatencyMs":800,"messagesPerWeek":2000,"fcmLatencyMs":30,"tasksLatencyMs":15,"purge":true,"v4Prefs":false}  
Wall time: setup 170.86 s, week 396.93 s. Fakes: {"fcmCalls":3347,"fcmTokens":24843,"tasksEnqueued":1208,"geminiCalls":197}

## Busy week (per operation)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| callable:acceptReferral | 10 |  | 1.35 s | 2.22 s | 2.22 s | 5 (5) | 5 (5) | 6 |  |  |  |
| callable:ackAlert | 281 |  | 143 ms | 1.28 s | 3.20 s | 2 (2) | 1.9 (2) | 3 |  |  |  |
| callable:admitPatient | 10 |  | 1.27 s | 2.61 s | 2.61 s | 14 (14) | 10 (10) | 7 |  |  |  |
| callable:assignTriageCall | 5 | 4 | 68 ms | 983 ms | 983 ms | 4.2 (5) | 0.6 (3) | 4.4 |  | 2 |  |
| callable:cancelVisit | 49 |  | 437 ms | 1.65 s | 2.43 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:changeLevelOfCare | 2 |  | 2.09 s | 2.15 s | 2.15 s | 2 (2) | 3 (3) | 3 |  |  |  |
| callable:completeIdgMeeting | 2 |  | 42 ms | 50 ms | 50 ms | 41.5 (58) | 68.5 (111) | 8 |  |  |  |
| callable:completeMilestone | 10 |  | 535 ms | 1.49 s | 1.49 s | 5 (5) | 2 (2) | 6 |  |  |  |
| callable:completeVisit | 905 |  | 1.08 s | 2.51 s | 5.77 s | 3.0 (5) | 2 (2) | 4.0 | 1 |  |  |
| callable:computeMetrics | 7 |  | 1.48 s | 2.41 s | 2.41 s | 889.1 (1107) | 1 (1) | 16 |  |  |  |
| callable:createAlert | 5 |  | 2.70 s | 4.59 s | 4.59 s | 6 (6) | 3 (3) | 8 |  |  |  |
| callable:createIdgMeeting | 2 |  | 532 ms | 794 ms | 794 ms | 66.5 (68) | 2 (2) | 6 |  |  |  |
| callable:createTask | 28 |  | 912 ms | 3.17 s | 3.49 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:dischargePatient | 2 |  | 1.94 s | 22.59 s | 22.59 s | 26.5 (34) | 15 (17) | 11.5 | 2 |  |  |
| callable:generateHandoff | 70 |  | 3.23 s | 5.78 s | 7.30 s | 189.5 (278) | 2 (2) | 65.6 |  |  |  |
| callable:generateIdgPrep(bulk) | 2 |  | 13.83 s | 16.78 s | 16.78 s | 1226.5 (1267) | 27 (27) | 182 |  |  |  |
| callable:generateIdgPrep(single) | 52 |  | 4.13 s | 8.16 s | 8.72 s | 51.7 (66) | 3 (3) | 15.7 | 45 |  |  |
| callable:logTriageCall | 40 |  | 3.26 s | 6.19 s | 6.47 s | 26 (27) | 5 (5) | 10 |  |  |  |
| callable:recallMessage | 10 | 1 | 770 ms | 3.85 s | 3.85 s | 3 (3) | 2.9 (4) | 3.9 |  |  |  |
| callable:recordDeath | 8 |  | 9.96 s | 27.10 s | 27.10 s | 23.6 (31) | 18.5 (19) | 12.9 | 7 |  |  |
| callable:recordRecertification | 6 |  | 1.03 s | 1.76 s | 1.76 s | 12.7 (13) | 8 (9) | 9.7 |  |  |  |
| callable:rejectReferral | 2 |  | 212 ms | 469 ms | 469 ms | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:resolveAlert | 112 |  | 133 ms | 1.86 s | 3.27 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:resolveTriageCall | 35 | 3 | 1.33 s | 2.84 s | 3.58 s | 3.3 (4) | 4.2 (6) | 4.3 |  |  |  |
| callable:saveIdgNote | 102 | 41 | 6.92 s | 19.57 s | 20.85 s | 8.8 (13) | 1.2 (2) | 11.4 | 219 |  |  |
| callable:scheduleVisit | 994 |  | 96 ms | 237 ms | 2.98 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:searchMessages(common) | 12 |  | 2.35 s | 4.89 s | 4.89 s | 1032.7 (2326) | 2 (2) | 29.4 |  |  |  |
| callable:searchMessages(name) | 18 |  | 2.69 s | 5.94 s | 5.94 s | 1140.1 (3054) | 2 (2) | 33.7 |  |  |  |
| callable:searchMessages(rare) | 19 |  | 2.98 s | 5.89 s | 5.89 s | 955.4 (3013) | 2 (2) | 28.7 | 1 |  |  |
| callable:sendBroadcast(all) | 1 |  | 2.48 s | 2.48 s | 2.48 s | 71 (71) | 4 (4) | 5 |  |  |  |
| callable:sendBroadcast(discipline) | 1 |  | 2.05 s | 2.05 s | 2.05 s | 16 (16) | 4 (4) | 5 |  |  |  |
| callable:sendBroadcast(team) | 1 |  | 3.31 s | 3.31 s | 3.31 s | 38 (38) | 4 (4) | 6 |  |  |  |
| callable:sendRoleMessage | 20 |  | 1.57 s | 2.89 s | 4.48 s | 25 (25) | 2.1 (3) | 8 |  |  |  |
| callable:setVisitFrequencies | 10 |  | 554 ms | 1.94 s | 1.94 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:summarizeChannel | 14 |  | 3.11 s | 4.76 s | 4.76 s | 11.6 (19) | 2 (2) | 7 |  |  |  |
| callable:updateBereavementContact | 21 |  | 969 ms | 2.00 s | 2.42 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:updateTask(done) | 175 |  | 1.23 s | 2.43 s | 3.40 s | 3 (3) | 2 (2) | 4 |  |  |  |
| callable:updateVisit | 15 |  | 1.16 s | 3.24 s | 3.24 s | 3 (3) | 2 (2) | 4 |  |  |  |
| client:message.create | 2002 |  | 1.42 s | 2.96 s | 5.88 s | 0 (0) | 1 (1) | 1 |  |  |  |
| client:referral.create | 12 |  | 532 ms | 2.15 s | 2.15 s | 0 (0) | 1 (1) | 1 |  |  |  |
| job:checkDeadlines | 7 |  | 762 ms | 19.87 s | 19.87 s | 146.9 (155) | 248.7 (1539) | 142.3 |  |  |  |
| job:checkMissedVisits | 336 |  | 40 ms | 117 ms | 198 ms | 2.6 (14) | 0.5 (8) | 2.6 |  |  |  |
| job:computeDailyMetrics | 7 |  | 194 ms | 293 ms | 293 ms | 153.4 (160) | 1 (1) | 15 |  |  |  |
| job:purgeExpiredMessages | 1 |  | 68 ms | 68 ms | 68 ms | 224 (224) | 0 (0) | 3 |  |  |  |
| task:escalateAlert | 1208 |  | 573 ms | 1.24 s | 2.33 s | 3.7 (8) | 1.4 (2) | 4.4 |  | 1738 | 429 |
| trigger:onAlertCreated | 935 |  | 84 ms | 151 ms | 417 ms | 2.9 (35) | 0 (0) | 1.8 |  | 3901 | 779 |
| trigger:onMessageCreated | 2038 |  | 1.11 s | 3.14 s | 7.90 s | 13.4 (139) | 1.1 (6) | 5.2 | 8 | 19202 |  |
| trigger:onReferralUploaded | 12 |  | 3.47 s | 6.02 s | 6.02 s | 8.6 (14) | 3 (3) | 7 |  |  |  |

## Scheduled jobs

| job | runs | total | avg | max |
|---|---:|---:|---:|---:|
| job:checkDeadlines | 7 | 24.26 s | 3.47 s | 19.87 s |
| job:computeDailyMetrics | 7 | 1.50 s | 214 ms | 293 ms |
| job:checkMissedVisits | 336 | 15.81 s | 47 ms | 198 ms |
| job:purgeExpiredMessages | 1 | 68 ms | 68 ms | 68 ms |

## Setup

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| setup:acceptInvite | 68 |  | 98 ms | 153 ms | 181 ms | 5.0 (6) | 5.0 (6) | 6.9 |  |  |  |
| setup:admitPatient | 100 |  | 499 ms | 608 ms | 655 ms | 14 (14) | 10 (10) | 7 |  |  |  |
| setup:admitPatient(history) | 40 | 5 | 341 ms | 18.33 s | 20.33 s | 14.6 (18) | 8.8 (10) | 8.1 | 22 |  |  |
| setup:createChannel(direct) | 60 |  | 88 ms | 105 ms | 125 ms | 4 (4) | 2 (2) | 4 |  |  |  |
| setup:createChannel(group) | 1 |  | 7 ms | 7 ms | 7 ms | 10 (10) | 2 (2) | 3 |  |  |  |
| setup:createChannel(team) | 2 |  | 12 ms | 14 ms | 14 ms | 36 (37) | 2 (2) | 4 |  |  |  |
| setup:createOrg | 1 |  | 700 ms | 700 ms | 700 ms | 1 (1) | 22 (22) | 2 |  |  |  |
| setup:dischargePatient(history) | 12 | 7 | 16.76 s | 20.06 s | 20.06 s | 41 (53) | 5.8 (14) | 22.3 | 32 |  |  |
| setup:inviteMember | 68 |  | 398 ms | 523 ms | 542 ms | 4.0 (5) | 2 (2) | 5.9 |  |  |  |
| setup:recordDeath(history) | 170 | 158 | 18.49 s | 20.66 s | 21.81 s | 52.1 (54) | 1.3 (19) | 29.0 | 644 |  |  |
| setup:setVisitFrequencies | 100 |  | 196 ms | 269 ms | 273 ms | 2 (2) | 2 (2) | 3 |  |  |  |
| trigger:onMemberWritten | 68 |  | 34 ms | 60 ms | 88 ms | 1 (1) | 0 (0) | 2 |  |  |  |

## Errors

```
{
  "callable:recallMessage": {
    "permission-denied You are not a member of this channel.": 1
  },
  "callable:assignTriageCall": {
    "permission-denied Only the assigned clinician, an alert recipient or an admin can do this.": 4
  },
  "callable:resolveTriageCall": {
    "permission-denied Only the assigned clinician, an alert recipient or an admin can do this.": 3
  },
  "callable:saveIdgNote": {
    "10 10 ABORTED: Transaction lock timeout.": 41
  }
}
```