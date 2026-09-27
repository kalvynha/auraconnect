# bench-after (sequential, no background load; Gemini fake 800 ms)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bench:checkDeadlines(job) | 3 |  | 135 ms | 304 ms | 304 ms | 123 (136) | 143.7 (403) | 90.3 |  |  |  |
| bench:computeMetrics | 1 |  | 118 ms | 118 ms | 118 ms | 331 (331) | 1 (1) | 15 |  |  |  |
| bench:createAlert | 5 |  | 12 ms | 15 ms | 15 ms | 4 (4) | 2 (2) | 5 |  |  |  |
| bench:generateHandoff | 10 |  | 1.37 s | 1.58 s | 1.58 s | 135 (135) | 1 (1) | 43 |  |  |  |
| bench:generateIdgPrep(bulk 25) | 1 |  | 6.97 s | 6.97 s | 6.97 s | 1075 (1075) | 26 (26) | 179 |  |  |  |
| bench:recordDeath | 4 |  | 73 ms | 113 ms | 113 ms | 16 (16) | 16 (16) | 8 |  |  |  |
| bench:searchMessages(common) | 4 |  | 491 ms | 1.58 s | 1.58 s | 1476.5 (2453) | 1 (1) | 31.3 |  |  |  |
| bench:searchMessages(name) | 2 |  | 523 ms | 2.73 s | 2.73 s | 5978 (10202) | 1 (1) | 57.5 |  |  |  |
| bench:searchMessages(rare) | 3 |  | 2.35 s | 2.61 s | 2.61 s | 7173.3 (10202) | 1 (1) | 71 |  |  |  |
