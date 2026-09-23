# orchestration-arms · full

Runs in the ledger: 8 · C 2 · B 2 · D 2 · A 2. Requirements per run: 10.

## Per run

| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 10/10 | 5.02 | 0.50 | 7.2 | 209 | 82 | 0 | judge 2.34 |
| A | 2 | 10/10 | 4.80 | 0.48 | 6.7 | 197 | 81 | 0 | judge 2.09 |
| B | 1 | 10/10 | 3.09 | 0.31 | 8.4 | 183 | 165 | 0 |  |
| B | 2 | 10/10 | 2.61 | 0.26 | 9.4 | 161 | 148 | 0 |  |
| C | 1 | 10/10 | 2.48 | 0.25 | 4.1 | 254 | 70 | 0 | 10 Agent calls |
| C | 2 | 10/10 | 3.20 | 0.32 | 8.1 | 309 | 92 | 0 | 10 Agent calls |
| D | 1 | 10/10 | 2.63 | 0.26 | 4.6 | 213 | 82 | 0 |  |
| D | 2 | 10/10 | 2.74 | 0.27 | 4.4 | 205 | 85 | 0 |  |

## Arm medians

| indicator | direction | C (session with subagents) | B (single session) | D (faberun, proof-only gate) | A (faberun, judge) |
| --- | --- | --- | --- | --- | --- |
| costPerDeliveredRequirementUsd | down | 0.28 (n=2) | 0.28 (n=2) | 0.27 (n=2) | 0.49 (n=2) |
| costUsd | down | 2.84 (n=2) | 2.85 (n=2) | 2.68 (n=2) | 4.91 (n=2) |
| proofsPassed | up | 10.00 (n=2) | 10.00 (n=2) | 10.00 (n=2) | 10.00 (n=2) |
| wallClockMinutes | down | 6.10 (n=2) | 8.89 (n=2) | 4.47 (n=2) | 6.97 (n=2) |
| requests | down | 281.50 (n=2) | 172.00 (n=2) | 209.00 (n=2) | 203.00 (n=2) |
| contextMaxKTokens | down | 80.92 (n=2) | 156.58 (n=2) | 83.37 (n=2) | 81.53 (n=2) |
| outOfScopeFiles | down | 0.00 (n=2) | 0.00 (n=2) | 0.00 (n=2) | 0.00 (n=2) |

## Noise band (arm A repeated on the same corpus)

| indicator | band ± | median | n |
| --- | --- | --- | --- |
| contextMaxKTokens | 0.71 | 81.53 | 2 |
| costPerDeliveredRequirementUsd | 0.01 | 0.49 | 2 |
| costUsd | 0.11 | 4.91 | 2 |
| outOfScopeFiles | 0.00 | 0.00 | 2 |
| proofsPassed | 0.00 | 10.00 | 2 |
| requests | 6.00 | 203.00 | 2 |
| wallClockMinutes | 0.23 | 6.97 | 2 |

## Comparisons (before = first arm, after = second)

### A (faberun, judge) → B (single session)

```
contextMaxKTokens
  before: 81.532 (n=2)
  after:  156.57850000000002 (n=2)
  delta:  75.0465 (outside the noise band ±0.708)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.4908 (n=2)
  after:  0.28495 (n=2)
  delta:  -0.2059 (outside the noise band ±0.0108)
  melhora conta como: down
costUsd
  before: 4.908049999999999 (n=2)
  after:  2.8495 (n=2)
  delta:  -2.0585 (outside the noise band ±0.1077)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 203 (n=2)
  after:  172 (n=2)
  delta:  -31 (outside the noise band ±6)
  melhora conta como: down
wallClockMinutes
  before: 6.9747 (n=2)
  after:  8.8914 (n=2)
  delta:  1.9167 (outside the noise band ±0.227)
  melhora conta como: down
```

### A (faberun, judge) → C (session with subagents)

```
contextMaxKTokens
  before: 81.532 (n=2)
  after:  80.925 (n=2)
  delta:  not measured: |-0.607| is within the noise band ±0.708
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.4908 (n=2)
  after:  0.2841 (n=2)
  delta:  -0.2067 (outside the noise band ±0.0108)
  melhora conta como: down
costUsd
  before: 4.908049999999999 (n=2)
  after:  2.84075 (n=2)
  delta:  -2.0673 (outside the noise band ±0.1077)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 203 (n=2)
  after:  281.5 (n=2)
  delta:  78.5 (outside the noise band ±6)
  melhora conta como: down
wallClockMinutes
  before: 6.9747 (n=2)
  after:  6.09515 (n=2)
  delta:  -0.8795 (outside the noise band ±0.227)
  melhora conta como: down
```

### B (single session) → C (session with subagents)

```
contextMaxKTokens
  before: 156.57850000000002 (n=2)
  after:  80.925 (n=2)
  delta:  -75.6535 (outside the noise band ±0.708)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.28495 (n=2)
  after:  0.2841 (n=2)
  delta:  not measured: |-0.0008| is within the noise band ±0.0108
  melhora conta como: down
costUsd
  before: 2.8495 (n=2)
  after:  2.84075 (n=2)
  delta:  not measured: |-0.0088| is within the noise band ±0.1077
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 172 (n=2)
  after:  281.5 (n=2)
  delta:  109.5 (outside the noise band ±6)
  melhora conta como: down
wallClockMinutes
  before: 8.8914 (n=2)
  after:  6.09515 (n=2)
  delta:  -2.7963 (outside the noise band ±0.227)
  melhora conta como: down
```

### D (faberun, proof-only gate) → B (single session)

```
contextMaxKTokens
  before: 83.3725 (n=2)
  after:  156.57850000000002 (n=2)
  delta:  73.206 (outside the noise band ±0.708)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.2683 (n=2)
  after:  0.28495 (n=2)
  delta:  0.0166 (outside the noise band ±0.0108)
  melhora conta como: down
costUsd
  before: 2.683 (n=2)
  after:  2.8495 (n=2)
  delta:  0.1665 (outside the noise band ±0.1077)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 209 (n=2)
  after:  172 (n=2)
  delta:  -37 (outside the noise band ±6)
  melhora conta como: down
wallClockMinutes
  before: 4.4670000000000005 (n=2)
  after:  8.8914 (n=2)
  delta:  4.4244 (outside the noise band ±0.227)
  melhora conta como: down
```

### D (faberun, proof-only gate) → C (session with subagents)

```
contextMaxKTokens
  before: 83.3725 (n=2)
  after:  80.925 (n=2)
  delta:  -2.4475 (outside the noise band ±0.708)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.2683 (n=2)
  after:  0.2841 (n=2)
  delta:  0.0158 (outside the noise band ±0.0108)
  melhora conta como: down
costUsd
  before: 2.683 (n=2)
  after:  2.84075 (n=2)
  delta:  0.1578 (outside the noise band ±0.1077)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 209 (n=2)
  after:  281.5 (n=2)
  delta:  72.5 (outside the noise band ±6)
  melhora conta como: down
wallClockMinutes
  before: 4.4670000000000005 (n=2)
  after:  6.09515 (n=2)
  delta:  1.6281 (outside the noise band ±0.227)
  melhora conta como: down
```

### A (faberun, judge) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: 81.532 (n=2)
  after:  83.3725 (n=2)
  delta:  1.8405 (outside the noise band ±0.708)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.4908 (n=2)
  after:  0.2683 (n=2)
  delta:  -0.2225 (outside the noise band ±0.0108)
  melhora conta como: down
costUsd
  before: 4.908049999999999 (n=2)
  after:  2.683 (n=2)
  delta:  -2.225 (outside the noise band ±0.1077)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=2)
  after:  0 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 10 (n=2)
  after:  10 (n=2)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 203 (n=2)
  after:  209 (n=2)
  delta:  not measured: |6| is within the noise band ±6
  melhora conta como: down
wallClockMinutes
  before: 6.9747 (n=2)
  after:  4.4670000000000005 (n=2)
  delta:  -2.5077 (outside the noise band ±0.227)
  melhora conta como: down
```

