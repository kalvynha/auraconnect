# Load test: after

Config: {"seed":20260927,"historyWeeks":12,"concurrency":24,"acceptConcurrency":4,"geminiLatencyMs":800,"messagesPerWeek":5000,"fcmLatencyMs":30,"tasksLatencyMs":15,"purge":true}  
Wall time: setup 176.11 s, week 2596.43 s. Fakes: {"fcmCalls":5511,"fcmTokens":59950,"tasksEnqueued":591,"geminiCalls":196}

## Busy week (per operation)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| callable:acceptReferral | 10 |  | 7.61 s | 10.54 s | 10.54 s | 2 (2) | 5 (5) | 3 |  |  |  |
| callable:ackAlert | 150 |  | 635 ms | 13.64 s | 17.97 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:admitPatient | 10 |  | 8.97 s | 11.61 s | 11.61 s | 14 (14) | 10 (10) | 6 |  |  |  |
| callable:assignTriageCall | 5 |  | 9.07 s | 11.46 s | 11.46 s | 2.4 (3) | 2.4 (3) | 3.4 |  |  |  |
| callable:cancelVisit | 38 |  | 7.41 s | 12.77 s | 17.00 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:changeLevelOfCare | 2 |  | 8.87 s | 9.00 s | 9.00 s | 1 (1) | 3 (3) | 2 |  |  |  |
| callable:completeIdgMeeting | 2 |  | 47 ms | 57 ms | 57 ms | 50 (50) | 124 (126) | 4 |  |  |  |
| callable:completeMilestone | 10 |  | 8.85 s | 13.18 s | 13.18 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:completeVisit | 910 |  | 8.86 s | 14.89 s | 26.87 s | 2.0 (8) | 2 (2) | 3.1 | 16 |  |  |
| callable:computeMetrics | 7 |  | 9.53 s | 10.71 s | 10.71 s | 446.9 (629) | 1 (1) | 15 |  |  |  |
| callable:createAlert | 5 |  | 10.73 s | 12.23 s | 12.23 s | 4 (4) | 2 (2) | 5 |  |  |  |
| callable:createIdgMeeting | 2 |  | 12.03 s | 12.08 s | 12.08 s | 65 (66) | 2 (2) | 5 |  |  |  |
| callable:createTask | 28 |  | 9.37 s | 15.02 s | 15.92 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:dischargePatient | 2 | 1 | 32.08 s | 54.28 s | 54.28 s | 24.5 (26) | 7 (14) | 13 | 6 |  |  |
| callable:generateHandoff | 70 |  | 9.92 s | 15.05 s | 23.80 s | 239.4 (307) | 1 (1) | 51.7 |  |  |  |
| callable:generateIdgPrep(bulk) | 2 |  | 65.72 s | 180.12 s | 180.12 s | 1477 (1577) | 26 (26) | 179 |  |  |  |
| callable:generateIdgPrep(single) | 51 |  | 3.10 s | 10.13 s | 10.89 s | 59.2 (75) | 2 (2) | 12.0 | 25 |  |  |
| callable:logTriageCall | 40 |  | 9.91 s | 37.26 s | 37.96 s | 24.8 (26) | 3.1 (5) | 7.5 |  |  |  |
| callable:recallMessage | 10 |  | 7.62 s | 17.55 s | 17.55 s | 2 (2) | 2.2 (3) | 3 |  |  |  |
| callable:recordDeath | 8 | 3 | 43.40 s | 54.85 s | 54.85 s | 27 (37) | 10 (17) | 13 | 20 |  |  |
| callable:recordRecertification | 6 |  | 2.89 s | 12.10 s | 12.10 s | 8 (8) | 5 (5) | 5 |  |  |  |
| callable:rejectReferral | 2 |  | 4.02 s | 10.57 s | 10.57 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:resolveAlert | 58 |  | 2.87 s | 14.01 s | 15.84 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:resolveTriageCall | 37 |  | 8.43 s | 13.47 s | 17.41 s | 1.8 (3) | 3.6 (6) | 2.8 |  |  |  |
| callable:saveIdgNote | 101 |  | 19 ms | 15.01 s | 18.05 s | 5.7 (12) | 2 (2) | 7.1 | 106 |  |  |
| callable:scheduleVisit | 1000 |  | 56 ms | 6.61 s | 17.23 s | 2 (2) | 2 (2) | 3 |  |  |  |
| callable:searchMessages(common) | 23 |  | 10.15 s | 15.01 s | 22.69 s | 995.4 (2417) | 1 (1) | 23.4 |  |  |  |
| callable:searchMessages(name) | 14 |  | 9.05 s | 13.93 s | 13.93 s | 2654.9 (5681) | 1 (1) | 29.1 |  |  |  |
| callable:searchMessages(rare) | 12 |  | 10.08 s | 14.61 s | 14.61 s | 3070.2 (6719) | 1 (1) | 32 |  |  |  |
| callable:sendBroadcast(all) | 1 |  | 3.60 s | 3.60 s | 3.60 s | 70 (70) | 3 (3) | 3 |  |  |  |
| callable:sendBroadcast(discipline) | 1 |  | 7.15 s | 7.15 s | 7.15 s | 15 (15) | 3 (3) | 3 |  |  |  |
| callable:sendBroadcast(team) | 1 |  | 823 ms | 823 ms | 823 ms | 37 (37) | 3 (3) | 4 |  |  |  |
| callable:sendRoleMessage | 20 |  | 11.17 s | 18.86 s | 22.84 s | 24 (24) | 2.1 (3) | 7 |  |  |  |
| callable:setVisitFrequencies | 10 |  | 3.56 s | 12.15 s | 12.15 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:summarizeChannel | 14 |  | 6.99 s | 17.90 s | 17.90 s | 17.1 (37) | 1 (1) | 4 |  |  |  |
| callable:updateBereavementContact | 21 |  | 5.13 s | 11.60 s | 11.84 s | 1 (1) | 2 (2) | 2 |  |  |  |
| callable:updateTask(done) | 175 |  | 8.54 s | 14.22 s | 25.33 s | 2.0 (4) | 2 (2) | 3.0 | 1 |  |  |
| callable:updateVisit | 22 |  | 8.80 s | 17.50 s | 17.97 s | 2.2 (6) | 2 (2) | 3.3 | 2 |  |  |
| client:message.create | 4998 |  | 9.16 s | 14.54 s | 37.66 s | 0 (0) | 1 (1) | 1 |  |  |  |
| client:referral.create | 12 |  | 7.72 s | 23.43 s | 23.43 s | 0 (0) | 1 (1) | 1 |  |  |  |
| job:checkDeadlines | 7 |  | 391 ms | 4.72 s | 4.72 s | 143.6 (156) | 81.1 (456) | 54 |  |  |  |
| job:checkMissedVisits | 336 |  | 45 ms | 123 ms | 168 ms | 2.7 (10) | 0.6 (8) | 2.7 |  |  |  |
| job:computeDailyMetrics | 7 |  | 123 ms | 164 ms | 164 ms | 223.7 (634) | 1 (1) | 15 |  |  |  |
| job:purgeExpiredMessages | 1 |  | 77.20 s | 77.20 s | 77.20 s | 15471 (15471) | 15245 (15245) | 284 |  |  |  |
| task:escalateAlert | 591 |  | 171 ms | 678 ms | 1.22 s | 4.8 (37) | 1.3 (2) | 4.3 |  | 2093 | 193 |
| trigger:onAlertCreated | 450 |  | 57 ms | 84 ms | 141 ms | 6.2 (35) | 0 (0) | 1.9 |  | 4602 | 398 |
| trigger:onMessageCreated | 5021 |  | 8.70 s | 17.55 s | 47.91 s | 6.9 (69) | 1.1 (4) | 3.2 | 72 | 53255 |  |
| trigger:onReferralUploaded | 12 |  | 20.10 s | 37.59 s | 37.59 s | 2 (2) | 3 (3) | 5 |  |  |  |

## Scheduled jobs

| job | runs | total | avg | max |
|---|---:|---:|---:|---:|
| job:checkDeadlines | 7 | 6.70 s | 958 ms | 4.72 s |
| job:computeDailyMetrics | 7 | 885 ms | 126 ms | 164 ms |
| job:checkMissedVisits | 336 | 18.50 s | 55 ms | 168 ms |
| job:purgeExpiredMessages | 1 | 77.20 s | 77.20 s | 77.20 s |

## Setup

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| setup:acceptInvite | 68 |  | 26 ms | 5.41 s | 6.29 s | 4.5 (12) | 5.0 (6) | 5.6 | 9 |  |  |
| setup:admitPatient | 100 |  | 205 ms | 303 ms | 327 ms | 14 (14) | 10 (10) | 6 |  |  |  |
| setup:admitPatient(history) | 40 | 2 | 192 ms | 3.44 s | 17.37 s | 14.2 (18) | 9.5 (10) | 6.5 | 9 |  |  |
| setup:createChannel(direct) | 60 |  | 47 ms | 66 ms | 67 ms | 3 (3) | 2 (2) | 3 |  |  |  |
| setup:createChannel(group) | 1 |  | 5 ms | 5 ms | 5 ms | 9 (9) | 2 (2) | 2 |  |  |  |
| setup:createChannel(team) | 2 |  | 8 ms | 9 ms | 9 ms | 35 (36) | 2 (2) | 3 |  |  |  |
| setup:createOrg | 1 |  | 873 ms | 873 ms | 873 ms | 1 (1) | 5 (5) | 2 |  |  |  |
| setup:dischargePatient(history) | 20 | 16 | 17.32 s | 19.25 s | 19.68 s | 44.8 (52) | 2.6 (13) | 24 | 64 |  |  |
| setup:inviteMember | 68 |  | 209 ms | 326 ms | 329 ms | 3.0 (4) | 2 (2) | 4.9 |  |  |  |
| setup:recordDeath(history) | 179 | 164 | 18.22 s | 20.55 s | 21.39 s | 50.0 (52) | 1.3 (16) | 26.9 | 677 |  |  |
| setup:setVisitFrequencies | 100 |  | 66 ms | 130 ms | 151 ms | 1 (1) | 2 (2) | 2 |  |  |  |
| trigger:onMemberWritten | 68 |  | 10 ms | 17 ms | 21 ms | 1 (1) | 0 (0) | 2 |  |  |  |

## Errors

```
{
  "callable:recordDeath": {
    "10 10 ABORTED: The referenced transaction has expired or is no longer valid.": 3
  },
  "callable:dischargePatient": {
    "10 10 ABORTED: The referenced transaction has expired or is no longer valid.": 1
  }
}
```