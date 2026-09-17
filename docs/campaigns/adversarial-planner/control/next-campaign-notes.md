# Engine defect found 2026-09-17 08:15Z (campaign adversarial-planner)

`supervise campaign` launches each contract with `run --base-ref <land branch>`, and the chain
itself validates the manifest entry in a throwaway worktree of that ref (chain.mjs
validateManifestEntryAtLaunch). The launched run then re-validates the contract against the
*checkout* (src/cli.mjs:283 `validateContract` before `setLaunchBaseRef`), so a contract whose
readFiles name files the previous phase created fails at launch with
`detached bootstrap failed before readiness` and the campaign parks with `launch_failed`.
Operator workaround: `git checkout --detach <land branch>` before relaunching the chain.
Fix candidate: `run --base-ref <ref>` validates the contract against that ref (the same
throwaway-worktree path the chain already has), not against the working tree.
