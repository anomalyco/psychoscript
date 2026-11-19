# psychoscript

- Use Bun. `bun run typecheck` (tsc), `bun test`, `bun run test:roundtrip`, `bun run build`.
- This repo is only the language: compiler, VM, runtime, standard library, snapshots and the Effect driver. No
  tool-specific code; hosts expose functions through `Host` and run programs with `Runtime.make`.
- After changing `src/prelude/`, `src/internal-prelude.ts` or opcodes, run `bun run script/prelude.ts` and commit
  `src/prelude/bytecode.json`.
- test262: sync with `bun run script/sync-test262.ts <checkout>` (at the revision in `test/test262/manifest.json`),
  then `bun test test/test262.test.ts`. Update `skipped.txt` with `bun run script/test262-report.ts --write`.
- Keep `interpreter-support.md` in step with behavior changes.
- VM code works on `Value`, not `unknown`. No `effect` imports in the VM, compiler, prelude, snapshot or stdlib.
