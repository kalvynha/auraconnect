# bench-baseline (sequential, no background load; Gemini fake 800 ms)

| operation | n | err | p50 | p95 | max | reads avg (max) | writes avg (max) | rpcs avg | tx retries | push tokens | tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bench:checkDeadlines(job) | 3 |  | 159 ms | 2.42 s | 2.42 s | 411 (961) | 143.7 (403) | 289.3 |  |  |  |
| bench:computeMetrics | 1 |  | 131 ms | 131 ms | 131 ms | 331 (331) | 1 (1) | 15 |  |  |  |
| bench:createAlert | 5 |  | 18 ms | 19 ms | 19 ms | 5 (5) | 2 (2) | 6 |  |  |  |
| bench:generateHandoff | 10 |  | 2.19 s | 2.35 s | 2.35 s | 135 (135) | 1 (1) | 43 |  |  |  |
| bench:generateIdgPrep(bulk 25) | 1 |  | 24.03 s | 24.03 s | 24.03 s | 1075 (1075) | 26 (26) | 179 |  |  |  |
| bench:recordDeath | 4 |  | 68 ms | 74 ms | 74 ms | 22 (22) | 16 (16) | 10 |  |  |  |
| bench:searchMessages(common) | 4 |  | 517 ms | 1.87 s | 1.87 s | 5624.5 (10198) | 1 (1) | 31 |  |  |  |
| bench:searchMessages(name) | 2 |  | 550 ms | 1.63 s | 1.63 s | 5975.5 (10197) | 1 (1) | 32.5 |  |  |  |
| bench:searchMessages(rare) | 3 |  | 1.59 s | 1.71 s | 1.71 s | 7149.7 (10197) | 1 (1) | 39.3 |  |  |  |
