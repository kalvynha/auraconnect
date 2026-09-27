# baseline → after

| operation | n | p50 | p95 | max | reads avg (max) | writes avg | rpcs avg | tx retries | errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| callable:acceptReferral | 10 | 4.24 s → 7.61 s | 13.74 s → 10.54 s | 13.74 s → 10.54 s | 2 (2) | 5 | 3 | 0 | 0 |
| callable:ackAlert | 140 → 150 | 315 ms → 635 ms | 11.46 s → 13.64 s | 14.14 s → 17.97 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:admitPatient | 10 | 8.67 s → 8.97 s | 11.95 s → 11.61 s | 11.95 s → 11.61 s | 14 (14) | 10 | 6 | 0 | 0 |
| callable:assignTriageCall | 3 → 5 | 3.78 s → 9.07 s | 6.60 s → 11.46 s | 6.60 s → 11.46 s | 2 (2) → 2.4 (3) | 2 → 2.4 | 3 → 3.4 | 0 | 0 |
| callable:cancelVisit | 37 → 38 | 7.44 s → 7.41 s | 14.92 s → 12.77 s | 14.92 s → 17.00 s | 2 (2) | 2 | 3 | 0 | 0 |
| callable:changeLevelOfCare | 2 | 7.05 s → 8.87 s | 11.96 s → 9.00 s | 11.96 s → 9.00 s | 1 (1) | 3 | 2 | 0 | 0 |
| callable:completeIdgMeeting | 2 | 36 ms → 47 ms | 38 ms → 57 ms | 38 ms → 57 ms | 47.5 (49) → 50 (50) | 112 → 124 | 4 | 0 | 0 |
| callable:completeMilestone | 10 | 7.75 s → 8.85 s | 12.04 s → 13.18 s | 12.04 s → 13.18 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:completeVisit | 906 → 910 | 8.45 s → 8.86 s | 13.56 s → 14.89 s | 33.74 s → 26.87 s | 2.0 (8) | 2 | 3.0 → 3.1 | 9 → 16 | 0 |
| callable:computeMetrics | 7 | 4.58 s → 9.53 s | 12.26 s → 10.71 s | 12.26 s → 10.71 s | 448.3 (615) → 446.9 (629) | 1 | 15 | 0 | 0 |
| callable:createAlert | 5 | 11.88 s → 10.73 s | 14.87 s → 12.23 s | 14.87 s → 12.23 s | 5 (5) → 4 (4) | 2 | 6 → 5 | 0 | 0 |
| callable:createIdgMeeting | 2 | 2.74 s → 12.03 s | 13.42 s → 12.08 s | 13.42 s → 12.08 s | 65.5 (67) → 65 (66) | 2 | 5 | 0 | 0 |
| callable:createTask | 28 | 8.59 s → 9.37 s | 13.73 s → 15.02 s | 13.96 s → 15.92 s | 2 (2) | 2 | 3 | 0 | 0 |
| callable:dischargePatient | 2 | 52.55 s → 32.08 s | 53.28 s → 54.28 s | 53.28 s → 54.28 s | 20.5 (24) → 24.5 (26) | 0 → 7 | 13.5 → 13 | 8 → 6 | 2 → 1 |
| callable:generateHandoff | 70 | 8.21 s → 9.92 s | 15.13 s → 15.05 s | 26.77 s → 23.80 s | 236.9 (295) → 239.4 (307) | 1 | 53.3 → 51.7 | 0 | 0 |
| callable:generateIdgPrep(bulk) | 2 | 145.16 s → 65.72 s | 203.53 s → 180.12 s | 203.53 s → 180.12 s | 1465.5 (1568) → 1477 (1577) | 26 | 179 | 0 | 0 |
| callable:generateIdgPrep(single) | 52 → 51 | 16.56 s → 3.10 s | 47.93 s → 10.13 s | 50.34 s → 10.89 s | 59.7 (79) → 59.2 (75) | 1.6 → 2 | 14.6 → 12.0 | 94 → 25 | 20 → 0 |
| callable:logTriageCall | 40 | 15.49 s → 9.91 s | 32.54 s → 37.26 s | 34.46 s → 37.96 s | 25.4 (27) → 24.8 (26) | 3.4 → 3.1 | 8.4 → 7.5 | 0 | 0 |
| callable:recallMessage | 10 | 4.97 s → 7.62 s | 13.64 s → 17.55 s | 13.64 s → 17.55 s | 2 (2) | 2 → 2.2 | 3 | 0 | 0 |
| callable:recordDeath | 8 | 12.47 s → 43.40 s | 56.61 s → 54.85 s | 56.61 s → 54.85 s | 30 (40) → 27 (37) | 14.1 → 10 | 13.3 → 13 | 13 → 20 | 1 → 3 |
| callable:recordRecertification | 6 | 7.59 s → 2.89 s | 11.93 s → 12.10 s | 11.93 s → 12.10 s | 8 (8) | 5 | 5 | 0 | 0 |
| callable:rejectReferral | 2 | 3.68 s → 4.02 s | 12.67 s → 10.57 s | 12.67 s → 10.57 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:resolveAlert | 66 → 58 | 1.94 s → 2.87 s | 16.07 s → 14.01 s | 21.69 s → 15.84 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:resolveTriageCall | 37 | 6.63 s → 8.43 s | 12.91 s → 13.47 s | 14.71 s → 17.41 s | 1.8 (3) | 3.6 | 2.8 | 0 | 0 |
| callable:saveIdgNote | 102 → 101 | 15 ms → 19 ms | 10.96 s → 15.01 s | 12.38 s → 18.05 s | 5.0 (10) → 5.7 (12) | 2 | 6.4 → 7.1 | 80 → 106 | 0 |
| callable:scheduleVisit | 984 → 1000 | 68 ms → 56 ms | 7.79 s → 6.61 s | 14.30 s → 17.23 s | 2 (2) | 2 | 3 | 0 | 0 |
| callable:searchMessages(common) | 19 → 23 | 8.54 s → 10.15 s | 12.75 s → 15.01 s | 12.75 s → 22.69 s | 3246.4 (9479) → 995.4 (2417) | 1 | 22 → 23.4 | 0 | 0 |
| callable:searchMessages(name) | 15 → 14 | 10.61 s → 9.05 s | 24.24 s → 13.93 s | 24.24 s → 13.93 s | 3698.1 (10012) → 2654.9 (5681) | 1 | 25.2 → 29.1 | 0 | 0 |
| callable:searchMessages(rare) | 15 → 12 | 8.92 s → 10.08 s | 18.94 s → 14.61 s | 18.94 s → 14.61 s | 3472.8 (10454) → 3070.2 (6719) | 1 | 23.4 → 32 | 0 | 0 |
| callable:sendBroadcast(all) | 1 | 5.25 s → 3.60 s | 5.25 s → 3.60 s | 5.25 s → 3.60 s | 70 (70) | 3 | 3 | 0 | 0 |
| callable:sendBroadcast(discipline) | 1 | 2.18 s → 7.15 s | 2.18 s → 7.15 s | 2.18 s → 7.15 s | 15 (15) | 3 | 3 | 0 | 0 |
| callable:sendBroadcast(team) | 1 | 10.60 s → 823 ms | 10.60 s → 823 ms | 10.60 s → 823 ms | 37 (37) | 3 | 4 | 0 | 0 |
| callable:sendRoleMessage | 20 | 10.52 s → 11.17 s | 19.31 s → 18.86 s | 20.67 s → 22.84 s | 24 (24) | 2.1 | 7 | 0 | 0 |
| callable:setVisitFrequencies | 10 | 7.59 s → 3.56 s | 10.83 s → 12.15 s | 10.83 s → 12.15 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:summarizeChannel | 14 | 7.98 s → 6.99 s | 13.04 s → 17.90 s | 13.04 s → 17.90 s | 17.9 (37) → 17.1 (37) | 1 | 4 | 0 | 0 |
| callable:updateBereavementContact | 21 | 8.88 s → 5.13 s | 12.26 s → 11.60 s | 12.80 s → 11.84 s | 1 (1) | 2 | 2 | 0 | 0 |
| callable:updateTask(done) | 175 | 8.30 s → 8.54 s | 13.35 s → 14.22 s | 30.25 s → 25.33 s | 2.0 (6) → 2.0 (4) | 2 | 3.1 → 3.0 | 3 → 1 | 0 |
| callable:updateVisit | 21 → 22 | 7.68 s → 8.80 s | 11.15 s → 17.50 s | 11.73 s → 17.97 s | 2 (2) → 2.2 (6) | 2 | 3 → 3.3 | 0 → 2 | 0 |
| client:message.create | 4998 | 8.94 s → 9.16 s | 13.81 s → 14.54 s | 32.45 s → 37.66 s | 0 (0) | 1 | 1 | 0 | 0 |
| client:referral.create | 12 | 9.06 s → 7.72 s | 13.50 s → 23.43 s | 13.50 s → 23.43 s | 0 (0) | 1 | 1 | 0 | 0 |
| job:checkDeadlines | 7 | 500 ms → 391 ms | 8.22 s → 4.72 s | 8.22 s → 4.72 s | 313.1 (1139) → 143.6 (156) | 83.9 → 81.1 | 169.7 → 54 | 0 | 0 |
| job:checkMissedVisits | 336 | 45 ms | 117 ms → 123 ms | 273 ms → 168 ms | 2.7 (16) → 2.7 (10) | 0.5 → 0.6 | 2.7 | 0 | 0 |
| job:computeDailyMetrics | 7 | 128 ms → 123 ms | 192 ms → 164 ms | 192 ms → 164 ms | 226.4 (645) → 223.7 (634) | 1 | 15 | 0 | 0 |
| job:purgeExpiredMessages | 1 | 60 ms → 77.20 s | 60 ms → 77.20 s | 60 ms → 77.20 s | 228 (228) → 15471 (15471) | 0 → 15245 | 2 → 284 | 0 | 0 |
| task:escalateAlert | 605 → 591 | 164 ms → 171 ms | 690 ms → 678 ms | 1.22 s | 4.8 (35) → 4.8 (37) | 1.3 | 4.3 | 0 | 0 |
| trigger:onAlertCreated | 450 | 57 ms | 79 ms → 84 ms | 109 ms → 141 ms | 5.9 (35) → 6.2 (35) | 0 | 1.9 | 0 | 0 |
| trigger:onMessageCreated | 5021 | 8.26 s → 8.70 s | 15.88 s → 17.55 s | 40.57 s → 47.91 s | 7.0 (69) → 6.9 (69) | 1.1 | 3.3 → 3.2 | 71 → 72 | 0 |
| trigger:onReferralUploaded | 12 | 19.36 s → 20.10 s | 37.09 s → 37.59 s | 37.09 s → 37.59 s | 2 (2) | 3 | 5 | 0 | 0 |

| job | runs | total | avg | max |
|---|---:|---:|---:|---:|
| job:checkDeadlines | 7 | 11.33 s → 6.70 s | 1.62 s → 958 ms | 8.22 s → 4.72 s |
| job:computeDailyMetrics | 7 | 947 ms → 885 ms | 135 ms → 126 ms | 192 ms → 164 ms |
| job:checkMissedVisits | 336 | 17.89 s → 18.50 s | 53 ms → 55 ms | 273 ms → 168 ms |
| job:purgeExpiredMessages | 1 | 60 ms → 77.20 s | 60 ms → 77.20 s | 60 ms → 77.20 s |

| setup op | p50 | p95 | max | tx retries | errors |
|---|---:|---:|---:|---:|---:|
| setup:acceptInvite | 30 ms → 26 ms | 2.84 s → 5.41 s | 6.54 s → 6.29 s | 6 → 9 | 0 |
| setup:admitPatient | 205 ms | 324 ms → 303 ms | 432 ms → 327 ms | 0 | 0 |
| setup:admitPatient(history) | 166 ms → 192 ms | 231 ms → 3.44 s | 235 ms → 17.37 s | 0 → 9 | 0 → 2 |
| setup:createChannel(direct) | 94 ms → 47 ms | 114 ms → 66 ms | 118 ms → 67 ms | 0 | 0 |
| setup:createChannel(group) | 6 ms → 5 ms | 6 ms → 5 ms | 6 ms → 5 ms | 0 | 0 |
| setup:createChannel(team) | 15 ms → 8 ms | 19 ms → 9 ms | 19 ms → 9 ms | 0 | 0 |
| setup:createOrg | 828 ms → 873 ms | 828 ms → 873 ms | 828 ms → 873 ms | 0 | 0 |
| setup:dischargePatient(history) | 16.95 s → 17.32 s | 18.88 s → 19.25 s | 20.51 s → 19.68 s | 64 | 16 |
| setup:inviteMember | 184 ms → 209 ms | 329 ms → 326 ms | 341 ms → 329 ms | 0 | 0 |
| setup:recordDeath(history) | 18.19 s → 18.22 s | 20.29 s → 20.55 s | 21.31 s → 21.39 s | 706 → 677 | 175 → 164 |
| setup:setVisitFrequencies | 70 ms → 66 ms | 120 ms → 130 ms | 237 ms → 151 ms | 0 | 0 |
| trigger:onMemberWritten | 11 ms → 10 ms | 28 ms → 17 ms | 39 ms → 21 ms | 0 | 0 |