const p = "/repo/src/vm.rs"
await tools.edit({ path: p, oldString: "Heap::with_capacity(1024)", newString: "Heap::with_capacity(320)" })
await tools.edit({ path: p, oldString: "Vec::with_capacity(1024)", newString: "Vec::with_capacity(128)" })
const r = await tools.shell({ command: "cargo build --release 2>&1 | tail -3" })
return r.exitCode === 0 ? "built\n" + r.output : "FAILED\n" + r.output
