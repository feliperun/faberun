# Changelog

release-please generates the entries below from Conventional Commits.

## [0.19.3](https://github.com/feliperun/faberun/compare/v0.19.2...v0.19.3) (2026-09-22)


### Bug Fixes

* the open findings, from a gate that stops watching to a closure that stays silent ([#59](https://github.com/feliperun/faberun/issues/59)) ([3534ac7](https://github.com/feliperun/faberun/commit/3534ac7b1bc0cd4d20f21157f566a049f3616cf4))

## [0.19.2](https://github.com/feliperun/faberun/compare/v0.19.1...v0.19.2) (2026-09-22)


### Bug Fixes

* close the dossier of open faberun findings ([#56](https://github.com/feliperun/faberun/issues/56)) ([3325c8d](https://github.com/feliperun/faberun/commit/3325c8df739a13087612c9bdaf23f37037e932c6))

## [0.19.1](https://github.com/feliperun/faberun/compare/v0.19.0...v0.19.1) (2026-09-22)


### Bug Fixes

* the seven omarchy blockers, the stale update check and the Windows CI flake ([#55](https://github.com/feliperun/faberun/issues/55)) ([446346f](https://github.com/feliperun/faberun/commit/446346fff756cd7430087d017c219441ffce0259))

## [0.19.0](https://github.com/feliperun/faberun/compare/v0.18.0...v0.19.0) (2026-09-22)


### Features

* **contract:** warn when a node writes a layer its verification never runs ([#48](https://github.com/feliperun/faberun/issues/48)) ([8c26c95](https://github.com/feliperun/faberun/commit/8c26c9566eadd2bd56a725f17605d2eb830e68f5))
* **engine:** a live verdict outlives the launch that bought it ([#51](https://github.com/feliperun/faberun/issues/51)) ([68c3e87](https://github.com/feliperun/faberun/commit/68c3e877bcba2bf183dbf0b85d795b4da77f804b))
* **engine:** the dispatch gate asks before it passes ([#49](https://github.com/feliperun/faberun/issues/49)) ([b489e8c](https://github.com/feliperun/faberun/commit/b489e8c9f39dcbe1676994e9034385dd6bd36555))
* **harnesses:** the availability verdict names which cause it was ([#47](https://github.com/feliperun/faberun/issues/47)) ([13094e0](https://github.com/feliperun/faberun/commit/13094e0fbfb4476a840b27085c0ca51359005675))
* **host:** doctor reports the verdict, not the version ([#53](https://github.com/feliperun/faberun/issues/53)) ([6d91146](https://github.com/feliperun/faberun/commit/6d9114671ad0b7df63cfc154c6b57e4a04ba6562))
* **host:** faberun runs on Windows ([87069e7](https://github.com/feliperun/faberun/commit/87069e774bdef0d4c7f67a83bf920bec8baa68f4))
* **plan:** planning asks before its first stage ([#52](https://github.com/feliperun/faberun/issues/52)) ([a6a5d43](https://github.com/feliperun/faberun/commit/a6a5d4377df3fa19a9a5ccf95bd6e7782fd94dc9))


### Bug Fixes

* **contract:** the write-file line ceiling is a rule about modules ([#50](https://github.com/feliperun/faberun/issues/50)) ([6f7dd2c](https://github.com/feliperun/faberun/commit/6f7dd2c5f0b91ca3771153a0d6eb1794577f8187))
* **signal:** a closed campaign's business leaves the block ([#46](https://github.com/feliperun/faberun/issues/46)) ([2b7f45e](https://github.com/feliperun/faberun/commit/2b7f45ed1e168df11600adb1cb2e5a14712c6664))
* **signal:** a run with a node still running is active, not parked ([#44](https://github.com/feliperun/faberun/issues/44)) ([693c7a7](https://github.com/feliperun/faberun/commit/693c7a7584923b8e1bbec2f99c8e34553a30acef))

## [0.18.0](https://github.com/feliperun/faberun/compare/v0.17.2...v0.18.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **notify:** a node settling no longer leaves through the notify transports unless `FABERUN_NOTIFY_EVENTS` names `node.terminal`; it is recorded in `notify.jsonl` as `filtered`.

### Features

* **notify:** a run can wake the operator's own session, not only the one that launched it ([#41](https://github.com/feliperun/faberun/issues/41)) ([090fbfa](https://github.com/feliperun/faberun/commit/090fbfaf5960e16bea9fc43ca4002a1e39178be0))
* **notify:** only a phase settling or a person being needed leaves by default ([#43](https://github.com/feliperun/faberun/issues/43)) ([0f51681](https://github.com/feliperun/faberun/commit/0f51681a32e118f604536161c2e0c283ce1bfeba))

## [0.17.2](https://github.com/feliperun/faberun/compare/v0.17.1...v0.17.2) (2026-09-22)


### Bug Fixes

* **test:** the live-cancel fixtures signal readiness before the test cancels ([979a279](https://github.com/feliperun/faberun/commit/979a279f40e374834b247dbc8a8ab27ccd70c976))

## [0.17.1](https://github.com/feliperun/faberun/compare/v0.17.0...v0.17.1) (2026-09-22)


### Bug Fixes

* **campaign:** a record written before a field existed is repaired, not condemned ([e893a89](https://github.com/feliperun/faberun/commit/e893a899f957fbcee7371739fef1177e4399043a))
* **run:** the migration refusal carries what would let it finish ([a74244d](https://github.com/feliperun/faberun/commit/a74244daa4c56f6034bd1badaa976670c28e6b5d))

## [0.17.0](https://github.com/feliperun/faberun/compare/v0.16.0...v0.17.0) (2026-09-21)


### Features

* **test:** the runner scopes FABERUN_HOME for every test process ([a617236](https://github.com/feliperun/faberun/commit/a61723665f9867b1cad3488b7a7f695b9cf47154))


### Bug Fixes

* **campaign:** a journal note that does not fit is refused, not shortened ([5903777](https://github.com/feliperun/faberun/commit/59037771018a4955f3c16502c4737861a8f698a9))
* **engine:** a proof whose filter selected no test is not a proof ([afb4cd7](https://github.com/feliperun/faberun/commit/afb4cd7b82976a85e7e69961697abe37bcdb67b1))
* **notify:** no child of the controller inherits a notify transport ([#35](https://github.com/feliperun/faberun/issues/35)) ([0cf0212](https://github.com/feliperun/faberun/commit/0cf021225b52bb68ac9d81f5b98faead532b87d2))
* **repo:** an attention belongs to one campaign or none ([3b15947](https://github.com/feliperun/faberun/commit/3b15947a535f83fbd94238b56fbb892d114fc023))

## [0.16.0](https://github.com/feliperun/faberun/compare/v0.15.0...v0.16.0) (2026-09-21)


### Features

* **notify:** wake the launching harness session with the message the phone gets ([#31](https://github.com/feliperun/faberun/issues/31)) ([4843be2](https://github.com/feliperun/faberun/commit/4843be230a23d3e4eaccc180dee990fb1bfaa3b4))
* **repo:** a preserved ref keeps one node's integrated commit reachable ([d362a10](https://github.com/feliperun/faberun/commit/d362a103fff1cb7b10fc36a933cf4e36e3d601fb))


### Bug Fixes

* **engine:** cancelling a run no longer orphans the work its nodes integrated ([15e1e24](https://github.com/feliperun/faberun/commit/15e1e24375232b39a8f13902db45e0bf44d045d4))
* **plan:** a write handed to a new sibling node moved, it was not dropped ([6fd3ba7](https://github.com/feliperun/faberun/commit/6fd3ba7b12316f18f3dd717b19ed489a95bdaf0d))

## [0.15.0](https://github.com/feliperun/faberun/compare/v0.14.0...v0.15.0) (2026-09-21)


### Features

* **evals:** resilience is exercised by the deterministic driver, not documented ([3a467ff](https://github.com/feliperun/faberun/commit/3a467ff7228569b0199cf138ee98749623111970))
* **plan:** a planned contract carries the repository's own ratchets ([29f8349](https://github.com/feliperun/faberun/commit/29f8349d6b278b5ead5708de4dabfc316fd8b8d1))
* **plan:** declare the parallelism sizing proved, and stop forgetting open findings ([#25](https://github.com/feliperun/faberun/issues/25)) ([ed0baa2](https://github.com/feliperun/faberun/commit/ed0baa2cd937c9d6df92ef23d1700400e33a8672))
* routing decides on observable data, and packet repetition is measured ([1747772](https://github.com/feliperun/faberun/commit/1747772dbf9547ecf6324b78af59533e72f251ee))
* the expensive suites run on their own schedule, and mutation has a budget ([4da9f0d](https://github.com/feliperun/faberun/commit/4da9f0d84928f3239eacfeb63dec3fc4d74f9309))


### Bug Fixes

* **ci:** the squash-message gate revalidates when the body it reads changes ([#30](https://github.com/feliperun/faberun/issues/30)) ([2d84906](https://github.com/feliperun/faberun/commit/2d84906e65241daceede94ade9c85281d1ed5124))
* **engine:** a declared parallelism limit counts every process the run started ([#29](https://github.com/feliperun/faberun/issues/29)) ([1a981d4](https://github.com/feliperun/faberun/commit/1a981d400df9a87b795e5f5e9c42a70d8dc0d6b6))
* **engine:** a failing ratchet is not an invitation to edit the ratchet ([#23](https://github.com/feliperun/faberun/issues/23)) ([2c9dd69](https://github.com/feliperun/faberun/commit/2c9dd69e10f2318985ccddf71494930b8575d0eb))
* **engine:** a write onto the file that proves the work is not an advisory ([#26](https://github.com/feliperun/faberun/issues/26)) ([982846a](https://github.com/feliperun/faberun/commit/982846a23004c9c4d745f3d8fad9803461496ba5))
* **plan:** a scope-closure finding never invites the reviser to write less ([2a3c73c](https://github.com/feliperun/faberun/commit/2a3c73ca4cd8e98cc6fed989834cffc2223024e7))

## [0.14.0](https://github.com/feliperun/faberun/compare/v0.13.0...v0.14.0) (2026-09-21)


### Features

* a requirement id travels from the phase to the node and into closure ([d0083a8](https://github.com/feliperun/faberun/commit/d0083a858c16242412362af1d34a1ff88926b3ed))


### Bug Fixes

* **plan:** a folded node keeps the acknowledged importers and the expected turns of both nodes ([#21](https://github.com/feliperun/faberun/issues/21)) ([d081b0e](https://github.com/feliperun/faberun/commit/d081b0e16880a979d55c337008f4310c03027597))

## [0.13.0](https://github.com/feliperun/faberun/compare/v0.12.1...v0.13.0) (2026-09-21)


### Features

* measure where a turn's cost goes and stop paying the avoidable parts ([#16](https://github.com/feliperun/faberun/issues/16)) ([f3bd129](https://github.com/feliperun/faberun/commit/f3bd129639d1b1054ebf6aa2cca55d9640c6299d))
* **plan:** a frozen plan declares which requirements each phase satisfies ([83c7c47](https://github.com/feliperun/faberun/commit/83c7c4704624e0ba8d436994f26813eb4223de49))


### Bug Fixes

* **plan:** a plan is checked as the contract it becomes, while a round remains ([d4ad4db](https://github.com/feliperun/faberun/commit/d4ad4db12606b94b8cd770792bd808da0542bf80))

## [0.12.1](https://github.com/feliperun/faberun/compare/v0.12.0...v0.12.1) (2026-09-20)


### Bug Fixes

* **plan:** the planner states the shape it enforces and survives a miss ([6dc9dee](https://github.com/feliperun/faberun/commit/6dc9dee0359f5950f8f0856451582434c3c59a1e))

## [0.12.0](https://github.com/feliperun/faberun/compare/v0.11.0...v0.12.0) (2026-09-20)


### Features

* **campaign:** a contract can join an active campaign ([ce66980](https://github.com/feliperun/faberun/commit/ce66980efe8e20b2232cb5beb554d169ea518190))
* **engine:** a cancelled run relaunches with one command ([c4b61b4](https://github.com/feliperun/faberun/commit/c4b61b49290de80781a3e67ca0a40be4e6c81b7e))
* **engine:** a run prices itself from a vendored models.dev snapshot ([51f46c7](https://github.com/feliperun/faberun/commit/51f46c7e71784aab45b764de74ee5ba1e3b0303a))
* faberun installs on Windows ([#15](https://github.com/feliperun/faberun/issues/15)) ([1e03107](https://github.com/feliperun/faberun/commit/1e0310784ac6c0e01b7a0058a18a1b1fc1bf6e37))
* **host:** a project is identified by its path and survives moving ([cbfd2f6](https://github.com/feliperun/faberun/commit/cbfd2f61137b86b4c7d05f3c69282ee0a5205cdb))
* one render reaches both audiences, and the page reads at a glance ([e733ff8](https://github.com/feliperun/faberun/commit/e733ff8c81a05bc64861a86c20fd5cc8c3157158))
* **plan:** a requirement declares what to measure, not just what to prove ([2ed0825](https://github.com/feliperun/faberun/commit/2ed08251330defd54d09a1b0841d09b8845d3747))
* **report:** one renderer turns a run's state into the progress message ([3ff4e0a](https://github.com/feliperun/faberun/commit/3ff4e0a45bb8d9e08bee7a4f11bc542bade3de35))
* **report:** the progress model answers for the campaign, not one run ([20c3551](https://github.com/feliperun/faberun/commit/20c355123f0061b610c568f012e17f05fb984ba8))
* **run:** a repository migrates to the home in one command, safely twice ([e85a9e6](https://github.com/feliperun/faberun/commit/e85a9e69c40ee8607e85a746724596a3bd59f41f))
* **run:** one module owns every run, campaign and worktree path ([a9847c5](https://github.com/feliperun/faberun/commit/a9847c5f6d3db59b7bf81f5807c42b42ef675cd7))
* **run:** the run and campaign resolver answers from the operator's home ([8a660c3](https://github.com/feliperun/faberun/commit/8a660c399f4d3217826bdbb2071176843cd20834))
* unpark and validate name what they found and what to do about it ([a1117f7](https://github.com/feliperun/faberun/commit/a1117f7254c82b6e08908d54df3c46aa6666b838))
* **web:** the dashboard answers what value, progress, cost and time left ([6679073](https://github.com/feliperun/faberun/commit/6679073bd487a0ff88ecc43fa6bf952db1297e9e))
* **web:** the dashboard is a map of the spec and a graph of the campaign ([068c50b](https://github.com/feliperun/faberun/commit/068c50b35632f04c1be5849d30b06118c69ed3ff))
* **web:** the dashboard reads on a phone ([3b901ac](https://github.com/feliperun/faberun/commit/3b901acf122d7caba7fde8633ea3234555bb6858))


### Bug Fixes

* **engine:** a planning node can deliver its plan through the engine ([0bfc739](https://github.com/feliperun/faberun/commit/0bfc739f6d15903d438c2e73364a27313ee12feb))
* **host:** a project's identity survives two spellings of the same path ([5259869](https://github.com/feliperun/faberun/commit/5259869f0dde568d1b2c1c2c8149c34a928d410e))
* **report:** the roll-up says who did the work and who judged it ([1632b43](https://github.com/feliperun/faberun/commit/1632b43bb87fb1c41392621ab23ac01201075348))
* **run:** migrate survives a symlinked node_modules and a large removal ([419b87c](https://github.com/feliperun/faberun/commit/419b87c86ef9a425d4eedde0ebef0e9d12b77968))

## [0.11.0](https://github.com/feliperun/faberun/compare/v0.10.0...v0.11.0) (2026-09-18)


### Features

* a prompt states its whole result shape, a test cannot notify, a judge cannot write ([02bfa03](https://github.com/feliperun/faberun/commit/02bfa034a81851688d1395065cd99fc46be78704))
* **engine:** the controller compares the judge's workspace around its verdict ([fe97a2b](https://github.com/feliperun/faberun/commit/fe97a2baaf6b8c62dd6eea5ec93072b77f995220))
* **engine:** the judge write check fails closed, with no escape ([5570c0f](https://github.com/feliperun/faberun/commit/5570c0fe87cc369f68932380a5ec2da30b5af3f4))

## [0.10.0](https://github.com/feliperun/faberun/compare/v0.9.0...v0.10.0) (2026-09-17)


### Features

* base-ref validation everywhere, dispatch while verifying, one suite per phase ([51228cb](https://github.com/feliperun/faberun/commit/51228cb82a36060bd9faaf3cf854a6baa1fce996))
* **engine:** a free slot dispatches while another node verifies ([c022e64](https://github.com/feliperun/faberun/commit/c022e64de35116a75980106151c2f2ad33ec449e))
* **engine:** the contract's final verification runs once per phase ([1388c92](https://github.com/feliperun/faberun/commit/1388c9269d8bd54d8983d0a4576166aec796d441))
* **report:** the status names the candidate phase and the gate outcome ([6212d85](https://github.com/feliperun/faberun/commit/6212d85eddc67d1abd3d46a55ef6d4890c7c5c14))

## [0.9.0](https://github.com/feliperun/faberun/compare/v0.8.0...v0.9.0) (2026-09-17)


### Features

* **evals:** comparative arm for the planner over real campaign records ([55677e9](https://github.com/feliperun/faberun/commit/55677e98f4f8fb5f0c1ca9c3223878ca637a6fc6))
* planning outside the session, with budget, isolation and a verdict by measurement ([8e8a1fc](https://github.com/feliperun/faberun/commit/8e8a1fcb7f2453bc22c6a8538df6652903f60e07))
* **seat:** pin the rate-limit window an allowance sample measured ([d5840a1](https://github.com/feliperun/faberun/commit/d5840a1d38d002042c29c3b7c6db81315badea20))
* **seat:** sample the harness allowance and journal its delta ([3db8cdc](https://github.com/feliperun/faberun/commit/3db8cdcfcec8c40fa980de0e3f460cf16782782e))


### Bug Fixes

* **plan:** route pipeline open-question notes through campaign note ([d6734b3](https://github.com/feliperun/faberun/commit/d6734b303c286d168601d03150b71402e53459c4))
* **plan:** write the frozen plan atomically and wait on its status in D25 ([a2f9082](https://github.com/feliperun/faberun/commit/a2f9082d598dba1e677dc3a63793b8b0d5a7e0d0))

## [0.8.0](https://github.com/feliperun/faberun/compare/v0.7.0...v0.8.0) (2026-09-17)


### Features

* validated spec format, deterministic planner stages, ledgers that outlive campaigns ([f888e1e](https://github.com/feliperun/faberun/commit/f888e1e2ecbcfbceecc3b17029cb4f5418bcd9a2))


### Bug Fixes

* **ci:** fetch full history so spec baselines resolve under strict traceability ([08d1110](https://github.com/feliperun/faberun/commit/08d11102655ae5e0fa110c395c34a8c1ccd45530))

## [0.7.0](https://github.com/feliperun/faberun/compare/v0.6.0...v0.7.0) (2026-09-17)


### Features

* tests independent of the host and a manual the code writes ([5857b44](https://github.com/feliperun/faberun/commit/5857b44d55ffe216a1f0f7bb56984d71d9fb7756))

## [0.6.0](https://github.com/feliperun/faberun/compare/v0.5.0...v0.6.0) (2026-09-16)


### Features

* harden the chain, resume and verification ([6a9fec1](https://github.com/feliperun/faberun/commit/6a9fec115a3794f8e2cb49776c36c55524e2db9a))

## [0.5.0](https://github.com/feliperun/faberun/compare/v0.4.0...v0.5.0) (2026-09-16)


### Features

* register the faberun skill in every harness on install ([2a9a3b0](https://github.com/feliperun/faberun/commit/2a9a3b07e9e6b0a9a85c30e03592a14ace623200))


### Bug Fixes

* **test:** notifier fixtures run node directly instead of through the PATH shim ([a4606c2](https://github.com/feliperun/faberun/commit/a4606c25acf5b60ebae59b8b1983d95f43146592))
* **test:** the brand ratchet skips the changelog file itself ([f3fdeb7](https://github.com/feliperun/faberun/commit/f3fdeb723f7a0026eefdba8e3de72c6d54c17a43))
* **test:** the brand ratchet skips the generated CHANGELOG ([e537650](https://github.com/feliperun/faberun/commit/e5376503a5e70b40c74e3ac9fd74c9430e939b6c))

## [0.4.0](https://github.com/feliperun/faberun/compare/v0.3.0...v0.4.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **intent-factory:** lay the skill out as source, not a pile of scripts
* **intent-factory:** call them harnesses, one folder each

### Features

* add dependency-free npx installer for the skill catalog ([cebed27](https://github.com/feliperun/faberun/commit/cebed27aa8c0ede951d3f7801c724387938fdcca))
* add session-memory skill with SessionStart handoff injection ([665988a](https://github.com/feliperun/faberun/commit/665988aa06be6283ce32b0a40012d161eebc99f4))
* **init-harness:** align the AGENTS.md template with the root playbook ([3abd95c](https://github.com/feliperun/faberun/commit/3abd95c275d103b95afd7e07013eeee3e115b6fb))
* **intent-factory:** a router under 1 KiB, and articles nobody can silently replace ([d1d0e4e](https://github.com/feliperun/faberun/commit/d1d0e4ee7ce71e5684abe873993303fa413bc2da))
* **intent-factory:** add derived heartbeat, liveness journal facts and notify adapters ([4bea9fd](https://github.com/feliperun/faberun/commit/4bea9fdcc6c124f9fdcc608c4afc6aa366b7fafa))
* **intent-factory:** add durable campaign progress ([62ecf13](https://github.com/feliperun/faberun/commit/62ecf137d43589e3f9a5b6ed117b87a67cc76b39))
* **intent-factory:** add live campaign dashboard ([a98a04a](https://github.com/feliperun/faberun/commit/a98a04aa6d38e89dbed227e7d6718afcaa442a9a))
* **intent-factory:** ambient status line for campaign liveness ([42a3f51](https://github.com/feliperun/faberun/commit/42a3f5103a27e805872bac8f53d7fa76638b1341))
* **intent-factory:** bound the worker harness preamble in claude, glm and codex drivers ([c2ab1c9](https://github.com/feliperun/faberun/commit/c2ab1c9e3eb322ba5f8dfb3319e1b0282d3bf44c))
* **intent-factory:** canonical heartbeat bytes, strict timestamps, governance metrics ([f0094ee](https://github.com/feliperun/faberun/commit/f0094eec62161b6589e88da1278e18f4f95855fd))
* **intent-factory:** carry the Z.ai coding-plan environment in the glm driver ([225b3aa](https://github.com/feliperun/faberun/commit/225b3aaeb409c219e06928946be6da5f6b7bc740))
* **intent-factory:** compute section-6 indicators over usage.jsonl and notify.jsonl ([b7d7b78](https://github.com/feliperun/faberun/commit/b7d7b786ca0e403f425bd9732f4a44b0a2739bd6))
* **intent-factory:** continue a retried attempt from the sealed previous attempt ([f39fcca](https://github.com/feliperun/faberun/commit/f39fccab45d6f3b404892c4e8097d16235b3070d))
* **intent-factory:** dashboard v2 over status.json, usage.jsonl and notify.jsonl ([2a60917](https://github.com/feliperun/faberun/commit/2a60917d707c43040fc9296429dd7c302d5010b6))
* **intent-factory:** delegate the bulk read, and make the suite prove the tests assert ([867cf50](https://github.com/feliperun/faberun/commit/867cf5045611e71865f6d211c1189d844df1a05d))
* **intent-factory:** delete every spend ceiling and ship contract schema 3 ([ad0a8a0](https://github.com/feliperun/faberun/commit/ad0a8a059b4253f603c806611feffaf5b7a77fe9))
* **intent-factory:** derive per-node budgets from a versioned profile ([c4610c2](https://github.com/feliperun/faberun/commit/c4610c27f5c6505ab01d80f9b1101f3229e87ca5))
* **intent-factory:** deterministic replay driver for recorded sessions ([d7485bd](https://github.com/feliperun/faberun/commit/d7485bd67d987b5871851ba73d318717d9bffef9))
* **intent-factory:** deterministic resilience ([c0f201b](https://github.com/feliperun/faberun/commit/c0f201b62b4ba76234f70a7a68350a2b438d0bb1))
* **intent-factory:** discover and route campaign runtimes ([ab13540](https://github.com/feliperun/faberun/commit/ab135404cb0b645539791ea545b39f82184878cc))
* **intent-factory:** drive the DeepSeek Harness as a factory runtime ([#4](https://github.com/feliperun/faberun/issues/4)) ([9188c75](https://github.com/feliperun/faberun/commit/9188c753fd9fa51785e8db5127b2068a23fe6329))
* **intent-factory:** durable worker results, automatic rotation, and tool policy ([b33a941](https://github.com/feliperun/faberun/commit/b33a941ea320e844795e45ac9270bd7c997710d8))
* **intent-factory:** freeze incident runs against resume, cancel and handoff ([e007c72](https://github.com/feliperun/faberun/commit/e007c728e661e4e6546b66ded233fd47726487a5))
* **intent-factory:** gate economy — conditional judge, finalVerification, prune ([3504c8a](https://github.com/feliperun/faberun/commit/3504c8a731feae865c8fdf60646644c234753477))
* **intent-factory:** liveness watchdog wiring and the four Sol liveness fixes ([aae056f](https://github.com/feliperun/faberun/commit/aae056fb59ac588cc0ec06c028e5f09e4bfa74b5))
* **intent-factory:** machine-readable preflight payload under --json ([bd4c444](https://github.com/feliperun/faberun/commit/bd4c444df8a8545229cc4d79892f3cb6200702c2))
* **intent-factory:** make supervise real, and stop one retry spending two attempts ([dd9a8d5](https://github.com/feliperun/faberun/commit/dd9a8d5a8153d586eef6774edb230093015df0ea))
* **intent-factory:** make the local surface remotable, and keep it off the internet ([fbd65a6](https://github.com/feliperun/faberun/commit/fbd65a6df6e8f244637dbbf81a204e9553a57f38))
* **intent-factory:** make the zcode driver put its CLI on PATH ([f73cabf](https://github.com/feliperun/faberun/commit/f73cabf9380814d775376c160ea7d7c8c2fe3ce9))
* **intent-factory:** metrics projector, CLI and the release-1 eval set ([cb3b9be](https://github.com/feliperun/faberun/commit/cb3b9bed5e804c88912f3be7730ed70ff833043d))
* **intent-factory:** native zcode driver for GLM runtimes ([#5](https://github.com/feliperun/faberun/issues/5)) ([49b0a98](https://github.com/feliperun/faberun/commit/49b0a982a869809b14a736aa8f55a08bde0f8852))
* **intent-factory:** one controller per run behind an atomic lock ([0f7c9cd](https://github.com/feliperun/faberun/commit/0f7c9cddda615771807135cc22da3148a83ad668))
* **intent-factory:** persist budget decisions, extensions and predeclared continuations ([f58c877](https://github.com/feliperun/faberun/commit/f58c877e114c9aa8bf311477f8aed592f5bcaa7b))
* **intent-factory:** projected outbox events with pull-only session sync ([95d172c](https://github.com/feliperun/faberun/commit/95d172c8f8c235d67c6e42c8deb9522348c9bcaa))
* **intent-factory:** protocol schema 2 with mechanical Definition of Done ([07f5dce](https://github.com/feliperun/faberun/commit/07f5dce873caaedf8dcadcd9721a0b2301fa2df2))
* **intent-factory:** require a recorded retrospective before campaign close ([2aea1d8](https://github.com/feliperun/faberun/commit/2aea1d84daa22772d566edac6f1c012449d070b7))
* **intent-factory:** rules a test can fail, and obey them ([33a4772](https://github.com/feliperun/faberun/commit/33a4772b8f5d0e7a1ba08629964d34aadc4c81ae))
* **intent-factory:** status surfaces read status.json in the page order ([6c1d240](https://github.com/feliperun/faberun/commit/6c1d2404391d1f5eef52b0e7cf9e8bff457c96d9))
* **intent-factory:** status.json each tick and direct notifications with receipts ([e6933c3](https://github.com/feliperun/faberun/commit/e6933c355ac33717116e9987b7e8fd18bb766b0d))
* **intent-factory:** the interception policy gets its three decisions ([9d9d328](https://github.com/feliperun/faberun/commit/9d9d3280afa2c1bccba5cd63f94b1d6a939fb9d5))
* **intent-factory:** the operator brief, and notification that stops insisting ([3245f76](https://github.com/feliperun/faberun/commit/3245f76f9f1f4e3b40bab27107ea14b5999d8927))
* **intent-factory:** the operator seat ([4fd388c](https://github.com/feliperun/faberun/commit/4fd388c3d94c7d16daa2fa92e2bec9dcb0fd0b49))
* **intent-factory:** time verification commands in preflight ([bcccb23](https://github.com/feliperun/faberun/commit/bcccb2366bf8d7ee9806caf208f58def6554c393))
* **intent-factory:** unblock phase — advisory scope, review modes, retry in place ([b93e8b0](https://github.com/feliperun/faberun/commit/b93e8b0668805628543ff28b08d599e2a856e95c))
* **intent-factory:** wake a session only for an actionable event ([27bc7cd](https://github.com/feliperun/faberun/commit/27bc7cd84c03bba6d7ef08e9341f12edc7f97c79))
* **intent-factory:** wire run liveness into heartbeat and adapter push drain ([0b9d607](https://github.com/feliperun/faberun/commit/0b9d607c67d2dc112761214de2514a472ad0d89a))
* **plan-runner:** add a glm driver for GLM 5.3 via the Z.ai endpoint ([7557723](https://github.com/feliperun/faberun/commit/7557723bc0e71b7aaee90676823338bcd5042eb8))
* **plan-runner:** carry closed-scope violations into findings.json ([7cf9125](https://github.com/feliperun/faberun/commit/7cf9125279bd8a27b13350206c14305d226df58a))
* **plan-runner:** mirror active campaigns and runs into target AGENTS.md ([b093f0e](https://github.com/feliperun/faberun/commit/b093f0e787498770708980ca79d1426b7bd2ddd5))
* **plan-runner:** rename built-in watchdog to supervise ([097615d](https://github.com/feliperun/faberun/commit/097615dc6168649dba982d4586e05dd74776d7d4))
* **plan-runner:** teach the signal block the continue-don't-restart procedure ([5fa4302](https://github.com/feliperun/faberun/commit/5fa43026351bb890b80fd272013d61a2d7f06432))
* **plan-runner:** warn on writeFiles the scope gate cannot observe ([2442355](https://github.com/feliperun/faberun/commit/244235538d9ab69e4a86a98341ea016d84b50b04))
* **plan-runner:** write findings.json handoff and surface contract warnings ([59a55df](https://github.com/feliperun/faberun/commit/59a55df07e0364407352774951a4d1829f79a27d))
* **run-harness:** add durable handoffs and scoped task packets ([c166ba2](https://github.com/feliperun/faberun/commit/c166ba2bd6a2cab6acd3678c3b0c87dc58858ab1))
* **run-harness:** codify operational guidance ([29a6459](https://github.com/feliperun/faberun/commit/29a6459ffda040fed1d66cc3970960b6f310a112))
* **run-harness:** enforce structured worker outcomes, scoped writes, and bounded verification ([747c428](https://github.com/feliperun/faberun/commit/747c428fd059d4a2287b835dff72c1e10a586fd8))
* **run-harness:** parallel preflight, rich events, report command ([7a8e90c](https://github.com/feliperun/faberun/commit/7a8e90c1273fd1b0cdb1f53d57ec1b29764385e4))
* **run-harness:** support agy runtimes ([8fe6036](https://github.com/feliperun/faberun/commit/8fe6036dc21f46c0dda7b7a3463a6aaed18ce1dd))
* **run-harness:** watchdog, fix-node findings, token budget, worker feedback ([95987dd](https://github.com/feliperun/faberun/commit/95987dd9adc8559d8db6cb633d9ba3edb6e621d9))
* **skills:** add humanize ([967ff58](https://github.com/feliperun/faberun/commit/967ff58038e42329ede8711ca377780e6f8bddd0))
* **skills:** add init-harness, scrubbed of private-repo references ([c3311ee](https://github.com/feliperun/faberun/commit/c3311ee5a32d678e3775beb0ba8bd7252f52734e))
* **skills:** run-harness detached launch and revision budget ([12dd2be](https://github.com/feliperun/faberun/commit/12dd2bed29500530bb18dfa42422883fdbf24456))


### Bug Fixes

* apply the judges' landing findings from the become-faberun campaign ([5373df1](https://github.com/feliperun/faberun/commit/5373df164df6e52f328d8ff2fcfb6b003504eb70))
* **init-harness:** create the .github/copilot-instructions.md symlink ([5888a62](https://github.com/feliperun/faberun/commit/5888a629eb16062924bf1f71e7feeab0437aa9ac))
* **intent-factory:** adopt completed turns, bound rotation and protect judge budget ([6eef5e0](https://github.com/feliperun/faberun/commit/6eef5e0ca0dae1a6e53148dede2bf2f08ca39241))
* **intent-factory:** advertise the judge envelope the parser enforces ([a1148e7](https://github.com/feliperun/faberun/commit/a1148e77a5e6ddc31b39205da477d6b979cb4e15))
* **intent-factory:** annotate the seal regression test's git helper ([29b2862](https://github.com/feliperun/faberun/commit/29b2862b43c5a12da5680492321c4a0795fc82f1))
* **intent-factory:** carry git's own reason into a failed git command ([038c742](https://github.com/feliperun/faberun/commit/038c7420366e8ba3cf4a1fce70ede05f3eae0f89))
* **intent-factory:** classify codex tool-host failure before cancellation ([717d8bf](https://github.com/feliperun/faberun/commit/717d8bfc83dc120be1d453e0c3c30f7186bd79ad))
* **intent-factory:** clear stale campaign attention ([85d53c9](https://github.com/feliperun/faberun/commit/85d53c9ef17662db64c1e031abc7e966d93e9923))
* **intent-factory:** close a write-scope escape and unblock repos with commit hooks ([f2f47f7](https://github.com/feliperun/faberun/commit/f2f47f7bfbfe54274d25b8d4a0feaa970f8be3d5))
* **intent-factory:** close phase 1 with a green suite ([0657afa](https://github.com/feliperun/faberun/commit/0657afacc5005d57467d4f0b6b4f8e608322672c))
* **intent-factory:** continuity hardening tail — signal-block neutrality, notifier isolation, TypeScript gate ([6077e2e](https://github.com/feliperun/faberun/commit/6077e2ec6d69725872c83c5d67d38516e2b8138f))
* **intent-factory:** cover test/docs/ in Phase 2's own verification gap ([4f50a9b](https://github.com/feliperun/faberun/commit/4f50a9bb788349615668f7598a8eede8fe0f7126))
* **intent-factory:** deny the out-of-scope write before the file exists ([9a1d34e](https://github.com/feliperun/faberun/commit/9a1d34e21846b88ab5171b355c007f4521712622))
* **intent-factory:** enforce the invocation wall-clock deadline in the live loop ([e7916da](https://github.com/feliperun/faberun/commit/e7916da7105a0874331a9423bd96ea6b56ca7d98))
* **intent-factory:** follow the removed field into the fixtures that carry it ([5b5cdbd](https://github.com/feliperun/faberun/commit/5b5cdbd34f6497480cbd474a7e1019f3998ab07f))
* **intent-factory:** give repair contracts a top-level token budget ([3430b56](https://github.com/feliperun/faberun/commit/3430b56ae34423b24011748b27c7934b0414985c))
* **intent-factory:** keep attempt and candidate worktrees in one environment ([90e1317](https://github.com/feliperun/faberun/commit/90e13178c110afade57381cb48077b0c8f418ed2))
* **intent-factory:** keep node_modules links out of seals and carry an eventId on notifications ([88064c4](https://github.com/feliperun/faberun/commit/88064c46b56267ce56264dc283092cc0af8f8856))
* **intent-factory:** keep runner-managed signal-block rewrites out of worker scope drift ([f4137aa](https://github.com/feliperun/faberun/commit/f4137aaca14c4fab0be8e887451722e0e38dc367))
* **intent-factory:** let a clean judge verdict omit its empty findings ([66f46c9](https://github.com/feliperun/faberun/commit/66f46c9b300b1116c4aa757d624d8cc2a865197c))
* **intent-factory:** let a done gated worker reach its judge on resume ([5d64fe6](https://github.com/feliperun/faberun/commit/5d64fe643a429204539a4f294dbb6787476bab51))
* **intent-factory:** let a dsh worker execute at the harness default ([6f7775d](https://github.com/feliperun/faberun/commit/6f7775da42c45999927a05f794ceb96bb7d959ed))
* **intent-factory:** let findings answer the question a stopped worker actually asked ([687e5c1](https://github.com/feliperun/faberun/commit/687e5c1f44d86028879013f4595d1aaff066e7f3))
* **intent-factory:** let the capped-continuation test record usage under load ([627bb80](https://github.com/feliperun/faberun/commit/627bb8005f39b3aa8bedf0b024a3d37bb437eb57))
* **intent-factory:** link node_modules into the integration candidate ([ce675f9](https://github.com/feliperun/faberun/commit/ce675f9ddc82859f729915a460378b05f8b880c2))
* **intent-factory:** name the failure the observation catch expects ([f0bc7b4](https://github.com/feliperun/faberun/commit/f0bc7b40356b6ae81c8afd7ea98879a1c36b5a76))
* **intent-factory:** preserve judge budget during exhaustion ([0f04e2c](https://github.com/feliperun/faberun/commit/0f04e2cc8490a19821cb253592d8d0cbe7fd2b8c))
* **intent-factory:** put every field back in the judge schema's required ([6d95c4e](https://github.com/feliperun/faberun/commit/6d95c4e747592109c89286d053bf860410e0c93a))
* **intent-factory:** readFiles no longer closes scope for a file that may break ([38632c7](https://github.com/feliperun/faberun/commit/38632c73126f3f1918e9ff843e543fda51829abd))
* **intent-factory:** refresh the judge schema on resume ([afb0975](https://github.com/feliperun/faberun/commit/afb0975c468d0edf70c70c2d294824ef0a0d2d66))
* **intent-factory:** repair resume worktree recreation and continuation semantics ([097f25d](https://github.com/feliperun/faberun/commit/097f25d31745fbaba686f7e69ad5c5d03049ddf9))
* **intent-factory:** report the provider's startup error, not just an empty stream ([4b28e04](https://github.com/feliperun/faberun/commit/4b28e04d1423f98648f3125d9f8f50296a0810b8))
* **intent-factory:** restore the TypeScript gate after the resilience work ([0a3b084](https://github.com/feliperun/faberun/commit/0a3b084d11adb49982a843c1d08de6fdc575c14e))
* **intent-factory:** seal attempts whose worktree holds the .runs result sidecar ([0913af1](https://github.com/feliperun/faberun/commit/0913af1ea94207ab50ae36cdff78f692a5e8dea7))
* **intent-factory:** serialize notification outbox mutations ([4779d73](https://github.com/feliperun/faberun/commit/4779d73948fdf7185ffcf6be2d5d39deb716fd0b))
* **intent-factory:** snapshot only ignore-relevant git config and scratch roots ([238bdad](https://github.com/feliperun/faberun/commit/238bdadbcc2d627276c23ebb69aeaece7bbfcaae))
* **intent-factory:** start the replay reset window where the work ends ([6d736d6](https://github.com/feliperun/faberun/commit/6d736d65e0dbb1be6dc985cc55b59fd49c6f9492))
* **intent-factory:** stop a failing proof from killing the controller ([4393992](https://github.com/feliperun/faberun/commit/4393992fe98234ec3f89664cc611da4b54e58d88))
* **intent-factory:** stop a worker failover from framing itself as a gate rejection ([599f7df](https://github.com/feliperun/faberun/commit/599f7dff8f7f23c87a0a0f6a3bbdd002dbc89c9e))
* **intent-factory:** stop listing the zcode glm-5.3 tier twice ([7235587](https://github.com/feliperun/faberun/commit/72355875b36b652e204459e50c1f0d88dc176383))
* **intent-factory:** stop paying twice for a codex judge, and name the runtime that did the work ([782d60f](https://github.com/feliperun/faberun/commit/782d60f2aa724355909fae7749894fd91767394f))
* **intent-factory:** stop re-sealing a clean attempt from failing the retry ([6e1afef](https://github.com/feliperun/faberun/commit/6e1afef0e241cfff4c6a89a0dc90bc66b667580c))
* **intent-factory:** stop the cost indicator from rewarding a quiet provider ([4301786](https://github.com/feliperun/faberun/commit/4301786d8f6229631103482e7f74de0bb3febd9f))
* **intent-factory:** stop the golden builder from destroying what it cannot rebuild ([e4d71c3](https://github.com/feliperun/faberun/commit/e4d71c3c6cff63a2a96c6af719bbaf0151918084))
* **intent-factory:** strip the notification transport from worker provider environments ([3be80e3](https://github.com/feliperun/faberun/commit/3be80e33135909ce78b46d8f3b4b3df37470f3e2))
* **intent-factory:** stub every test runtime so no test resolves a provider CLI ([2368c79](https://github.com/feliperun/faberun/commit/2368c7925db2f35204f39695579ed3fbd3320024))
* **intent-factory:** tolerate directories vanishing during snapshot capture ([64fff95](https://github.com/feliperun/faberun/commit/64fff95904a1c43c4a6dff18ab28bf1f223e3a20))
* **intent-factory:** treat a cut provider stream as a transport failure ([e8470bc](https://github.com/feliperun/faberun/commit/e8470bcf6ca2207862565d6134ad9284cc6d638a))
* **intent-factory:** weight cache reads in the node cap and the rotation trigger ([16be1e8](https://github.com/feliperun/faberun/commit/16be1e8af8034f198e48aa3f94b5dda2e41f7634))
* **intent-factory:** weight cached reads in the live token meter ([061680f](https://github.com/feliperun/faberun/commit/061680f9246c0914023c1a0bee6df60e216e5ded))
* **intent-factory:** widen node-state and worktree JSDoc shapes for typecheck ([8ae77bf](https://github.com/feliperun/faberun/commit/8ae77bfd0389597bd01d002c4386c2000033bf0a))
* **plan-runner:** enforce hard token budgets and cap duplicate verification cost ([beb86dd](https://github.com/feliperun/faberun/commit/beb86dd4af9f4bc70a42d8c1e7e631726f4bc86f))
* **plan-runner:** keep agent-runtime scratch out of the closed-scope snapshot ([2ca1ba0](https://github.com/feliperun/faberun/commit/2ca1ba0c76186bd9bb2051d301ff28f5faab353c))
* **plan-runner:** load persisted contracts under the protocol that wrote them ([dc505a3](https://github.com/feliperun/faberun/commit/dc505a3f71f387fd0e430d3d31cb6feb69022d8d))
* **plan-runner:** stamp the campaign next action with session and time ([3995fc4](https://github.com/feliperun/faberun/commit/3995fc422b8416586da8633df7a60d008bbb01d6))
* **plan-runner:** tolerate provider-added fields at the LLM boundaries ([fb6ff27](https://github.com/feliperun/faberun/commit/fb6ff270e075e4a67ddf5ffd6a51345cbbbf7d30))
* **run-harness:** parse structured agy results ([43915ce](https://github.com/feliperun/faberun/commit/43915cefd2609efbae7495d8dd0edc493694af09))
* **skills:** keep disabled gates disabled through resume ([b79a80a](https://github.com/feliperun/faberun/commit/b79a80ad7af3b86d91e573e9e1ab252c4c72c25f))
* **test:** the brand ratchet skips the managed signal block ([56d25cd](https://github.com/feliperun/faberun/commit/56d25cd6347a4c2caf141e339ca698d59bda0af2))


### Code Refactoring

* **intent-factory:** call them harnesses, one folder each ([f802aea](https://github.com/feliperun/faberun/commit/f802aeaf60af174c2c980661ef6e6301da34c792))
* **intent-factory:** lay the skill out as source, not a pile of scripts ([b0f9b8b](https://github.com/feliperun/faberun/commit/b0f9b8b207876ee6132586ced684d345fc5b4944))

## 0.3.0 (2026-09-09)

The lean release that made the repository the home of the tool is recorded in
[docs/history/RETROSPECTIVE-2026-09-08.md](docs/history/RETROSPECTIVE-2026-09-08.md).
