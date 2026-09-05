# TeleBox V2 Runtime

## Delivery Status

The runtime targets TypeScript compiled ahead of time for Node.js 24. The current
CLI runs an isolated offline integration check. It is not an authenticated
Telegram application and is not ready for service activation.

The full migration scope and acceptance requirements are in
`rewrite-lab/REWRITE_PLAN.md`. `rewrite-lab/migrations.json` records each migrated
entrypoint's evidence and remaining work. Run `node rewrite-lab/migration-status.cjs`
for all 151 entries, including planned entries and archived extensions.

## Validation

Use Node.js 24 with the installed native dependencies matching its ABI. From the
Core checkout, with `TeleBox-Plugins` checked out alongside it:

```sh
node scripts/test-v2.cjs
node scripts/build-v2.cjs
node dist/v2/index.js --check
```

The test runner first checks both v2 TypeScript projects, then compiles and runs
Core, build-chain, and migrated extension tests. The production build excludes
test sources. The offline check uses temporary storage and a fake transport;
it exercises help, aliases, SQLite persistence across reload, service calls,
command admission, and complete shutdown. It does not read account configuration,
log in, contact providers, or load installed user plugins.

## Runtime Boundaries

- `PluginHost` owns plugin generations, command dispatch, settings and service
  registration. Normal command execution has a bounded, per-chat ordered queue.
- `ResourceScope` retains tasks and cleanups until they actually settle. A drain
  deadline reports unfinished work; it never releases their resource ownership.
- JSON updates are serialized and atomically renamed. Existing JSON documents
  remain authoritative, and unsafe integer literals retain exact bigint values.
  SQLite operations use a connection for each serialized operation and release
  it afterward. Neither backend keeps an idle database connection open.
- HTTP response lifetimes include body consumption and cancellation cleanup.
  Native helper processes share a global concurrency and queue budget and are
  stopped as process groups on supported POSIX systems.
- `TeleprotoPort` binds an already-authenticated client. It does not create or
  disconnect an account. Protocol event subscriptions belong to a scope.
- `PluginReleases` checks immutable artifact hashes, stops the owned generation,
  activates its replacement and commits the selection. Failure can recreate the
  prior code while retaining current business data. Unfinished or failed cleanup
  prevents another generation from starting. Management runs outside the plugin
  handler being replaced; a task may not wait for its own scope to drain.

Storage and release directories must be application-owned. JSON selection files
require a single process writer. Cross-process account/deployment locks and
crash-safe deployment orchestration are separate, pending work.

## Plugin Packages

Every package exports a synchronous, side-effect-free default factory. It returns
a `definePlugin` declaration using `telebox/sdk`. Importing code and creating the
declaration must not start timers, processes, listeners, network requests or
database writes. Resource acquisition belongs in tracked setup or handlers.

```ts
import {definePlugin} from "telebox/sdk";

export default function createExample() {
  return definePlugin({
    apiVersion: 1,
    id: "example",
    description: "Example command",
    commands: {
      example: {
        description: "Reply with literal text",
        async handle({message}, context) {
          await context.telegram.edit(message, "Ready");
        },
      },
    },
  });
}
```

`context.telegram` emits literal text unless `parseMode` is supplied. Native
operations use `withClient` and must await all their work inside its callback.
Service handlers must honor their call signal as well as their plugin lifecycle.
`context.files.withTemp` keeps files until its callback actually settles, including
after cancellation. It is not safe to start detached work that outlives a callback.

Build a candidate without activating it:

```sh
node scripts/build-v2-plugin.cjs ip ../TeleBox-Plugins/ip v2.ts
```

Own helper modules are bundled; dependencies remain external. Assets must be
explicit build arguments and are included in the integrity manifest. The output
is `dist/v2-plugins/<id>/<revision>/`. `inspectArtifact` does not execute code.
`prepareArtifact` executes trusted CJS module top level, and `create` evaluates
its factory. These are not sandboxes or proof of code authenticity. Release the
handle only after every instance created from it is fully unloaded. Own CJS/JSON
cache entries are released; shared dependencies and native modules remain cached.

## Remaining Integration

Authenticated startup, legacy environment/configuration mapping, main-DC upload
and channel-gap compatibility, sudo/sure routing, full built-ins and extensions,
panel authentication/UI, warm media workers, account exclusivity, and deployment
controllers are not yet a complete integrated application.

Provider tests use fake fetch and Telegram tests use fake clients. No full-catalog
live parity result, 24-hour stress result, or same-host PSS/CPU/latency acceptance
has been established. Lifecycle and reload tests alone do not establish the
plan's resource-reduction target. Keep the existing service running until those
gates and separately authorized deployment checks pass.
