# orchestration-arms · pilot

Runs in the ledger: 9 · B 3 · C 3 · A 3. Requirements per run: 5.

## Per run

| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 5/5 | 1.85 | 0.37 | 3.4 | 82 | 59 | 0 |  |
| A | 2 | 5/5 | 1.76 | 0.35 | 3.4 | 92 | 48 | 0 |  |
| A | 3 | 5/5 | 1.69 | 0.34 | 3.3 | 79 | 50 | 0 |  |
| B | 1 | 5/5 | 1.04 | 0.21 | 3.8 | 75 | 106 | 0 |  |
| B | 2 | 5/5 | 0.88 | 0.18 | 4.0 | 64 | 97 | 0 |  |
| B | 3 | 5/5 | 1.10 | 0.22 | 4.8 | 75 | 104 | 0 |  |
| C | 1 | 5/5 | 1.20 | 0.24 | 3.0 | 117 | 50 | 0 | 5 Agent calls |
| C | 2 | 5/5 | 1.01 | 0.20 | 3.1 | 94 | 44 | 0 | 5 Agent calls |
| C | 3 | 5/5 | 1.45 | 0.29 | 3.2 | 165 | 51 | 0 | 5 Agent calls |

## Arm medians

| indicator | direction | B (single session) | C (session with subagents) | A (faberun) |
| --- | --- | --- | --- | --- |
| costPerDeliveredRequirementUsd | down | 0.21 (n=3) | 0.24 (n=3) | 0.35 (n=3) |
| costUsd | down | 1.04 (n=3) | 1.20 (n=3) | 1.76 (n=3) |
| proofsPassed | up | 5.00 (n=3) | 5.00 (n=3) | 5.00 (n=3) |
| wallClockMinutes | down | 4.03 (n=3) | 3.11 (n=3) | 3.38 (n=3) |
| requests | down | 75.00 (n=3) | 117.00 (n=3) | 82.00 (n=3) |
| contextMaxKTokens | down | 103.60 (n=3) | 49.90 (n=3) | 50.47 (n=3) |
| outOfScopeFiles | down | 0.00 (n=3) | 0.00 (n=3) | 0.00 (n=3) |

## Noise band (arm A repeated on the same corpus)

| indicator | band ± | median | n |
| --- | --- | --- | --- |
| contextMaxKTokens | 5.30 | 50.47 | 3 |
| costPerDeliveredRequirementUsd | 0.02 | 0.35 | 3 |
| costUsd | 0.08 | 1.76 | 3 |
| outOfScopeFiles | 0.00 | 0.00 | 3 |
| proofsPassed | 0.00 | 5.00 | 3 |
| requests | 6.50 | 82.00 | 3 |
| wallClockMinutes | 0.04 | 3.38 | 3 |

## Comparisons (before = first arm, after = second)

### A (faberun) → B (single session)

```
contextMaxKTokens
  before: 50.465 (n=3)
  after:  103.604 (n=3)
  delta:  53.139 (outside the noise band ±5.2975)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.3513 (n=3)
  after:  0.2074 (n=3)
  delta:  -0.1439 (outside the noise band ±0.0158)
  melhora conta como: down
costUsd
  before: 1.7564 (n=3)
  after:  1.037 (n=3)
  delta:  -0.7194 (outside the noise band ±0.0794)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=3)
  after:  0 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 5 (n=3)
  after:  5 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 82 (n=3)
  after:  75 (n=3)
  delta:  -7 (outside the noise band ±6.5)
  melhora conta como: down
wallClockMinutes
  before: 3.3845 (n=3)
  after:  4.028 (n=3)
  delta:  0.6435 (outside the noise band ±0.0445)
  melhora conta como: down
```

### A (faberun) → C (session with subagents)

```
contextMaxKTokens
  before: 50.465 (n=3)
  after:  49.904 (n=3)
  delta:  not measured: |-0.561| is within the noise band ±5.2975
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.3513 (n=3)
  after:  0.2405 (n=3)
  delta:  -0.1108 (outside the noise band ±0.0158)
  melhora conta como: down
costUsd
  before: 1.7564 (n=3)
  after:  1.2027 (n=3)
  delta:  -0.5537 (outside the noise band ±0.0794)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=3)
  after:  0 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 5 (n=3)
  after:  5 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 82 (n=3)
  after:  117 (n=3)
  delta:  35 (outside the noise band ±6.5)
  melhora conta como: down
wallClockMinutes
  before: 3.3845 (n=3)
  after:  3.1134 (n=3)
  delta:  -0.2711 (outside the noise band ±0.0445)
  melhora conta como: down
```

### B (single session) → C (session with subagents)

```
contextMaxKTokens
  before: 103.604 (n=3)
  after:  49.904 (n=3)
  delta:  -53.7 (outside the noise band ±5.2975)
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.2074 (n=3)
  after:  0.2405 (n=3)
  delta:  0.0331 (outside the noise band ±0.0158)
  melhora conta como: down
costUsd
  before: 1.037 (n=3)
  after:  1.2027 (n=3)
  delta:  0.1657 (outside the noise band ±0.0794)
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=3)
  after:  0 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: down
proofsPassed
  before: 5 (n=3)
  after:  5 (n=3)
  delta:  not measured: |0| is within the noise band ±0
  melhora conta como: up
requests
  before: 75 (n=3)
  after:  117 (n=3)
  delta:  42 (outside the noise band ±6.5)
  melhora conta como: down
wallClockMinutes
  before: 4.028 (n=3)
  after:  3.1134 (n=3)
  delta:  -0.9146 (outside the noise band ±0.0445)
  melhora conta como: down
```

