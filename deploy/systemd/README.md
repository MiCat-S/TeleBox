# TeleBox v2 systemd service template

## Status and activation gates

`telebox-v2.service` is a SERVICE TEMPLATE ONLY. The initial
`dist/v2/index.js` CLI is OFFLINE ONLY, not the migrated Telegram service.
Do NOT install, enable, or start this unit until authorized real-login tests
and the full migration gates in `rewrite-lab/REWRITE_PLAN.md` pass. A successful
offline run or build does not establish production readiness.

Activation requires full module/permission/configuration compatibility checks,
real Telegram critical-path evidence, lifecycle cleanup and fault-recovery tests,
data migration/rollback drills, and the plan's measured resource acceptance.
Production account access and service switching require separate operator approval.
Keep the existing program, data, and PM2/service deployment available for rollback.
Old and new instances of the same account must not run concurrently. A rollback
must retain data written since the switch rather than overwrite it with a snapshot.

## Precompiled artifacts

Run from the repository root with Node 24 and the existing dependencies installed:

```sh
node scripts/test-v2.cjs
node scripts/build-v2.cjs
node dist/v2/index.js --check
```

The final command invokes the application's initial offline CLI. Its eventual
service entrypoint must satisfy the activation gates above. The default production
build excludes `*.test.ts`; `--test` includes them at every directory depth.
The test runner checks both v2 TypeScript projects and includes nested Core tests,
build-chain tests, and `*-v2.test.js` / `*-v2-<component>.test.js` extension tests from
the sibling `TeleBox-Plugins` checkout on the matching `codex/telebox-runtime-v2`
branch. Declaration files (`*.d.ts`) are typecheck inputs, not executable
outputs. Other static assets are not copied by this TypeScript-only build.

The build launches the installed esbuild CLI as a short-lived process, emits
CommonJS ES2022 JavaScript with the source directory layout intact, and leaves
package imports external. Deploy compatible runtime dependencies alongside the
artifact, including Teleproto and platform/Node-compatible native libraries.
Production starts with plain Node: no TypeScript loader, esbuild runtime hook,
source maps, or modified compiler helpers. Source imports must resolve from the
emitted layout, using Node-compatible package names. Static CommonJS imports may
use extensionless local paths; dynamic `import()` requires emitted `.js` paths.
TS-only aliases and `.ts` runtime specifiers are unsupported.

esbuild transpiles syntax; the separate strict `noEmit` typecheck is a required
validation gate, not a guarantee provided by the build command. It uses only
the v2 entry set and does not extend the legacy TypeScript configuration.

Every build writes a sibling `dist/.v2-stage-*` directory. Compiler failure removes
the staging directory and leaves the current artifact intact. Successful builds
replace the complete output tree, so deleted sources and previous test outputs do
not persist. Promotion temporarily retains the previous tree in
`dist/.v2-backup-*/artifact`; a failed promotion restores it. If restoration also
fails, the error identifies the retained artifact for operator recovery.
Directory replacement uses two renames, not a crash-atomic exchange. Serialize
builds and perform replacement in an inactive release directory, not underneath a
running process that may load more modules. Host/process interruption during
promotion requires inspection of the retained sibling directories before retrying.
The build does not install or restart any service.

Build-chain tests are independent of the concurrently developed v2 application:

```sh
node --test scripts/build-v2.test.cjs
```

The exported `build({ rootDir, includeTests })` supports temporary fixture roots.
Both directories remain fixed at `src/v2` and `dist/v2` within that root; source
and output directory components and source-tree entries must not be symlinks.
The root itself is canonicalized to support normal OS temporary-directory aliases.

## Operator verification

Before any separately approved deployment, verify:

- `/root/telebox` is the intended checkout/release and working directory, and
  `/root/telebox/dist/v2/index.js` is the accepted production entrypoint.
- `/usr/bin/node` actually resolves to the intended Node 24 runtime. Adjust the
  template to the verified absolute executable; interactive shell/nvm settings
  are not automatically available to systemd.
- The eventual service user/group and filesystem ownership. This template omits
  `User=`/`Group=` and would run as root as a system unit; `/root/telebox` is not a
  suitable deployment path for an unprivileged account without a path redesign.
- Session, JSON/SQLite, plugin, temporary-file and backup paths, environment and
  secret-loading conventions, native modules, and helper executable paths. Confirm
  write access and data compatibility without changing the old service.
- Any eventual unit destination, commonly `/etc/systemd/system/telebox-v2.service`,
  is distinct from the old service and has no conflicting account ownership.
- The target host's systemd version accepts the template, using
  `systemd-analyze verify deploy/systemd/telebox-v2.service` on that host without
  installing it. Verify journal retention capacity and access policy separately;
  this unit routes logs to journald but does not set its global retention limits.

## Stop, restart, and future switching

`Restart=on-failure` restarts failures after five seconds, with a three-start
limit per minute. A successful offline CLI exit does not create a restart loop.
An explicit systemd stop is not a failure restart request.

On stop, systemd sends `SIGTERM` to the entire control group. The application must
handle that signal and explicitly cancel/drain work, close listeners, timers,
connections and stores, and wait for managed subprocesses to exit. Children also
receive the signal and must tolerate coordinated cleanup. `TimeoutStopSec=60s`
is the proposed outer deadline, to be verified against the application's bounded
cleanup budget. At the deadline, remaining group processes may receive `SIGKILL`.
That final safety mechanism does not replace application cleanup. A normal
systemd restart completes the stop phase before starting the next process.

Cross-restart updating and TeleBox/Next version switching eventually require a
separate oneshot controller unit outside this service's control group. That unit
and its authorization, target identity/native-plugin/data checks, rollback, and
completion reporting are pending migration work. This template does not implement
them. Do not use detached children or weaken `KillMode=control-group` to keep an
updater alive across a restart.
