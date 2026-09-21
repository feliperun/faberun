# orchestration-arms · complex

Runs in the ledger: 10 · C 1 · E 1 · D 1 · G 1 · H 1 · I 1 · J 1 · F 1 · B 1 · A 1. Requirements per run: 4; proofs per run: 2 (a run delivers its passing proofs only while every guard passes) (corpus complex).

## Per run

| arm | rep | proofs | cost USD | USD per delivered | wall min | requests | max context k | out of scope | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 2/2 | 4.45 | 2.23 | 23.0 | 336 | 103 | 0 | judge 1.08 |
| B | 1 | 2/2 | 4.69 | 2.34 | 18.8 | 287 | 166 | 0 |  |
| C | 1 | 2/2 | 3.60 | 1.80 | 22.2 | 316 | 125 | 0 | 4 Agent calls |
| D | 1 | 2/2 | 5.07 | 2.54 | 25.1 | 316 | 129 | 0 |  |
| E | 1 | 2/2 | 0.11 | 0.05 | 14.1 | 82 | 93 | 0 | writer deepseek-flash |
| F | 1 | 2/2 | 5.33 | 2.66 | 22.1 | 167 | 62 | 0 | writer claude-opus-5 |
| G | 1 | 2/2 | 2.66 | 1.33 | 19.4 | - | — | 0 | writer gpt-5.6-sol |
| H | 1 | 2/2 | 0.22 | 0.11 | 25.7 | - | — | 0 | writer gpt-5.6-luna |
| I | 1 | 0/2 | 0.27 | — | 0.9 | - | — | 0 | writer gpt-6-astra; worker refused the packet (context_missing); exit 1 |
| J | 1 | 2/2 | 0.16 | 0.08 | 36.6 | - | — | 0 | writer glm-5.3-flash |

## Arm medians

| indicator | direction | C (session with subagents) | E (faberun, deepseek-flash writer) | D (faberun, proof-only gate) | G (faberun, gpt-5.6-sol writer) | H (faberun, gpt-5.6-luna writer) | I (faberun, gpt-6-astra writer) | J (faberun, glm-5.3-flash writer) | F (faberun, claude-opus-5 writer) | B (single session) | A (faberun, judge) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| costPerDeliveredRequirementUsd | down | 1.80 (n=1) | 0.05 (n=1) | 2.54 (n=1) | 1.33 (n=1) | 0.11 (n=1) | — (n=0) | 0.08 (n=1) | 2.66 (n=1) | 2.34 (n=1) | 2.23 (n=1) |
| costUsd | down | 3.60 (n=1) | 0.11 (n=1) | 5.07 (n=1) | 2.66 (n=1) | 0.22 (n=1) | 0.27 (n=1) | 0.16 (n=1) | 5.33 (n=1) | 4.69 (n=1) | 4.45 (n=1) |
| proofsPassed | up | 2.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) | 0.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) | 2.00 (n=1) |
| wallClockMinutes | down | 22.23 (n=1) | 14.09 (n=1) | 25.10 (n=1) | 19.41 (n=1) | 25.71 (n=1) | 0.87 (n=1) | 36.62 (n=1) | 22.14 (n=1) | 18.80 (n=1) | 23.01 (n=1) |
| requests | down | 316.00 (n=1) | 82.00 (n=1) | 316.00 (n=1) | — (n=0) | — (n=0) | — (n=0) | — (n=0) | 167.00 (n=1) | 287.00 (n=1) | 336.00 (n=1) |
| contextMaxKTokens | down | 125.08 (n=1) | 92.62 (n=1) | 129.41 (n=1) | — (n=0) | — (n=0) | — (n=0) | — (n=0) | 61.76 (n=1) | 165.82 (n=1) | 102.74 (n=1) |
| outOfScopeFiles | down | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) | 0.00 (n=1) |

## Noise band (arm A repeated on the same corpus)

Not measured: arm A has 1 run(s) under this label and a band needs at least two. Every comparison below is therefore a single reading, not a result; repeat before concluding.

## Comparisons (before = first arm, after = second)

### A (faberun, judge) → B (single session)

```
contextMaxKTokens
  before: 102.743 (n=1)
  after:  165.823 (n=1)
  delta:  63.08
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.2254 (n=1)
  after:  2.3441 (n=1)
  delta:  0.1187
  melhora conta como: down
costUsd
  before: 4.4508 (n=1)
  after:  4.6883 (n=1)
  delta:  0.2375
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 336 (n=1)
  after:  287 (n=1)
  delta:  -49
  melhora conta como: down
wallClockMinutes
  before: 23.0059 (n=1)
  after:  18.7985 (n=1)
  delta:  -4.2074
  melhora conta como: down
```

### A (faberun, judge) → C (session with subagents)

```
contextMaxKTokens
  before: 102.743 (n=1)
  after:  125.084 (n=1)
  delta:  22.341
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.2254 (n=1)
  after:  1.7978 (n=1)
  delta:  -0.4276
  melhora conta como: down
costUsd
  before: 4.4508 (n=1)
  after:  3.5955 (n=1)
  delta:  -0.8553
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 336 (n=1)
  after:  316 (n=1)
  delta:  -20
  melhora conta como: down
wallClockMinutes
  before: 23.0059 (n=1)
  after:  22.2322 (n=1)
  delta:  -0.7737
  melhora conta como: down
```

### B (single session) → C (session with subagents)

```
contextMaxKTokens
  before: 165.823 (n=1)
  after:  125.084 (n=1)
  delta:  -40.739
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.3441 (n=1)
  after:  1.7978 (n=1)
  delta:  -0.5463
  melhora conta como: down
costUsd
  before: 4.6883 (n=1)
  after:  3.5955 (n=1)
  delta:  -1.0928
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 287 (n=1)
  after:  316 (n=1)
  delta:  29
  melhora conta como: down
wallClockMinutes
  before: 18.7985 (n=1)
  after:  22.2322 (n=1)
  delta:  3.4337
  melhora conta como: down
```

### D (faberun, proof-only gate) → B (single session)

```
contextMaxKTokens
  before: 129.407 (n=1)
  after:  165.823 (n=1)
  delta:  36.416
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.535 (n=1)
  after:  2.3441 (n=1)
  delta:  -0.1909
  melhora conta como: down
costUsd
  before: 5.07 (n=1)
  after:  4.6883 (n=1)
  delta:  -0.3817
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 316 (n=1)
  after:  287 (n=1)
  delta:  -29
  melhora conta como: down
wallClockMinutes
  before: 25.1031 (n=1)
  after:  18.7985 (n=1)
  delta:  -6.3046
  melhora conta como: down
```

### D (faberun, proof-only gate) → C (session with subagents)

```
contextMaxKTokens
  before: 129.407 (n=1)
  after:  125.084 (n=1)
  delta:  -4.323
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.535 (n=1)
  after:  1.7978 (n=1)
  delta:  -0.7372
  melhora conta como: down
costUsd
  before: 5.07 (n=1)
  after:  3.5955 (n=1)
  delta:  -1.4745
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 316 (n=1)
  after:  316 (n=1)
  delta:  0
  melhora conta como: down
wallClockMinutes
  before: 25.1031 (n=1)
  after:  22.2322 (n=1)
  delta:  -2.8709
  melhora conta como: down
```

### A (faberun, judge) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: 102.743 (n=1)
  after:  129.407 (n=1)
  delta:  26.664
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.2254 (n=1)
  after:  2.535 (n=1)
  delta:  0.3096
  melhora conta como: down
costUsd
  before: 4.4508 (n=1)
  after:  5.07 (n=1)
  delta:  0.6192
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 336 (n=1)
  after:  316 (n=1)
  delta:  -20
  melhora conta como: down
wallClockMinutes
  before: 23.0059 (n=1)
  after:  25.1031 (n=1)
  delta:  2.0972
  melhora conta como: down
```

### E (faberun, deepseek-flash writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: 92.616 (n=1)
  after:  129.407 (n=1)
  delta:  36.791
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0526 (n=1)
  after:  2.535 (n=1)
  delta:  2.4824
  melhora conta como: down
costUsd
  before: 0.1051 (n=1)
  after:  5.07 (n=1)
  delta:  4.9649
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 82 (n=1)
  after:  316 (n=1)
  delta:  234
  melhora conta como: down
wallClockMinutes
  before: 14.0939 (n=1)
  after:  25.1031 (n=1)
  delta:  11.0092
  melhora conta como: down
```

### E (faberun, deepseek-flash writer) → A (faberun, judge)

```
contextMaxKTokens
  before: 92.616 (n=1)
  after:  102.743 (n=1)
  delta:  10.127
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0526 (n=1)
  after:  2.2254 (n=1)
  delta:  2.1728
  melhora conta como: down
costUsd
  before: 0.1051 (n=1)
  after:  4.4508 (n=1)
  delta:  4.3457
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 82 (n=1)
  after:  336 (n=1)
  delta:  254
  melhora conta como: down
wallClockMinutes
  before: 14.0939 (n=1)
  after:  23.0059 (n=1)
  delta:  8.912
  melhora conta como: down
```

### E (faberun, deepseek-flash writer) → B (single session)

```
contextMaxKTokens
  before: 92.616 (n=1)
  after:  165.823 (n=1)
  delta:  73.207
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0526 (n=1)
  after:  2.3441 (n=1)
  delta:  2.2915
  melhora conta como: down
costUsd
  before: 0.1051 (n=1)
  after:  4.6883 (n=1)
  delta:  4.5832
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 82 (n=1)
  after:  287 (n=1)
  delta:  205
  melhora conta como: down
wallClockMinutes
  before: 14.0939 (n=1)
  after:  18.7985 (n=1)
  delta:  4.7046
  melhora conta como: down
```

### F (faberun, claude-opus-5 writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: 61.759 (n=1)
  after:  129.407 (n=1)
  delta:  67.648
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.6644 (n=1)
  after:  2.535 (n=1)
  delta:  -0.1294
  melhora conta como: down
costUsd
  before: 5.3289 (n=1)
  after:  5.07 (n=1)
  delta:  -0.2589
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 167 (n=1)
  after:  316 (n=1)
  delta:  149
  melhora conta como: down
wallClockMinutes
  before: 22.1378 (n=1)
  after:  25.1031 (n=1)
  delta:  2.9653
  melhora conta como: down
```

### F (faberun, claude-opus-5 writer) → A (faberun, judge)

```
contextMaxKTokens
  before: 61.759 (n=1)
  after:  102.743 (n=1)
  delta:  40.984
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.6644 (n=1)
  after:  2.2254 (n=1)
  delta:  -0.439
  melhora conta como: down
costUsd
  before: 5.3289 (n=1)
  after:  4.4508 (n=1)
  delta:  -0.8781
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 167 (n=1)
  after:  336 (n=1)
  delta:  169
  melhora conta como: down
wallClockMinutes
  before: 22.1378 (n=1)
  after:  23.0059 (n=1)
  delta:  0.8681
  melhora conta como: down
```

### F (faberun, claude-opus-5 writer) → B (single session)

```
contextMaxKTokens
  before: 61.759 (n=1)
  after:  165.823 (n=1)
  delta:  104.064
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 2.6644 (n=1)
  after:  2.3441 (n=1)
  delta:  -0.3203
  melhora conta como: down
costUsd
  before: 5.3289 (n=1)
  after:  4.6883 (n=1)
  delta:  -0.6406
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: 167 (n=1)
  after:  287 (n=1)
  delta:  120
  melhora conta como: down
wallClockMinutes
  before: 22.1378 (n=1)
  after:  18.7985 (n=1)
  delta:  -3.3393
  melhora conta como: down
```

### G (faberun, gpt-5.6-sol writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: null (n=0)
  after:  129.407 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 1.3315 (n=1)
  after:  2.535 (n=1)
  delta:  1.2035
  melhora conta como: down
costUsd
  before: 2.663 (n=1)
  after:  5.07 (n=1)
  delta:  2.407
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  316 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 19.4089 (n=1)
  after:  25.1031 (n=1)
  delta:  5.6942
  melhora conta como: down
```

### G (faberun, gpt-5.6-sol writer) → A (faberun, judge)

```
contextMaxKTokens
  before: null (n=0)
  after:  102.743 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 1.3315 (n=1)
  after:  2.2254 (n=1)
  delta:  0.8939
  melhora conta como: down
costUsd
  before: 2.663 (n=1)
  after:  4.4508 (n=1)
  delta:  1.7878
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  336 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 19.4089 (n=1)
  after:  23.0059 (n=1)
  delta:  3.597
  melhora conta como: down
```

### G (faberun, gpt-5.6-sol writer) → B (single session)

```
contextMaxKTokens
  before: null (n=0)
  after:  165.823 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 1.3315 (n=1)
  after:  2.3441 (n=1)
  delta:  1.0126
  melhora conta como: down
costUsd
  before: 2.663 (n=1)
  after:  4.6883 (n=1)
  delta:  2.0253
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  287 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 19.4089 (n=1)
  after:  18.7985 (n=1)
  delta:  -0.6104
  melhora conta como: down
```

### H (faberun, gpt-5.6-luna writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: null (n=0)
  after:  129.407 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.1104 (n=1)
  after:  2.535 (n=1)
  delta:  2.4246
  melhora conta como: down
costUsd
  before: 0.2207 (n=1)
  after:  5.07 (n=1)
  delta:  4.8493
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  316 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 25.709 (n=1)
  after:  25.1031 (n=1)
  delta:  -0.6059
  melhora conta como: down
```

### H (faberun, gpt-5.6-luna writer) → A (faberun, judge)

```
contextMaxKTokens
  before: null (n=0)
  after:  102.743 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.1104 (n=1)
  after:  2.2254 (n=1)
  delta:  2.115
  melhora conta como: down
costUsd
  before: 0.2207 (n=1)
  after:  4.4508 (n=1)
  delta:  4.2301
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  336 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 25.709 (n=1)
  after:  23.0059 (n=1)
  delta:  -2.7031
  melhora conta como: down
```

### H (faberun, gpt-5.6-luna writer) → B (single session)

```
contextMaxKTokens
  before: null (n=0)
  after:  165.823 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.1104 (n=1)
  after:  2.3441 (n=1)
  delta:  2.2337
  melhora conta como: down
costUsd
  before: 0.2207 (n=1)
  after:  4.6883 (n=1)
  delta:  4.4676
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  287 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 25.709 (n=1)
  after:  18.7985 (n=1)
  delta:  -6.9105
  melhora conta como: down
```

### I (faberun, gpt-6-astra writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: null (n=0)
  after:  129.407 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: null (n=0)
  after:  2.535 (n=1)
  delta:  no data
  melhora conta como: down
costUsd
  before: 0.2678 (n=1)
  after:  5.07 (n=1)
  delta:  4.8022
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 0 (n=1)
  after:  2 (n=1)
  delta:  2
  melhora conta como: up
requests
  before: null (n=0)
  after:  316 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 0.8708 (n=1)
  after:  25.1031 (n=1)
  delta:  24.2323
  melhora conta como: down
```

### I (faberun, gpt-6-astra writer) → A (faberun, judge)

```
contextMaxKTokens
  before: null (n=0)
  after:  102.743 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: null (n=0)
  after:  2.2254 (n=1)
  delta:  no data
  melhora conta como: down
costUsd
  before: 0.2678 (n=1)
  after:  4.4508 (n=1)
  delta:  4.183
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 0 (n=1)
  after:  2 (n=1)
  delta:  2
  melhora conta como: up
requests
  before: null (n=0)
  after:  336 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 0.8708 (n=1)
  after:  23.0059 (n=1)
  delta:  22.1351
  melhora conta como: down
```

### I (faberun, gpt-6-astra writer) → B (single session)

```
contextMaxKTokens
  before: null (n=0)
  after:  165.823 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: null (n=0)
  after:  2.3441 (n=1)
  delta:  no data
  melhora conta como: down
costUsd
  before: 0.2678 (n=1)
  after:  4.6883 (n=1)
  delta:  4.4205
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 0 (n=1)
  after:  2 (n=1)
  delta:  2
  melhora conta como: up
requests
  before: null (n=0)
  after:  287 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 0.8708 (n=1)
  after:  18.7985 (n=1)
  delta:  17.9277
  melhora conta como: down
```

### J (faberun, glm-5.3-flash writer) → D (faberun, proof-only gate)

```
contextMaxKTokens
  before: null (n=0)
  after:  129.407 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0813 (n=1)
  after:  2.535 (n=1)
  delta:  2.4537
  melhora conta como: down
costUsd
  before: 0.1625 (n=1)
  after:  5.07 (n=1)
  delta:  4.9075
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  316 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 36.6195 (n=1)
  after:  25.1031 (n=1)
  delta:  -11.5164
  melhora conta como: down
```

### J (faberun, glm-5.3-flash writer) → A (faberun, judge)

```
contextMaxKTokens
  before: null (n=0)
  after:  102.743 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0813 (n=1)
  after:  2.2254 (n=1)
  delta:  2.1441
  melhora conta como: down
costUsd
  before: 0.1625 (n=1)
  after:  4.4508 (n=1)
  delta:  4.2883
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  336 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 36.6195 (n=1)
  after:  23.0059 (n=1)
  delta:  -13.6136
  melhora conta como: down
```

### J (faberun, glm-5.3-flash writer) → B (single session)

```
contextMaxKTokens
  before: null (n=0)
  after:  165.823 (n=1)
  delta:  no data
  melhora conta como: down
costPerDeliveredRequirementUsd
  before: 0.0813 (n=1)
  after:  2.3441 (n=1)
  delta:  2.2628
  melhora conta como: down
costUsd
  before: 0.1625 (n=1)
  after:  4.6883 (n=1)
  delta:  4.5258
  melhora conta como: down
outOfScopeFiles
  before: 0 (n=1)
  after:  0 (n=1)
  delta:  0
  melhora conta como: down
proofsPassed
  before: 2 (n=1)
  after:  2 (n=1)
  delta:  0
  melhora conta como: up
requests
  before: null (n=0)
  after:  287 (n=1)
  delta:  no data
  melhora conta como: down
wallClockMinutes
  before: 36.6195 (n=1)
  after:  18.7985 (n=1)
  delta:  -17.821
  melhora conta como: down
```

