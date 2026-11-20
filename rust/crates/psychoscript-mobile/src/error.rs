use std::fmt;

use psychoscript::{Diagnostic, DiagnosticKind};

/// Why a program didn't compile or a run failed. `reason` is the message (Kotlin exceptions keep
/// `message` for a summary of every field), `kind` is the language's diagnostic kind
/// (`"ParseError"`, `"ExecutionFailure"`, ...); `line` and `column` are 1-based, in the source,
/// when known.
#[derive(Debug, PartialEq, Eq, uniffi::Error)]
pub enum PsychoScriptError {
    /// The source doesn't parse, or uses syntax the language doesn't support (`ParseError`,
    /// `UnsupportedSyntax`; the latter may surface only when the run reaches it).
    Syntax {
        kind: String,
        reason: String,
        line: Option<u32>,
        column: Option<u32>,
    },
    /// The run threw, or returned what isn't JSON data: `ExecutionFailure` (the message starts
    /// with the thrown error's name, as `TypeError: ...`), `InvalidDataValue`, or a host kind.
    Runtime {
        kind: String,
        reason: String,
        line: Option<u32>,
        column: Option<u32>,
    },
    /// The run went past `timeout_ms` of active time.
    Timeout { reason: String, timeout_ms: u64 },
    /// The result is over `max_output_bytes` of JSON.
    OutputTooLarge {
        reason: String,
        max_output_bytes: u64,
    },
    /// The input isn't JSON, or the options are invalid.
    InvalidInput { reason: String },
    /// A live run computed for more than `budget_ms` without waiting on its host (`receive`, `sleep`), and was
    /// stopped.
    SliceBudget { reason: String, budget_ms: u64 },
    /// A live run couldn't be paused (it's in a host call that can't be suspended, or its state can't be saved), or a
    /// snapshot couldn't be read back. The run is untouched.
    Snapshot { reason: String },
    /// A live run's method that its state doesn't allow: `resume` while running, `deliver` after it ended.
    InvalidState { reason: String },
}

impl PsychoScriptError {
    pub(crate) fn from_diagnostic(d: Diagnostic, timeout_ms: Option<u64>) -> PsychoScriptError {
        let kind = d.kind.name().to_owned();
        let reason = d.message_lossy();
        let (line, column) = d.location.map_or((None, None), |(l, c)| (Some(l), Some(c)));
        match d.kind {
            DiagnosticKind::TimeoutExceeded => PsychoScriptError::Timeout {
                reason,
                timeout_ms: timeout_ms.unwrap_or(0),
            },
            DiagnosticKind::ParseError | DiagnosticKind::UnsupportedSyntax => {
                PsychoScriptError::Syntax {
                    kind,
                    reason,
                    line,
                    column,
                }
            }
            _ => PsychoScriptError::Runtime {
                kind,
                reason,
                line,
                column,
            },
        }
    }

    /// The message, as the language gives it.
    pub fn reason(&self) -> &str {
        match self {
            PsychoScriptError::Syntax { reason, .. }
            | PsychoScriptError::Runtime { reason, .. }
            | PsychoScriptError::Timeout { reason, .. }
            | PsychoScriptError::OutputTooLarge { reason, .. }
            | PsychoScriptError::InvalidInput { reason }
            | PsychoScriptError::SliceBudget { reason, .. }
            | PsychoScriptError::Snapshot { reason }
            | PsychoScriptError::InvalidState { reason } => reason,
        }
    }
}

impl fmt::Display for PsychoScriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for PsychoScriptError {}
