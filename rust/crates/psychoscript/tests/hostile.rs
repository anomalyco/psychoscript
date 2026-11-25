//! Hostile input ends in a diagnostic, never a panic: malformed programs (mutations of the conformance cases, deep
//! nesting, huge literals, lone surrogates, giant regexes, deep recursion), hostile host values, and malformed saved
//! states. Deterministic: a fixed seed, and `HOSTILE_ROUNDS` mutations per case (default 2). `HOSTILE_TEST262` names
//! a test262 checkout to mutate its tests too, after its harness; `HOSTILE_VERBOSE` names each run and the slow ones.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Arc, Mutex};

use psychoscript::{
    DurableFunction, Failure, HostError, HostFunction, HostString, HostValue, Json, Limits,
    Namespace, ProgramOptions, Runtime, Snapshot, TypedArray, TypedKind,
};

/// xorshift64*: the same mutations on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn limits() -> Limits {
    Limits {
        timeout_ms: Some(200),
        max_heap_bytes: Some(64 << 20),
        max_output_bytes: Some(1 << 16),
        ..Limits::default()
    }
}

/// A runtime with a few host globals, so mutations reach the boundary too.
fn runtime() -> Runtime {
    Runtime::make().limits(limits()).globals(|_| {
        [
            (
                "echo",
                HostValue::Function(HostFunction::new(|args, _| {
                    args.into_iter().next().unwrap_or_default()
                })),
            ),
            (
                "later",
                HostValue::Function(HostFunction::new_async(|args, _| async move {
                    Ok(args.into_iter().next().unwrap_or_default())
                })),
            ),
        ]
    })
}

// Where each panic was, by a hook that also keeps the default report quiet: a failure lists them all at the end.
thread_local! {
    static PANICS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let at = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()));
            let message = info
                .payload()
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            let site = format!("{}: {message}", at.unwrap_or_default());
            PANICS.with(|p| p.borrow_mut().push(site));
        }))
    });
}

/// Fails with every panic `label`s saw: each site once, with the first input that reached it.
fn report(failures: Vec<(String, String)>) {
    let mut seen = std::collections::BTreeMap::new();
    for (site, label) in failures {
        seen.entry(site).or_insert(label);
    }
    let sites: Vec<_> = seen
        .iter()
        .map(|(site, label)| format!("{site}\n    first: {label}"))
        .collect();
    if !sites.is_empty() {
        // Printed here: the hook keeps the assertion's own message quiet.
        eprintln!("{} panic sites:\n{}", sites.len(), sites.join("\n"));
    }
    assert!(sites.is_empty(), "{} panic sites", sites.len());
}

/// Runs `f`, giving back the panics it hit (and an internal error it reported, as one).
fn guarded(label: &str, f: impl FnOnce() -> bool) -> Vec<(String, String)> {
    hook();
    PANICS.with(|p| p.borrow_mut().clear());
    let outcome = catch_unwind(AssertUnwindSafe(f));
    let mut sites: Vec<_> = PANICS
        .with(|p| std::mem::take(&mut *p.borrow_mut()))
        .into_iter()
        .map(|site| (site, label.to_owned()))
        .collect();
    if outcome.is_err() && sites.is_empty() {
        sites.push(("a panic on another thread".into(), label.to_owned()));
    }
    let internal = outcome.unwrap_or(false);
    if internal {
        sites.push(("Internal interpreter error".into(), label.to_owned()));
    }
    sites
}

/// Runs `code`; the panics it hit, or an internal error it reported.
fn survives(rt: &Runtime, label: &str, code: &str) -> Vec<(String, String)> {
    survives_after(rt, label, "", code)
}

/// Runs `harness` and then `code`, named by `code`.
fn survives_after(rt: &Runtime, label: &str, harness: &str, code: &str) -> Vec<(String, String)> {
    let label = format!("{label}: {}", preview(code));
    let code = &format!("{harness}{code}");
    let verbose = std::env::var_os("HOSTILE_VERBOSE").is_some();
    let start = std::time::Instant::now();
    if verbose {
        eprintln!("{label}");
    }
    let _slow = Slow(verbose, start, label.clone());
    guarded(&label, || {
        match rt.program(code, &ProgramOptions::new()).run() {
            Ok(o) => o.result.err().is_some_and(|d| {
                d.message
                    .to_string_lossy()
                    .contains("Internal interpreter error")
            }),
            Err(_interrupted) => false,
        }
    })
}

/// Reports a run that took long, with `HOSTILE_VERBOSE`.
struct Slow(bool, std::time::Instant, String);

impl Drop for Slow {
    fn drop(&mut self) {
        let took = self.1.elapsed();
        if self.0 && took > std::time::Duration::from_millis(1000) {
            eprintln!("SLOW {took:?}: {}", self.2);
        }
    }
}

fn preview(code: &str) -> String {
    let mut end = code.len().min(300);
    while !code.is_char_boundary(end) {
        end -= 1;
    }
    code[..end].to_owned()
}

const TOKENS: &[&str] = &[
    "{",
    "}",
    "(",
    ")",
    "[",
    "]",
    ";",
    ",",
    "'",
    "\"",
    "`",
    "${",
    "/",
    "\\",
    "=>",
    "...",
    "?.",
    "??",
    "=",
    "+",
    "-",
    "*",
    "**",
    "%",
    "!",
    "~",
    "<",
    ">",
    "&&",
    "||",
    "|",
    "&",
    "^",
    "<<",
    ">>>",
    "\n",
    "\u{2028}",
    "\u{feff}",
    "\0",
    "\u{d7ff}",
    "\u{10ffff}",
    "\\u{110000}",
    "\\uD800",
    "\\uDC00",
    "\\x",
    "0x",
    "1e999",
    "9007199254740993n",
    "-0",
    "NaN",
    "Infinity",
    "undefined",
    "null",
    "this",
    "super",
    "new",
    "class",
    "function",
    "function*",
    "async",
    "await",
    "yield",
    "return",
    "throw",
    "try",
    "catch",
    "finally",
    "if",
    "else",
    "for",
    "while",
    "do",
    "break",
    "continue",
    "switch",
    "case",
    "default",
    "let",
    "const",
    "var",
    "of",
    "in",
    "instanceof",
    "typeof",
    "delete",
    "void",
    "get",
    "set",
    "static",
    "#x",
    "import",
    "export",
    "with",
    "debugger",
    "label:",
    "echo(",
    "later(",
    "Symbol.iterator",
    "__proto__",
    "constructor",
    "prototype",
    ".then(",
    "/(?<a>.)\\k<a>/v",
    "/[/",
    "/a{99999}/",
];

fn mutate(rng: &mut Rng, src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<char> = chars.clone();
    for _ in 0..1 + rng.below(4) {
        let at = rng.below(out.len() + 1);
        match rng.below(6) {
            // Truncate.
            0 => out.truncate(at),
            // Delete a run.
            1 => {
                let end = (at + 1 + rng.below(16)).min(out.len());
                out.drain(at.min(end)..end);
            }
            // Duplicate a run.
            2 => {
                let end = (at + 1 + rng.below(64)).min(out.len());
                let run: Vec<char> = out[at.min(end)..end].to_vec();
                out.splice(at.min(end)..at.min(end), run);
            }
            // Insert a token.
            3 | 4 => {
                let t = TOKENS[rng.below(TOKENS.len())];
                out.splice(at..at, t.chars());
            }
            // Swap two chars.
            _ => {
                if !out.is_empty() {
                    let b = rng.below(out.len());
                    let a = at.min(out.len() - 1);
                    out.swap(a, b);
                }
            }
        }
    }
    out.into_iter().collect()
}

const TEST262_HARNESS: &str = r#"class Test262Error extends Error {}
function $ERROR(m) { throw new Test262Error(m) }
function $DONOTEVALUATE() { throw new Test262Error("evaluated") }
const assert = (c, m) => { if (c !== true) throw new Test262Error(m) }
assert.sameValue = (a, b, m) => { if (!Object.is(a, b)) throw new Test262Error(m) }
assert.notSameValue = (a, b, m) => { if (Object.is(a, b)) throw new Test262Error(m) }
assert.throws = (E, f, m) => { try { f() } catch (e) { if (e.constructor !== E) throw new Test262Error(m); return } throw new Test262Error(m) }
const compareArray = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
assert.compareArray = (a, b, m) => { if (!compareArray(a, b)) throw new Test262Error(m) }
const verifyProperty = (o, k, d) => { const own = Object.getOwnPropertyDescriptor(o, k); if (d && 'value' in d) assert.sameValue(own.value, d.value) }
const verifyNotEnumerable = () => {}, verifyNotWritable = () => {}, verifyNotConfigurable = () => {}
const verifyEnumerable = () => {}, verifyWritable = () => {}, verifyConfigurable = () => {}
const $DONE = (e) => { if (e) throw e }
"#;

/// Each case's path, the harness it runs after (unchanged) and its source (mutated).
fn corpus() -> Vec<(String, String, String)> {
    let read = |files: Vec<String>, harness: &str| -> Vec<(String, String, String)> {
        files
            .into_iter()
            .filter_map(|p| {
                Some((
                    p.clone(),
                    harness.to_owned(),
                    std::fs::read_to_string(&p).ok()?,
                ))
            })
            .collect()
    };
    let mut files = Vec::new();
    collect(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases"),
        &mut files,
    );
    files.sort();
    let mut corpus = read(files, "");
    if let Ok(root) = std::env::var("HOSTILE_TEST262") {
        let root = Path::new(&root);
        // The checkout has no harness files (the runner in test262/ makes them natively): the parts tests call most.
        let harness = TEST262_HARNESS;
        let mut files = Vec::new();
        collect(&root.join("test"), &mut files);
        files.sort();
        corpus.extend(read(files, harness));
    }
    corpus
}

fn collect(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|x| x == "js") {
            out.push(p.to_string_lossy().into_owned());
        }
    }
}

#[test]
fn mutated_programs_end_in_diagnostics() {
    let rounds: usize = std::env::var("HOSTILE_ROUNDS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(2);
    let rt = runtime();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let corpus = corpus();
    assert!(corpus.len() > 100, "the conformance cases are missing");
    let mut failures = Vec::new();
    for (path, harness, src) in &corpus {
        for round in 0..rounds {
            let code = mutate(&mut rng, src);
            let label = format!("{path} round {round}");
            failures.extend(survives_after(&rt, &label, harness, &code));
        }
    }
    report(failures);
}

/// Programs written to break an interpreter: each ends in a value or a diagnostic.
const HOSTILE: &[&str] = &[
    // Huge literals.
    "return 1e400 + 0x1fffffffffffffffffffffffffff + 0b1111111111111111111111111111111111111111111111111111111111",
    "return 123456789012345678901234567890123456789012345678901234567890n ** 1000n",
    "return 2n ** 100000000n",
    "return 1n << (2n ** 64n)",
    "return (-1n) >> (2n ** 64n)",
    "return 1n / 0n",
    "return BigInt.asUintN(2 ** 53, 1n)",
    "return BigInt.asIntN(-1, 1n)",
    "return BigInt(1e400)",
    "return BigInt('0x' + 'f'.repeat(100000)).toString(36).length",
    "return (123.456).toFixed(101)",
    "return (123.456).toPrecision(0)",
    "return (123.456).toString(37)",
    "return (1e21).toFixed(100) + (-1.5e-7).toExponential(100) + (5e-324).toPrecision(100)",
    "return parseInt('1'.repeat(400), 36) + parseFloat('1e' + '9'.repeat(100))",
    "return Number('0x' + 'f'.repeat(1000)) + Number('1'.repeat(10000))",
    // Allocation.
    "return 'x'.repeat(2 ** 30).length",
    "return 'x'.repeat(-1)",
    "return 'x'.padStart(2 ** 31).length",
    "return new Array(2 ** 32 - 1).length",
    "return new Array(-1)",
    "return new Array(2 ** 32)",
    "const a = []; a.length = 2 ** 32 - 1; a.push(1); return a.length",
    "const a = []; a[2 ** 32 - 2] = 1; return a.length",
    "return Array(1e9).fill(0).length",
    "return Array.from({ length: 2 ** 32 - 1 }).length",
    "return Array.from({ length: Infinity })",
    "return [].concat(...Array(100000).fill([1])).length",
    "return Math.max(...Array(1000000).fill(1))",
    "const a = [1]; return a.splice(0, 2 ** 53, ...Array(10).fill(0)).length",
    "return [1,2,3].copyWithin(2 ** 53, -(2 ** 53)).join()",
    "return 'abc'.split('', -1).length + 'abc'.substring(-Infinity, Infinity) + 'abc'.slice(2 ** 53)",
    "return 'a'.repeat(1000).replace(/a/g, '$&$&$&').length",
    "let s = 'ab'; for (let i = 0; i < 40; i++) s = s + s; return s.length",
    "const o = {}; for (let i = 0; i < 2000000; i++) o['k' + i] = i; return Object.keys(o).length",
    "const m = new Map(); for (let i = 0; i < 2000000; i++) m.set({}, i); return m.size",
    "const m = new Map([[NaN, 1], [-0, 2], [0, 3]]); return [m.get(NaN), m.get(0), m.size]",
    "return new Set([NaN, NaN, -0, 0]).size",
    "return new Uint8Array(-1)",
    "return new Uint8Array(2 ** 40)",
    "return new Float64Array(2 ** 32)",
    "return new Uint8Array([1,2,3]).subarray(2 ** 53, -(2 ** 53)).length",
    "return new TextDecoder().decode(new Uint8Array([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80]))",
    "return atob('====') ",
    "return atob('\\u0100')",
    "return btoa('\\u0100')",
    // Unicode.
    "return '\\uD800'.normalize('NFC') + '\\uDC00\\uD800'.toUpperCase() + '\\uD800'.localeCompare('\\uDC00')",
    "return encodeURIComponent('\\uD800')",
    "return encodeURI('\\uDC00x')",
    "return decodeURIComponent('%')",
    "return decodeURIComponent('%ED%A0%80')",
    "return String.fromCodePoint(0x110000)",
    "return String.fromCodePoint(-1)",
    "return String.fromCharCode(0xD800, 0xD800).codePointAt(0) + [...'\\uD800\\uDC00\\uD800'].length",
    "return '\\uD800'.isWellFormed() + '\\uD800'.toWellFormed() + 'a\\uD800'.at(-1)",
    "return JSON.stringify('\\uD800\\uDFFF\\uDFFF')",
    "return JSON.parse('\"\\\\uD800\"')",
    "return /\\uD800/u.test('\\uD800') + /./u.exec('\\uD800\\uDC00')[0].length",
    "return 'x'.localeCompare('y', 'zz-ZZZZ-$$$-invalid')",
    "return 'x'.localeCompare('y', ['en', 'x'.repeat(10000)])",
    "return new Date(0).toLocaleString('und-u-ca-xxxx-nu-yyyy', { timeZone: 'Mars/Olympus' })",
    "return new Date(0).toLocaleString('en', { timeZone: 'x'.repeat(100000) })",
    "return new Date(8.64e15).toLocaleString('ar-u-ca-islamic')",
    "return [new Date(8.64e15 + 1).getTime(), new Date(-8.64e15).toISOString()]",
    "return new Date(8.64e15 + 1).toISOString()",
    "return new Date(275760, 8, 13, 0, 0, 0, 1).getTime()",
    "return Date.UTC(1e20, 1e20, 1e20) + Date.parse('+275760-09-13T00:00:00.001Z')",
    "return new Date(2 ** 53).toString() + new Date(NaN).toLocaleDateString()",
    "return new URL('http://' + '\\uD800' + '.com')",
    "return new URL('http://' + 'a.'.repeat(100000))",
    "return new URL('x', 'not a base')",
    "return new URLSearchParams('a=%&b=%zz&%ED%A0%80=1').toString()",
    "var \\u0061 = 1; let \\u{1F600} = 2; return a",
    "return '\\u{10FFFF}'.codePointAt(0) + '\\u{110000}'",
    "\u{feff}return 1",
    "return 1\u{2028}+\u{2029}2",
    "return 'a\0b'.length",
    // Regexes.
    "return new RegExp('('.repeat(100000))",
    "return new RegExp('('.repeat(100000) + ')'.repeat(100000)).test('')",
    "return new RegExp('[' + 'a-'.repeat(100000) + ']').test('a')",
    "return new RegExp('a{2147483648}').test('a')",
    "return /a{999999999}/.test('a')",
    "return /a{2,1}/",
    "return new RegExp('(?:a|b)*'.repeat(10000)).test('ab'.repeat(1000))",
    // Small: a regex's backtracking can't be interrupted by the run's timeout.
    "return /(a+)+$/.test('a'.repeat(16) + 'b')",
    "return /(a|a)*b/.test('a'.repeat(16))",
    "return /(?<n>a)\\k<m>/",
    "return new RegExp('\\\\' + 'u{' + 'f'.repeat(100) + '}', 'u')",
    "return new RegExp('[\\\\u{10FFFF}-\\\\u{0}]', 'u')",
    "return new RegExp('x', 'gg')",
    "return new RegExp('x', 'uv')",
    "return /[\\p{Lu}--\\p{Ll}]/v.test('A') + /\\p{RGI_Emoji}/v.test('x')",
    "return /\\p{NotAProperty}/u",
    "return 'a'.repeat(100000).replace(/(?=a)/g, 'b').length",
    "return 'aaa'.replaceAll(/(?:)/g, '$<x>$1$99$`$\\'').length",
    "return [...'a'.repeat(100000).matchAll(/(?:)/g)].length",
    "const r = /a/g; r.lastIndex = 2 ** 53; return r.exec('aaa')",
    "const r = /a/y; r.lastIndex = -1; return r.test('a')",
    // Deep recursion and re-entry.
    "function f() { return f() } return f()",
    "function f(n) { return [f(n + 1)] } return f(0)",
    "function f() { return [1].map(f) } return f()",
    "function f() { return [3, 1, 2].sort(() => f()) } return f()",
    "function f() { return JSON.stringify({ toJSON: f }) } return f()",
    "function f() { return JSON.parse('[1]', f) } return f()",
    "const o = { get x() { return this.x } }; return o.x",
    "const o = { toString() { return String(this) } }; return String(o)",
    "const o = { valueOf() { return +this } }; return +o",
    "const o = { [Symbol.toPrimitive]() { return `${this}` } }; return `${o}`",
    "class A { constructor() { new A() } } return new A()",
    "class A extends Array { constructor() { super(); new A() } } return new A()",
    "function* g() { yield* g() } return [...g()]",
    "async function f() { await f() } return f()",
    "async function f() { return f() } return await f()",
    "let p = Promise.resolve(0); for (let i = 0; i < 1000000; i++) p = p.then(x => x + 1); return await p",
    "const then = { then(r) { r(then) } }; return await then",
    "function f() { try { return f() } finally { return f() } } return f()",
    "function f() { try { f() } catch { f() } } return f()",
    "const a = [1, 2]; a.sort(() => { a.length = 0; a.push(...Array(1000).fill(0)); return 1 }); return a.length",
    "const a = [1, 2, 3]; return a.map(x => { a.length = 0; return x })",
    "const a = Array(10).fill(0); return a.reduce((s, x, i) => { a.pop(); return s + i }, 0)",
    "const m = new Map([[1, 1]]); for (const [k] of m) { m.delete(k); m.set(k + 1, 0); if (k > 100000) break } return m.size",
    "const s = new Set([1]); s.forEach(v => { s.delete(v); if (v < 100000) s.add(v + 1) }); return s.size",
    "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return a",
    "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return JSON.stringify(a)",
    "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return String(a)",
    "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return a.flat(Infinity)",
    "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return echo(a)",
    "let o = {}; for (let i = 0; i < 1000000; i++) o = { o }; return await later(o)",
    "let o = {}; for (let i = 0; i < 1000000; i++) o = { o }; console.log(o); return 1",
    "let o = {}; for (let i = 0; i < 1000000; i++) o = Object.create(o); return o.x",
    "let o = {}; for (let i = 0; i < 1000000; i++) o = { __proto__: o }; return 'x' in o",
    "let e = new Error('x'); for (let i = 0; i < 100000; i++) e = new Error('x', { cause: e }); throw e",
    "let m = new Map(); for (let i = 0; i < 100000; i++) m = new Map([[m, m]]); return structuredClone(m)",
    "return JSON.parse('['.repeat(1000000) + ']'.repeat(1000000))",
    "return JSON.parse('{\"a\":'.repeat(100000) + '1' + '}'.repeat(100000))",
    "return JSON.parse('1'.repeat(100000))",
    "return JSON.parse('\"' + '\\\\u'.repeat(10) + '\"')",
    "const a = [1]; a.push(a); return a",
    "const a = [1]; a.push(a); return JSON.stringify(a)",
    "const a = [1]; a.push(a); return a.join()",
    "const a = [1]; a.push(a); return a.flat(Infinity)",
    "const o = {}; o.o = o; return echo(o)",
    "return Function('return 1')()",
    "return eval('1')",
    "with ({}) {}",
    "label: label: 1",
    "return import('x')",
    "export default 1",
    "throw undefined",
    "throw { toString() { throw new Error('x') } }",
    "throw { get message() { throw 1 }, get name() { throw 2 }, get stack() { throw 3 } }",
    "const e = new Error('x'); Object.defineProperty(e, 'stack', { get() { throw e } }); throw e",
    "class E extends Error { get name() { throw this } } throw new E('x')",
    "return Symbol() + ''",
    "return { [Symbol.toPrimitive]: 1 } + 1",
    "return Object.defineProperty([], 'length', { value: -1 })",
    "return Object.defineProperty([], 'length', { get() {} })",
    "return Object.freeze(new Uint8Array(1))",
    "return Reflect.construct(Object, [], Symbol)",
    "return new Proxy({}, {})",
    "return Array.prototype.join.call({ length: 2 ** 53 - 1 })",
    "return Array.prototype.indexOf.call({ length: 2 ** 53 - 1 }, 1)",
    "return Array.prototype.lastIndexOf.call({ length: 2 ** 53 - 1 }, 1)",
    "return Array.prototype.reverse.call({ length: 2 ** 53 - 1 })",
    "return Array.prototype.fill.call({ length: 2 ** 53 - 1 }, 1)",
    "return Array.prototype.slice.call({ length: 2 ** 53 - 1 }, -1)",
    "return Array.prototype.splice.call({ length: 2 ** 53 - 1 }, 0, 0, 1)",
    "return Array.prototype.push.call({ length: 2 ** 53 - 1 }, 1)",
    "return Array.prototype.unshift.call({ length: 2 ** 53 - 1 }, 1)",
    "return Array.prototype.at.call({ length: 2 ** 53 - 1 }, -1)",
    "return Array.prototype.sort.call({ length: 2 ** 53 - 1 })",
    "return Array.prototype.flat.call({ length: 2 ** 53 - 1 })",
    "return Array.from({ length: -1 })",
    "return String.prototype.repeat.call({ toString() { return 'ab' } }, 2 ** 28)",
    "return [].toSorted.call({ length: 2 ** 32 })",
    "return [1, 2, 3].with(2 ** 53, 0)",
    "return Atomics",
    "return globalThis.globalThis.globalThis",
    "return Object.getOwnPropertyNames(globalThis).map(k => { try { return typeof globalThis[k] } catch { return 'x' } })",
    "for (const k of Object.getOwnPropertyNames(globalThis)) { try { new globalThis[k](undefined, null, -1, NaN, 2 ** 53) } catch {} try { globalThis[k](undefined, null, -1, NaN, 2 ** 53) } catch {} } return 1",
];

/// Source made by code: deep nesting of every bracket and operator.
fn generated() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for n in [1000, 100_000] {
        let mut add = |name: &str, code: String| out.push((format!("{name} x{n}"), code));
        add(
            "arrays",
            format!("return {}1{}", "[".repeat(n), "]".repeat(n)),
        );
        add(
            "parens",
            format!("return {}1{}", "(".repeat(n), ")".repeat(n)),
        );
        add(
            "objects",
            format!("return {}1{}", "{a:".repeat(n), "}".repeat(n)),
        );
        add("blocks", format!("{}{}", "{".repeat(n), "}".repeat(n)));
        add("unclosed", format!("return {}", "[".repeat(n)));
        add("unopened", format!("return {}", "]".repeat(n)));
        add("arrows", format!("return {}1", "a=>".repeat(n)));
        add(
            "unary",
            format!("return {}1", "-".repeat(n).replace("--", "- -")),
        );
        add("not", format!("return {}1", "!".repeat(n)));
        add("typeof", format!("return {}1", "typeof ".repeat(n)));
        add("await", format!("return {}1", "await ".repeat(n)));
        add("sum", format!("return 1{}", "+1".repeat(n)));
        add("power", format!("return 1{}", "**1".repeat(n)));
        add("assign", format!("let a; return {}1", "a=".repeat(n)));
        add("ternary", format!("return {}1", "1?1:".repeat(n)));
        add(
            "calls",
            format!("const f = () => f; return f{}", "()".repeat(n)),
        );
        add(
            "members",
            format!("const o = {{}}; o.o = o; return o{}", ".o".repeat(n)),
        );
        add("optional", format!("return undefined{}", "?.a".repeat(n)));
        add("ifs", format!("{}1", "if (1) ".repeat(n)));
        add("elses", format!("if (0) 1{}", " else if (0) 1".repeat(n)));
        add(
            "templates",
            format!("return {}1{}", "`${".repeat(n), "}`".repeat(n)),
        );
        add(
            "functions",
            format!("{}{}", "function f(){".repeat(n), "}".repeat(n)),
        );
        add(
            "classes",
            format!("return {}1{}", "class { x = ".repeat(n), "}".repeat(n)),
        );
        add(
            "destructuring",
            format!("const {} = 1", "[".repeat(n) + &"]".repeat(n)),
        );
        add(
            "regex groups",
            format!("return /{}a{}/", "(".repeat(n), ")".repeat(n)),
        );
        add(
            "regex classes",
            format!("return /[{}]/v", "[".repeat(n) + &"]".repeat(n)),
        );
        add("comments", format!("{}return 1", "/*/**/".repeat(n)));
        add("strings", format!("return '{}'", "\\u{10FFFF}".repeat(n)));
        add("statements", "1;".repeat(n));
        add("lets", (0..n).map(|i| format!("let v{i} = {i};")).collect());
        add(
            "cases",
            format!("switch (1) {{ {} }}", "case 1: ".repeat(n)),
        );
        add(
            "labels",
            format!("{}1", (0..n).map(|i| format!("l{i}: ")).collect::<String>()),
        );
        add("big literal", format!("return {}n", "9".repeat(n)));
        add(
            "number literal",
            format!("return 0.{}1e-400", "0".repeat(n)),
        );
        add("array literal", format!("return [{}]", "1,".repeat(n)));
        add("holes", format!("return [{}]", ",".repeat(n)));
        add("spread", format!("return [{}]", "...[],".repeat(n)));
        add(
            "params",
            format!(
                "return (({}) => 1)()",
                (0..n).map(|i| format!("p{i},")).collect::<String>()
            ),
        );
        add("args", format!("return Math.max({})", "1,".repeat(n)));
    }
    out
}

#[test]
fn hostile_programs_end_in_diagnostics() {
    let rt = runtime();
    let mut failures = Vec::new();
    for (i, code) in HOSTILE.iter().enumerate() {
        failures.extend(survives(&rt, &format!("hostile {i}"), code));
    }
    for (name, code) in generated() {
        failures.extend(survives(&rt, &name, &code));
    }
    report(failures);
}

/// Deeper than any value depth a runtime allows, shallow enough for the host's own clone and drop, which recurse.
const DEEP: usize = 1_000;

fn deep(n: usize, wrap: impl Fn(HostValue) -> HostValue) -> HostValue {
    let mut v = HostValue::Null;
    for _ in 0..n {
        v = wrap(v);
    }
    v
}

/// What a host might hand a program, made to be awkward.
fn hostile_values() -> Vec<(&'static str, HostValue)> {
    let lone = HostString::from_utf16(&[0xd800, 0x61, 0xdfff]);
    vec![
        ("nan", HostValue::Number(f64::NAN)),
        ("negzero", HostValue::Number(-0.0)),
        ("inf", HostValue::Number(f64::INFINITY)),
        ("lone", HostValue::String(lone.clone())),
        (
            "lone keys",
            HostValue::Object(vec![
                (lone.clone(), HostValue::Null),
                (lone.clone(), HostValue::Bool(true)),
                (HostString::from("__proto__"), HostValue::Number(1.0)),
                (HostString::from("constructor"), HostValue::Null),
                (HostString::from(""), HostValue::Null),
            ]),
        ),
        (
            "nan map",
            HostValue::Map(vec![
                (HostValue::Number(f64::NAN), HostValue::Number(1.0)),
                (HostValue::Number(f64::NAN), HostValue::Number(2.0)),
                (HostValue::Number(-0.0), HostValue::Number(3.0)),
                (HostValue::Number(0.0), HostValue::Number(4.0)),
                (HostValue::String(lone.clone()), HostValue::Undefined),
            ]),
        ),
        (
            "nan set",
            HostValue::Set(vec![
                HostValue::Number(f64::NAN),
                HostValue::Number(f64::NAN),
                HostValue::Set(vec![]),
            ]),
        ),
        (
            "holes",
            HostValue::Array(vec![None, None, Some(HostValue::Null), None]),
        ),
        ("deep array", deep(DEEP, |v| HostValue::array([v]))),
        ("deep object", deep(DEEP, |v| HostValue::object([("a", v)]))),
        (
            "deep map",
            deep(DEEP, |v| HostValue::Map(vec![(HostValue::Null, v)])),
        ),
        (
            "deep map keys",
            deep(DEEP, |v| HostValue::Map(vec![(v, HostValue::Null)])),
        ),
        ("deep set", deep(DEEP, |v| HostValue::Set(vec![v]))),
        (
            "deep error",
            deep(DEEP, |v| {
                HostValue::Error(Box::new(HostError::new("x").with_cause(v)))
            }),
        ),
        (
            "wide array",
            HostValue::array((0..200_000).map(|i| HostValue::Number(i as f64))),
        ),
        (
            "wide object",
            HostValue::object((0..50_000).map(|i| (format!("k{i}"), HostValue::Number(i as f64)))),
        ),
        ("date nan", HostValue::Date(f64::NAN)),
        ("date huge", HostValue::Date(1e300)),
        ("date edge", HostValue::Date(8.64e15 + 1.0)),
        (
            "regexp bad",
            HostValue::RegExp {
                source: HostString::from("("),
                flags: "gg".into(),
            },
        ),
        (
            "regexp flags",
            HostValue::RegExp {
                source: lone.clone(),
                flags: "\u{0}zq".into(),
            },
        ),
        ("url bad", HostValue::Url("not a url".into())),
        ("url empty", HostValue::Url(String::new())),
        (
            "params",
            HostValue::SearchParams(vec![("\u{0}".into(), "%".into())]),
        ),
        (
            "headers",
            HostValue::Headers(vec![("bad name\n".into(), "\r\nx".into())]),
        ),
        ("bytes", HostValue::Bytes(vec![0xff; 1 << 18])),
        ("buffer", HostValue::Buffer(vec![])),
        (
            "typed",
            HostValue::TypedArray(TypedArray::new(TypedKind::F64, vec![0xff; 64]).unwrap()),
        ),
        (
            "typed empty",
            HostValue::TypedArray(TypedArray::new(TypedKind::U32, vec![]).unwrap()),
        ),
        (
            "failure",
            HostValue::Failure(Failure::new("", lone.clone())),
        ),
        (
            "failure kind",
            HostValue::Failure(Failure::new("\u{0}\n", "m")),
        ),
        ("located", HostError::located(lone.clone(), lone.clone())),
        ("located empty", HostError::located("", "")),
        (
            "error fields",
            HostValue::Error(Box::new(
                HostError::named(lone.clone(), "m")
                    .with_field("stack", HostValue::Number(1.0))
                    .with_field("message", HostValue::Null)
                    .with_field(
                        "cause",
                        HostValue::Function(HostFunction::new(|_, _| HostValue::Null)),
                    ),
            )),
        ),
        ("marker", HostValue::FunctionMarker),
        ("interrupt", HostValue::Interrupt),
        (
            "nested functions",
            HostValue::array([HostValue::Function(
                HostFunction::new(|_, _| HostValue::Interrupt).named(""),
            )]),
        ),
    ]
}

/// The program's uses of a hostile value `v`.
const USES: &str = r#"
const out = []
const tries = [
  () => v, () => typeof v, () => String(v), () => JSON.stringify(v), () => [v].flat(Infinity),
  () => Object.keys(v), () => Object.entries(v), () => [...v], () => v + 1, () => v.toString(),
  () => v instanceof Error, () => v.message, () => v.stack, () => v.cause, () => v.get(NaN), () => v.has(NaN),
  () => v.size, () => v.length, () => v[0], () => v.href, () => v.source, () => v.flags, () => v.test('a'),
  () => v.getTime(), () => v.toISOString(), () => v.toLocaleString(), () => echo(v), () => console.log(v),
  () => structuredClone(v), () => new Map([[v, v]]).get(v), () => v(), () => new v(),
  () => { throw v }, () => Promise.reject(v), () => Array.from(v), () => v.byteLength, () => v.buffer,
]
for (const t of tries) {
  try { const r = t(); out.push(typeof r) } catch (e) { out.push('throws ' + (e && e.name)) }
}
return out
"#;

#[test]
fn hostile_host_values_end_in_diagnostics() {
    // The deep values' own clones and drops recurse, on a stack that holds them in a debug build too.
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(host_values)
        .unwrap()
        .join()
        .unwrap();
}

fn host_values() {
    let mut failures = Vec::new();
    for (name, value) in hostile_values() {
        let v = value.clone();
        let as_global = Runtime::make().limits(limits()).globals(move |_| {
            [
                ("v", v.clone()),
                (
                    "echo",
                    HostValue::Function(HostFunction::new(|args, _| {
                        args.into_iter().next().unwrap_or_default()
                    })),
                ),
            ]
        });
        failures.extend(survives(&as_global, &format!("{name} global"), USES));
        failures.extend(survives(&as_global, &format!("{name} result"), "return v"));
        let (ok, err) = (value.clone(), value.clone());
        let returned = Runtime::make().limits(limits()).globals(move |_| {
            let (ok, err, aok, aerr) = (ok.clone(), err.clone(), ok.clone(), err.clone());
            [
                (
                    "ok",
                    HostValue::Function(HostFunction::new(move |_, _| {
                        Ok::<_, HostValue>(ok.clone())
                    })),
                ),
                (
                    "err",
                    HostValue::Function(HostFunction::new(move |_, _| {
                        Err::<HostValue, _>(err.clone())
                    })),
                ),
                (
                    "aok",
                    HostValue::Function(HostFunction::new_async(move |_, _| {
                        let v = aok.clone();
                        async move { Ok(v) }
                    })),
                ),
                (
                    "aerr",
                    HostValue::Function(HostFunction::new_async(move |_, _| {
                        let v = aerr.clone();
                        async move { Err(v) }
                    })),
                ),
            ]
        });
        for code in [
            "return ok()",
            "return err()",
            "try { return err() } catch (e) { return [String(e), e.stack] }",
            "return await aok()",
            "return await aerr()",
            "try { await aerr() } catch (e) { return String(e) }",
            "const [a, b] = await Promise.allSettled([aok(), aerr()]); return [a, b]",
            "const v = ok(); return [String(v), JSON.stringify(v), [v].flat(Infinity).length]",
        ] {
            failures.extend(survives(&returned, name, code));
        }
    }
    report(failures);
}

#[test]
fn hostile_namespaces_and_durable_functions_end_in_diagnostics() {
    let lone = HostString::from_utf16(&[0xdc00]);
    let calls = Arc::new(Mutex::new(0usize));
    let counted = calls.clone();
    let mut failures = Vec::new();
    let rt = Runtime::make().limits(limits()).globals(move |_| {
        let lone = lone.clone();
        let counted = counted.clone();
        [
            (
                "ns",
                HostValue::Namespace(Namespace::new(
                    move |path| match path.len() {
                        0 => Ok(vec![lone.clone(), lone.clone(), HostString::from("")]),
                        1 => Err(HostValue::Failure(Failure::new("Odd", "keys fail"))),
                        2 => Err(HostValue::Interrupt),
                        3 => Ok((0..100_000)
                            .map(|i| HostString::from(format!("k{i}")))
                            .collect()),
                        _ => Err(HostValue::Number(f64::NAN)),
                    },
                    |path| -> psychoscript::Resolved {
                        match path.len() {
                            1 => Failure::missing("none").into(),
                            2 => {
                                HostFunction::new(|_, _| Err::<HostValue, _>(HostValue::Undefined))
                                    .into()
                            }
                            3 => HostFunction::new(|_, _| HostValue::Interrupt).into(),
                            _ => DurableFunction::new(
                                |_, _| async { Err(HostValue::Number(f64::NAN)) },
                                |_, _| async { Ok(HostValue::Null) },
                                |_, _| async {},
                            )
                            .into(),
                        }
                    },
                )),
            ),
            (
                "durable_fails_wait",
                HostValue::Durable(DurableFunction::new(
                    |_, _| async { Ok(psychoscript::Data::Null) },
                    |_, _| async { Err(HostValue::Error(Box::new(HostError::new("wait failed")))) },
                    |_, _| async {},
                )),
            ),
            (
                "durable_never",
                HostValue::Durable(DurableFunction::new(
                    |_, _| async { Ok(psychoscript::Data::Null) },
                    |_, _| std::future::pending::<psychoscript::HostResult>(),
                    move |_, _| {
                        *counted.lock().unwrap() += 1;
                        async {}
                    },
                )),
            ),
            (
                "never",
                HostValue::Function(HostFunction::new_async(|_, _| {
                    std::future::pending::<psychoscript::HostResult>()
                })),
            ),
            (
                "blocks_never",
                HostValue::Function(HostFunction::new(|_, _| {
                    psychoscript::Returned::Block(Box::pin(std::future::pending()))
                })),
            ),
        ]
    });
    for code in [
        "return Object.keys(ns)",
        "return Object.keys(ns.a)",
        "return Object.keys(ns.a.b)",
        "return Object.keys(ns.a.b.c).length",
        "return Object.keys(ns.a.b.c.d)",
        "for (const k in ns) {} return 1",
        "return JSON.stringify(ns)",
        "return String(ns) + typeof ns.a",
        "return ns.a()",
        "try { return ns.a.b() } catch (e) { return [String(e)] }",
        "return ns.a.b.c()",
        "return await ns.a.b.c.d()",
        "return [ns, ns.a]",
        "return echo(ns)",
        "return new ns.a()",
        "return await durable_fails_wait()",
        "return await durable_never()",
        "return await never()",
        "never(); return 1",
        "return blocks_never()",
        "return await Promise.race([never(), durable_never()])",
        "return await Promise.all(Array.from({ length: 10000 }, () => never()))",
    ] {
        failures.extend(survives(&rt, "namespace", code));
    }
    report(failures);
}

fn snapshot_of(rt: &Runtime, code: &str) -> Snapshot {
    let program = rt.program(code, &ProgramOptions::new());
    let suspender = program.suspender();
    let (outcome, _) = std::thread::scope(|s| {
        let h = s.spawn(move || suspender.suspend(None));
        (program.run_resumable().unwrap(), h.join().unwrap())
    });
    match outcome {
        psychoscript::RunOutcome::Suspended(s) => s.state,
        psychoscript::RunOutcome::Done(o) => {
            panic!("the run ended before its suspend: {:?}", o.result)
        }
    }
}

/// Every way to mutate one JSON value: a changed scalar, a dropped or repeated element, or another type.
fn mutate_json(rng: &mut Rng, j: &mut Json, depth: usize) {
    let descend = rng.below(4) != 0 && depth < 40;
    match j {
        Json::Array(a) if descend && !a.is_empty() => {
            let i = rng.below(a.len());
            mutate_json(rng, &mut a[i], depth + 1)
        }
        Json::Object(o) if descend && !o.is_empty() => {
            let i = rng.below(o.len());
            let k = o.keys().nth(i).cloned().unwrap();
            if let Some(v) = o.get_mut(&k) {
                mutate_json(rng, v, depth + 1)
            }
        }
        Json::Array(a) if !a.is_empty() && rng.below(2) == 0 => match rng.below(3) {
            0 => {
                let i = rng.below(a.len());
                a.remove(i);
            }
            1 => {
                let i = rng.below(a.len());
                let v = a[i].clone();
                a.insert(i, v);
            }
            _ => a.truncate(rng.below(a.len())),
        },
        Json::Object(o) if !o.is_empty() && rng.below(2) == 0 => {
            let k = o.keys().nth(rng.below(o.len())).cloned().unwrap();
            o.remove(&k);
        }
        _ => {
            *j = match rng.below(12) {
                0 => Json::Null,
                1 => Json::Bool(rng.below(2) == 0),
                2 => serde_json::json!(-1),
                3 => serde_json::json!(u64::MAX),
                4 => serde_json::json!(u32::MAX),
                5 => serde_json::json!(1.5),
                6 => serde_json::json!(rng.below(64)),
                7 => serde_json::json!(""),
                8 => serde_json::json!("\u{fffd}x"),
                9 => serde_json::json!([]),
                10 => serde_json::json!({}),
                _ => serde_json::json!(i64::MIN),
            }
        }
    }
}

#[test]
fn malformed_states_are_refused_or_resume_without_panicking() {
    let rt = runtime();
    let programs = [
        "let n = 0; const o = { a: [1, 'x', 2n, null], m: new Map([[1, {}]]), s: new Set([1]) }; o.self = o.a;\
         class C { q = 1; get p() { return this.q } }; const c = new C(); function* g() { yield 1; yield 2 }\
         const it = g(); it.next(); const re = /a(b)?/g; re.lastIndex = 1; const d = new Date(0); let p = later(1);\
         for (let i = 0; i < 3000000; i++) n = (n + i) % 1000003; return [n, o, c.p, it.next(), re.exec('ab'), d, await p]",
        "const e = new Error('x', { cause: [1] }); const a = Array(10); a[5] = { e }; let n = 0;\
         const f = (x) => () => x + n; const fs = [f(1), f(2)]; const w = { [Symbol.iterator]: 1 };\
         for (let i = 0; i < 3000000; i++) n = (n ^ i) & 0xffff; return [a, fs.map(g => g()), w[Symbol.iterator], String(e)]",
    ];
    let mut failures = Vec::new();
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let rounds: usize = std::env::var("HOSTILE_ROUNDS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(2)
        * 300;
    for code in programs {
        let state = snapshot_of(&rt, code);
        assert!(rt.resume(&state).is_ok());
        let bytes = psychoscript::to_bytes(&state);
        // Raw bytes: truncated and flipped.
        for round in 0..rounds / 4 {
            let mut b = bytes.clone();
            match round % 3 {
                0 => b.truncate(rng.below(b.len())),
                1 => {
                    let i = rng.below(b.len());
                    b[i] ^= 1 << rng.below(8);
                }
                _ => {
                    let i = rng.below(b.len());
                    b.insert(i, b"{}[],:\"0-e\\"[rng.below(11)]);
                }
            }
            failures.extend(resumes(&rt, &format!("bytes round {round}"), |rt| {
                rt.resume_bytes(&b)
            }));
        }
        // Valid JSON, wrong state: one value changed anywhere below the header.
        for round in 0..rounds {
            let mut s = state.0.clone();
            if let Some(state) = s.get_mut("state") {
                for _ in 0..1 + rng.below(3) {
                    mutate_json(&mut rng, state, 0);
                }
            }
            let changed = s != state.0;
            let s = Snapshot(s);
            // A changed state is refused before anything of it is read: its hash is in the header.
            if changed {
                let refused = rt.resume(&s).err().map(|e| e.message);
                assert_eq!(
                    refused.as_deref(),
                    Some("Invalid snapshot: its state does not match its hash."),
                    "state round {round}"
                );
            }
            failures.extend(resumes(&rt, &format!("state round {round}"), |rt| {
                rt.resume(&s)
            }));
        }
    }
    for bytes in [
        &b""[..],
        b"null",
        b"[]",
        b"{}",
        b"{\"format\":2}",
        b"{\"format\":2,\"header\":[]}",
    ] {
        failures.extend(resumes(&rt, "fixed", |rt| rt.resume_bytes(bytes)));
    }
    report(failures);
}

fn resumes<'r>(
    rt: &'r Runtime,
    label: &str,
    resume: impl FnOnce(&'r Runtime) -> Result<psychoscript::Program<'r>, psychoscript::SnapshotError>,
) -> Vec<(String, String)> {
    guarded(label, || {
        if let Ok(program) = resume(rt) {
            let _ = program.run_resumable();
        }
        false
    })
}
