# psychoscript

- This repo is only the language: compiler, VM, runtime, standard library, snapshots and the Effect driver. No
  tool-specific code; hosts expose functions through `Host` and run programs with `Runtime.make`.
- Use Bun. Run one test command at a time. Run `bun run check` before pushing; `bun run test:roundtrip` when touching
  the VM, snapshots or suspend.
- After changing `src/prelude/` or opcodes, run `bun run script/prelude.ts` and commit
  `src/prelude/bytecode.json`.
- test262: sync with `bun run script/sync-test262.ts <checkout>` at the revision in `test/test262/manifest.json`, then
  `bun test test/test262.test.ts`. Update `skipped.txt` with `bun run script/test262-report.ts --write`.
- Keep `interpreter-support.md` and `README.md` in step with behavior changes.
- VM code works on `Value`, not `unknown`. No `effect` imports in the VM, compiler, prelude, snapshot or stdlib.
- PRs go into `dev` and are squash-merged. Changes to `.github/` need Dax.
