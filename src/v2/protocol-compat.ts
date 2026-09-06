/** Instance-owned compatibility for Teleproto 1.229.0; importing has no effects. */
export interface ProtocolLogEntry {
  message: string;
  error?: unknown;
}

export type ProtocolLogDecision = "pass" | "warn" | "suppress";

export interface ProtocolCompatibility {
  /** Feed only this client's logs, once, before runtime filtering/redaction. */
  handleLog(entry: ProtocolLogEntry): ProtocolLogDecision;
  /** Idempotent; call after draining client operations, before destroying it. */
  cleanup(): void;
}

type Timer = ReturnType<typeof setTimeout>;
interface Tracker {
  timer?: Timer;
  pollTimer?: Timer;
  pts: { clearSkippedUpdates(): void; setRequesting(value: boolean): void };
}
interface Internals {
  session: { dcId: number };
  invoke(request: unknown): Promise<unknown>;
  _media: { savePart(dcId: number, request: unknown, signal?: AbortSignal): Promise<unknown> };
  updateManager: {
    channels: Map<string, Tracker>;
    channelFailRetryTimers: Map<string, Timer>;
    channelFailTimeoutS: Map<string, number>;
    fetchChannelDifference(channelId: string, ...args: unknown[]): Promise<unknown>;
  };
}
interface Failure {
  first: number;
  count: number;
  brokenAt: number | null;
  breaks: number;
  loggedAt: number | null;
}
const owners = new WeakSet<object>();
const MAX_CHANNELS = 500;
const WINDOW = 30 * 60_000;
const BASE_COOLDOWN = 6 * 60 * 60_000;
const MAX_COOLDOWN = 72 * 60 * 60_000;
const LOG_INTERVAL = 5 * 60_000;

function cooldown(record: Failure): number {
  return Math.min(BASE_COOLDOWN * 2 ** Math.max(0, record.breaks - 1), MAX_COOLDOWN);
}

/** Does not guess IDs from unrelated large integers (timestamps/request IDs). */
function identify(entry: ProtocolLogEntry): { id?: string; fatal: boolean } | undefined {
  const error = entry.error instanceof Error ? `${entry.error.message} ${entry.error.stack ?? ""}` : "";
  const message = `${entry.message} ${error}`.replace(/\x1b\[[0-9;]*m/g, "");
  const fatal = /difference too long|channelDifferenceTooLong/.test(message)
    || (/Could not find a matching Constructor/.test(message) && /recover|fetchChannelDifference/.test(message));
  if (!fatal && !/PERSISTENT_TIMESTAMP_OUTDATED|HISTORY_GET_FAILED|ChannelInvalidError/.test(message)) return;
  const match = message.match(/(?:channel gap for |fetchChannelDifference |fetching difference for |Channel |getChannelDifference \(cid = |updates )(\d+)/);
  return { id: match?.[1], fatal };
}

/** Rejects duplicate ownership. No prototype/console patches or resident timers. */
export function installProtocolCompatibility(client: object): ProtocolCompatibility {
  if (owners.has(client)) throw new Error("Protocol compatibility already installed for client");
  const internal = client as Internals;
  const media = internal._media;
  const manager = internal.updateManager;
  if (!media || typeof media.savePart !== "function" || !manager
    || typeof manager.fetchChannelDifference !== "function"
    || !(manager.channels instanceof Map) || !(manager.channelFailRetryTimers instanceof Map)
    || !(manager.channelFailTimeoutS instanceof Map)) {
    throw new Error("Unsupported Teleproto protocol internals");
  }
  const records = new Map<string, Failure>();
  let unknownLoggedAt: number | null = null;
  let active = true;

  function clear(id: string): void {
    const tracker = manager.channels.get(id);
    if (tracker) {
      clearTimeout(tracker.timer);
      clearTimeout(tracker.pollTimer);
      tracker.timer = undefined;
      tracker.pollTimer = undefined;
      tracker.pts.clearSkippedUpdates();
      tracker.pts.setRequesting(false);
      manager.channels.delete(id);
    }
    clearTimeout(manager.channelFailRetryTimers.get(id));
    manager.channelFailRetryTimers.delete(id);
    manager.channelFailTimeoutS.delete(id);
  }
  function broken(record: Failure | undefined, now: number): boolean {
    return record !== undefined && record.brokenAt !== null && now - record.brokenAt < cooldown(record);
  }
  const originalSave = media.savePart;
  const originalFetch = manager.fetchChannelDifference;
  const saveDescriptor = Object.getOwnPropertyDescriptor(media, "savePart");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(manager, "fetchChannelDifference");
  const save: typeof originalSave = async function (this: Internals["_media"], dcId, request, signal) {
    if (!active || dcId !== internal.session.dcId) return originalSave.call(this, dcId, request, signal);
    if (signal?.aborted) throw new Error("Media operation aborted");
    return internal.invoke(request);
  };
  const fetch: typeof originalFetch = async function (this: Internals["updateManager"], id, ...args) {
    if (!active) return originalFetch.call(this, id, ...args);
    if (broken(records.get(id), Date.now())) { clear(id); return; }
    // Keep the existing bounded record alive locally across eviction while awaiting RPC.
    const record = records.get(id);
    try { return await originalFetch.call(this, id, ...args); }
    finally {
      if (active && (broken(records.get(id), Date.now()) || broken(record, Date.now()))) clear(id);
    }
  };
  function restore(target: object, key: string, wrapper: unknown, descriptor?: PropertyDescriptor): void {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  try {
    Object.defineProperty(media, "savePart", { value: save, configurable: true, writable: true, enumerable: saveDescriptor?.enumerable ?? false });
    Object.defineProperty(manager, "fetchChannelDifference", { value: fetch, configurable: true, writable: true, enumerable: fetchDescriptor?.enumerable ?? false });
  } catch (error) {
    restore(media, "savePart", save, saveDescriptor);
    throw error;
  }
  owners.add(client);
  return {
    handleLog(entry) {
      if (!active) return "pass";
      const failure = identify(entry);
      if (!failure) return "pass";
      const now = Date.now();
      if (!failure.id) {
        if (unknownLoggedAt !== null && now - unknownLoggedAt < LOG_INTERVAL) return "suppress";
        unknownLoggedAt = now;
        return "warn";
      }
      const id = failure.id;
      let record = records.get(id);
      if (!record) {
        if (records.size >= MAX_CHANNELS) records.delete(records.keys().next().value!);
        record = { first: now, count: 0, brokenAt: null, breaks: 0, loggedAt: null };
        records.set(id, record);
      }
      if (broken(record, now)) { clear(id); return "suppress"; }
      if (record.brokenAt !== null || now - record.first >= WINDOW) {
        record.count = 0;
        record.first = now;
        record.brokenAt = null;
      }
      record.count += 1;
      if (failure.fatal || record.count >= 2) {
        record.breaks = Math.min(record.breaks + 1, 5);
        record.brokenAt = now;
        record.count = 0;
        clear(id);
        return "suppress";
      }
      if (record.loggedAt !== null && now - record.loggedAt < LOG_INTERVAL) return "suppress";
      record.loggedAt = now;
      return "warn";
    },
    cleanup() {
      if (!active) return;
      active = false;
      records.clear();
      unknownLoggedAt = null;
      restore(manager, "fetchChannelDifference", fetch, fetchDescriptor);
      restore(media, "savePart", save, saveDescriptor);
      owners.delete(client);
    },
  };
}
