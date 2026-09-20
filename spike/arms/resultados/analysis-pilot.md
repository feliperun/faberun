# orchestration-arms · pilot

Runs in the ledger: 3 · B 1 · C 1 · A 1. Requirements per run: 5.

## Per run

| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 5/5 | 1.85 | 0.37 | 3.4 | 82 | 59 | 0 |  |
| B | 1 | 5/5 | 1.04 | 0.21 | 3.8 | 75 | 106 | 0 |  |
| C | 1 | 5/5 | 1.20 | 0.24 | 3.0 | 117 | 50 | 0 | 5 Agent calls |

## Arm medians

| indicator | direction | B (single session) | C (session with subagents) | A (faberun) |
| --- | --- | --- | --- | --- |
| costPerDeliveredRequirementUsd | down | 0.21 (n=1) | 0.24 (n=1) | 0.37 (n=1) |
| costUsd | down | 1.04 (n=1) | 1.20 (n=1) | 1.85 (n=1) |
| proofsPassed | up | 5.00 (n=1) | 5.00 (n=1) | 5.00 (n=1) |
| wallClockMinutes | down | 3.80 (n=1) | 3.02 (n=1) | 3.39 (n=1) |
| requests | down | 75.00 (n=1) | 117.00 (n=1) | 82.00 (n=1) |
| contextMaxKTokens | down | 106.10 (n=1) | 49.90 (n=1) | 58.77 (n=1) |
| outOfScopeFiles | down | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) |

## Noise band (arm A repeated on the same corpus)

Not measured: arm A has 1 run(s) under this label and a band needs at least two. Every comparison below is therefore a single reading, not a result; repeat before concluding.

## Comparisons (before = first arm, after = second)

### A (faberun) → B (single session)

```
contextMaxKTokens
  before: 58.769 (n=1)
  after:  106.102 (n=1)
  delta:  47.333
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.3692 (n=1)
  after:  0.2074 (n=1)
  delta:  -0.1618
  melhora conta como: down
costUsd
  before: 1.846 (n=1)
  after:  1.037 (n=1)
  delta:  -0.809
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 5 (n=1)
  after:  5 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 82 (n=1)
  after:  75 (n=1)
  delta:  -7
  melhora conta como: down
wallClockMinutes
  before: 3.3927 (n=1)
  after:  3.7977 (n=1)
  delta:  0.405
  melhora conta como: down
```

### A (faberun) → C (session with subagents)

```
contextMaxKTokens
  before: 58.769 (n=1)
  after:  49.904 (n=1)
  delta:  -8.865
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.3692 (n=1)
  after:  0.2405 (n=1)
  delta:  -0.1287
  melhora conta como: down
costUsd
  before: 1.846 (n=1)
  after:  1.2027 (n=1)
  delta:  -0.6433
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 5 (n=1)
  after:  5 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 82 (n=1)
  after:  117 (n=1)
  delta:  35
  melhora conta como: down
wallClockMinutes
  before: 3.3927 (n=1)
  after:  3.0176 (n=1)
  delta:  -0.3751
  melhora conta como: down
```

### B (single session) → C (session with subagents)

```
contextMaxKTokens
  before: 106.102 (n=1)
  after:  49.904 (n=1)
  delta:  -56.198
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.2074 (n=1)
  after:  0.2405 (n=1)
  delta:  0.0331
  melhora conta como: down
costUsd
  before: 1.037 (n=1)
  after:  1.2027 (n=1)
  delta:  0.1657
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 5 (n=1)
  after:  5 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 75 (n=1)
  after:  117 (n=1)
  delta:  42
  melhora conta como: down
wallClockMinutes
  before: 3.7977 (n=1)
  after:  3.0176 (n=1)
  delta:  -0.7801
  melhora conta como: down
```

