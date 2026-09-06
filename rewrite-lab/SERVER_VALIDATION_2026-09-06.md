# Server Runtime Validation: 2026-09-06

## Result and Scope

The limited live check passed on the production Linux host with Node 24.15.0,
Teleproto 1.229.0 and better-sqlite3 13.0.2. The original PM2 service was restored.

The checker used the existing authorized Telegram session, six migrated modules,
and private copies of production configuration and assets. It sent eight silent
test commands to Saved Messages, explicitly dispatched the server-returned
messages through the V2 host, and read the edited results back from Telegram.
Only messages created by the checker were deleted; deletion was verified.

Verified paths:

- Existing-session connection and account identity verification.
- Loading `help`, `alias`, `prefix`, `loglevel`, `ids`, and `dc`.
- Help output, self identity lookup and self DC lookup.
- Alias persistence to the copied SQLite database, unload/reload, and execution.
- Logging-level persistence to the copied JSON file and unload/reload.
- Prefix persistence to the copied working directory and execution with the new prefix.
- Rejection of unowned and edited command envelopes.
- Event subscription registration, shutdown and listener disposal.
- Completed host, transport and logging cleanup, with zero pending tasks/resources.
- Normal process exit with code 0 and no resident TypeScript/esbuild/tsx compiler.

The event observer received zero own-message events. This check does not establish
the separate phone/desktop -> incoming Telegram update -> command execution path.
It also does not establish full compatibility of these six modules, the full 151
entrypoints, media transfers, delegated permissions, the remaining production
plugins, long-running behavior, or the resource acceptance in `REWRITE_PLAN.md`.
The standard V2 CLI still provides the offline check; this is a bounded validation
entrypoint, not a production service entrypoint. Migration acceptance counts are
unchanged.

## Backup and Restoration

Successful run directory on the server:

`/root/telebox-v2-validation/check-vXPyae`

- `backup.tar`: 424,017,920 bytes, mode 0600, in an owner-only directory.
- SHA-256: `cd30e5429481ee6a46b47022b77e15696a94ffb70a2287a57685553210207bf7`.
- `backup.sha256`: archive checksum record.
- `result.json`: sanitized live-check summary.
- `live.private.log`: stage diagnostics and resource samples, retained on the server.
- `pm2-before.private.json`: original PM2 state, including private environment data.
- `work/`: isolated configuration and asset copies used by the check.

The original account process tree stopped before the full `/root/telebox` archive
was created. Archive content comparison passed. After the checker exited, both
archive comparison and a complete NUL-delimited path-list comparison passed.
The latter detects added paths as well as changes to existing entries.

The supervising systemd oneshot had a 240-second start deadline and
`KillMode=control-group`. The live process additionally had a 90-second deadline
and a five-second forced-stop grace period. `ExecStopPost` restarted the existing
PM2 app on both failed attempts and successful completion; it did not restore
old data over the production directory.

Successful run times, Asia/Shanghai:

- Original process confirmed stopped: 01:18:54.
- Validation and original-directory comparison completed: 01:19:28.
- Restored original client authenticated: 01:19:30.131.
- Restored event handlers registered: 01:19:30.763.

Final production PID was 1468712, PM2 status online, and the error log was empty.
`config.json` and `assets/alias/alias.db` matched the cold backup byte for byte.
`.env` was absent in both the original archive and the restored production tree.
Backup contents and session credentials were not downloaded from the server.

## Compatibility Fix and Regression

Teleproto's wire decoder returns `null` for absent optional fields, while local
constructor fixtures commonly use `undefined`. The V2 envelope now recognizes
both as an absent `editDate`, preserving new-message command admission. Explicit
edit events and messages with an edit timestamp remain marked as edited.

The new binary encode/decode regression reproduced the admission failure before
the fix. The final unified V2 suite passed 771 tests, including the four validation
guard and diagnostic tests, with both V2 TypeScript projects checked first.

The validation archive builder disables macOS copyfile metadata. On Linux, the
generated package passes the unchanged strict plugin file/hash manifest checks.
The supervisor also performs artifact and native-module preflight before stopping
the original service.

## Resource Observation

For the six-module checker, five samples over 15.018 seconds showed:

- PSS: 105,847 to 107,543 KiB, approximately 103.4 to 105.0 MiB.
- RSS: 139,048 to 140,744 KiB, approximately 135.8 to 137.4 MiB.
- Process peak RSS: 141,744 KiB, approximately 138.4 MiB.
- CPU time during observation: 54,976 microseconds.
- Reported protocol and application errors: zero.

These are diagnostic measurements of this short, limited checker. They are not a
like-for-like comparison with the full production service and do not establish
minimum resource use or production acceptance.
