# orchestration-arms · smoke

Runs in the ledger: 5 · B 1 · A 3 · C 1. Requirements per run: 1.

## Per run

| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 1/1 | 0.11 | 0.11 | 0.6 | 12 | 27 | 0 |  |
| A | 1 | 0/1 | 0.23 | — | 1.5 | 21 | 30 | 0 | exit 1 |
| A | 1 | 1/1 | 0.22 | 0.22 | 1.1 | 13 | 28 | 0 |  |
| B | 1 | 1/1 | 0.09 | 0.09 | 0.6 | 10 | 27 | 0 |  |
| C | 1 | 1/1 | 0.28 | 0.28 | 0.9 | 20 | 30 | 0 | 1 Agent calls |

## Arm medians

| indicator | direction | B (single session) | A (faberun) | C (session with subagents) |
| --- | --- | --- | --- | --- |
| costPerDeliveredRequirementUsd | down | 0.09 (n=1) | 0.17 (n=2) | 0.28 (n=1) |
| costUsd | down | 0.09 (n=1) | 0.22 (n=3) | 0.28 (n=1) |
| proofsPassed | up | 1.00 (n=1) | 1.00 (n=3) | 1.00 (n=1) |
| wallClockMinutes | down | 0.61 (n=1) | 1.09 (n=3) | 0.93 (n=1) |
| requests | down | 10.00 (n=1) | 13.00 (n=3) | 20.00 (n=1) |
| contextMaxKTokens | down | 27.23 (n=1) | 27.67 (n=3) | 29.50 (n=1) |
| outOfScopeFiles | down | 0.00 (n=1) | 0.00 (n=3) | 0.00 (n=1) |

## Noise band (arm A repeated on the same corpus)

| indicator | band ± | median | n |
| --- | --- | --- | --- |
| contextMaxKTokens | 1.22 | 27.67 | 3 |
| costPerDeliveredRequirementUsd | 0.06 | 0.17 | 2 |
| costUsd | 0.06 | 0.22 | 3 |
| outOfScopeFiles | 0.00 | 0.00 | 3 |
| proofsPassed | 0.50 | 1.00 | 3 |
| requests | 4.50 | 13.00 | 3 |
| wallClockMinutes | 0.42 | 1.09 | 3 |

## Comparisons (before = first arm, after = second)

### A (faberun) → B (single session)

```
contextMaxKTokens
  before: 27.669 (n=3)
  after:  27.225 (n=1)
  delta:  not measured: |-0.444| is within the noise band ±1.217
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.165 (n=2)
  after:  0.0903 (n=1)
  delta:  -0.0747 (outside the noise band ±0.0595)
  melhora conta como: down
costUsd
  before: 0.2245 (n=3)
  after:  0.0903 (n=1)
  delta:  -0.1342 (outside the noise band ±0.0628)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=3)
  after:  0 (n=1)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 1 (n=3)
  after:  1 (n=1)
  delta:  not measured: |0| is within the noise band ±0.5
  melhora conta como: up
requests
  before: 13 (n=3)
  after:  10 (n=1)
  delta:  not measured: |-3| is within the noise band ±4.5
  melhora conta como: down
wallClockMinutes
  before: 1.0946 (n=3)
  after:  0.6137 (n=1)
  delta:  -0.4809 (outside the noise band ±0.4154)
  melhora conta como: down
```

### A (faberun) → C (session with subagents)

```
contextMaxKTokens
  before: 27.669 (n=3)
  after:  29.502 (n=1)
  delta:  1.833 (outside the noise band ±1.217)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.165 (n=2)
  after:  0.2766 (n=1)
  delta:  0.1116 (outside the noise band ±0.0595)
  melhora conta como: down
costUsd
  before: 0.2245 (n=3)
  after:  0.2766 (n=1)
  delta:  not measured: |0.0521| is within the noise band ±0.0628
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=3)
  after:  0 (n=1)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 1 (n=3)
  after:  1 (n=1)
  delta:  not measured: |0| is within the noise band ±0.5
  melhora conta como: up
requests
  before: 13 (n=3)
  after:  20 (n=1)
  delta:  7 (outside the noise band ±4.5)
  melhora conta como: down
wallClockMinutes
  before: 1.0946 (n=3)
  after:  0.9332 (n=1)
  delta:  not measured: |-0.1614| is within the noise band ±0.4154
  melhora conta como: down
```

### B (single session) → C (session with subagents)

```
contextMaxKTokens
  before: 27.225 (n=1)
  after:  29.502 (n=1)
  delta:  2.277 (outside the noise band ±1.217)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0903 (n=1)
  after:  0.2766 (n=1)
  delta:  0.1863 (outside the noise band ±0.0595)
  melhora conta como: down
costUsd
  before: 0.0903 (n=1)
  after:  0.2766 (n=1)
  delta:  0.1863 (outside the noise band ±0.0628)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 1 (n=1)
  after:  1 (n=1)
  delta:  not measured: |0| is within the noise band ±0.5
  melhora conta como: up
requests
  before: 10 (n=1)
  after:  20 (n=1)
  delta:  10 (outside the noise band ±4.5)
  melhora conta como: down
wallClockMinutes
  before: 0.6137 (n=1)
  after:  0.9332 (n=1)
  delta:  not measured: |0.3195| is within the noise band ±0.4154
  melhora conta como: down
```

