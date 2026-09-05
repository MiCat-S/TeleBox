import type { ResourceScope } from "./lifecycle";

export type SettingsFieldType =
  | "string" | "number" | "boolean" | "select" | "textarea" | "json"
  | "password" | "provider-list" | "prompt-map" | "tag-list";

/** Public UI metadata must not contain credentials or other private values. */
export interface SettingsField {
  key: string;
  label: string;
  type: SettingsFieldType;
  description?: string;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
  default?: unknown;
  secret?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  providerColumns?: string;
  providerAddLabel?: string;
  promptKeyPlaceholder?: string;
  promptValuePlaceholder?: string;
  tagPlaceholder?: string;
  tagAllowDuplicates?: boolean;
}

export interface SettingsAdapter {
  id?: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  getSchema(signal: AbortSignal): readonly SettingsField[] | Promise<readonly SettingsField[]>;
  /** Return actual values; the registry supplies the public redaction boundary. */
  getValues(signal: AbortSignal): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Merge only supplied fields. Persistence and atomic updates belong to the adapter. */
  setValues(patch: Record<string, unknown>, signal: AbortSignal): void | Promise<void>;
}

export interface SettingsSummary {
  pluginId: string;
  id: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
}

export interface SettingsReadResult {
  values: Record<string, unknown>;
  /** Whether each secret field has a nonempty value, not per-provider key status. */
  secretSet: Record<string, boolean>;
}

export type SettingsErrorCode =
  | "unavailable" | "duplicate" | "invalid_adapter" | "invalid_schema"
  | "invalid_patch" | "adapter_failed";

const messages: Record<SettingsErrorCode, string> = {
  unavailable: "Settings are unavailable",
  duplicate: "Settings already registered",
  invalid_adapter: "Invalid settings adapter",
  invalid_schema: "Invalid settings schema",
  invalid_patch: "Invalid settings patch",
  adapter_failed: "Settings adapter failed",
};

export class SettingsError extends Error {
  constructor(readonly code: SettingsErrorCode) {
    super(messages[code]);
    this.name = "SettingsError";
  }
}

function safeError(error: unknown, fallback: SettingsErrorCode): SettingsError {
  try {
    if (error instanceof SettingsError) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (typeof code === "string" && Object.hasOwn(messages, code)) return new SettingsError(code as SettingsErrorCode);
    }
  } catch {
    // Exception objects and proxies are also untrusted boundary data.
  }
  return new SettingsError(fallback);
}

interface Slot {
  scope: ResourceScope;
  summary: SettingsSummary;
  adapter?: SettingsAdapter;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const fieldTypes = new Set<SettingsFieldType>([
  "string", "number", "boolean", "select", "textarea", "json",
  "password", "provider-list", "prompt-map", "tag-list",
]);
const textMetadata = [
  "description", "placeholder", "providerColumns", "providerAddLabel",
  "promptKeyPlaceholder", "promptValuePlaceholder", "tagPlaceholder",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function own(record: object, key: string, code: SettingsErrorCode): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new SettingsError(code);
  return descriptor.value;
}

/** Accept inert JSON data only, with a maximum nesting depth of 64. */
function copyData(value: unknown, code: SettingsErrorCode, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || depth > 64 || ancestors.has(value)) throw new SettingsError(code);
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isRecord(value)) throw new SettingsError(code);
  ancestors.add(value);
  try {
    if (array) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new SettingsError(code);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(copyData(own(value, String(index), code), code, depth + 1, ancestors));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || forbiddenKeys.has(key)) throw new SettingsError(code);
      result[key] = copyData(own(value, key, code), code, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeSchema(raw: unknown): SettingsField[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
    Reflect.ownKeys(raw).length !== raw.length + 1) throw new SettingsError("invalid_schema");
  const seen = new Set<string>();
  return Array.from({ length: raw.length }, (_, index) => {
    const item = own(raw, String(index), "invalid_schema");
    const fail = (): never => { throw new SettingsError("invalid_schema"); };
    if (!isRecord(item)) return fail();
    const get = (key: string): unknown => own(item, key, "invalid_schema");
    const key = get("key"), label = get("label"), type = get("type");
    if (typeof key !== "string" || !key || forbiddenKeys.has(key) || seen.has(key) ||
      typeof label !== "string" || typeof type !== "string" || !fieldTypes.has(type as SettingsFieldType)) return fail();
    seen.add(key);
    const field: SettingsField = { key, label, type: type as SettingsFieldType };
    for (const name of textMetadata) {
      const value = get(name);
      if (value !== undefined) {
        if (typeof value !== "string") return fail();
        field[name] = value;
      }
    }
    for (const name of ["secret", "required", "tagAllowDuplicates"] as const) {
      const value = get(name);
      if (value !== undefined) {
        if (typeof value !== "boolean") return fail();
        field[name] = value;
      }
    }
    if (type === "password" || type === "provider-list") field.secret = true;
    for (const name of ["min", "max"] as const) {
      const value = get(name);
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value)) return fail();
        field[name] = value;
      }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) return fail();
    const options = get("options");
    if (options !== undefined) {
      const copied = copyData(options, "invalid_schema");
      if (!Array.isArray(copied)) return fail();
      field.options = copied.map((option: unknown) => {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") return fail();
        return { value: option.value, label: option.label };
      });
    }
    if (type === "select" && (!field.options || field.options.length === 0)) return fail();
    // Secret defaults never cross the public schema boundary or fill in a patch.
    if (!field.secret) {
      const value = get("default");
      if (value !== undefined) field.default = copyData(value, "invalid_schema");
    }
    return field;
  });
}

function publicSchema(fields: SettingsField[]): SettingsField[] {
  return fields.map((field) => {
    if (!field.secret) return field;
    const { options: _options, ...publicField } = field;
    return publicField;
  });
}

function parseData(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return copyData(JSON.parse(value), "invalid_patch");
  } catch {
    throw new SettingsError("invalid_patch");
  }
}

/** Validate supplied fields only. min/max constrain numbers or text/container size. */
function validateValue(field: SettingsField, value: unknown): void {
  const fail = (): never => { throw new SettingsError("invalid_patch"); };
  let semantic = value;
  switch (field.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail();
      break;
    case "boolean":
      if (typeof value !== "boolean") fail();
      break;
    case "json":
      semantic = parseData(value);
      break;
    case "prompt-map":
      semantic = parseData(value);
      if (!isRecord(semantic) || Object.values(semantic).some((entry) => typeof entry !== "string")) fail();
      break;
    case "tag-list": {
      semantic = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : value;
      if (!Array.isArray(semantic) || semantic.some((tag) => typeof tag !== "string" || tag.trim() === "")) fail();
      if (!field.tagAllowDuplicates && new Set(semantic as string[]).size !== (semantic as string[]).length) fail();
      break;
    }
    default:
      if (typeof value !== "string") fail();
  }
  if (field.options && !field.options.some((option) => option.value === value)) fail();
  const size = typeof semantic === "number" ? semantic :
    typeof semantic === "string" || Array.isArray(semantic) ? semantic.length :
      isRecord(semantic) ? Object.keys(semantic).length : undefined;
  if (field.required && (semantic === null || (typeof semantic === "string" && semantic.trim() === "") ||
    (typeof semantic === "object" && size === 0))) fail();
  if (size !== undefined && ((field.min !== undefined && size < field.min) || (field.max !== undefined && size > field.max))) fail();
}

function secretSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * One live adapter per plugin. Registration/listing never invoke adapter callbacks.
 * Provider lists are whole-field write-only secrets; row edits/key merging belong
 * to the adapter. JSON/prompt-map JSON text and whitespace-separated tag text are
 * validated as data and passed through in their original wire representation.
 */
export class SettingsRegistry {
  private readonly slots = new Map<string, Slot>();

  register(pluginId: string, adapter: SettingsAdapter, scope: ResourceScope): () => Promise<void> {
    try {
      if (scope.signal.aborted) throw new SettingsError("unavailable");
      if (typeof pluginId !== "string" || !pluginId || !isRecord(adapter)) throw new SettingsError("invalid_adapter");
      const get = (key: string): unknown => own(adapter, key, "invalid_adapter");
      const title = get("title"), id = get("id") ?? pluginId;
      const getSchema = get("getSchema"), getValues = get("getValues"), setValues = get("setValues");
      if (typeof title !== "string" || typeof id !== "string" || !id || typeof getSchema !== "function" ||
        typeof getValues !== "function" || typeof setValues !== "function") throw new SettingsError("invalid_adapter");
      if (this.slots.has(pluginId)) throw new SettingsError("duplicate");
      const summary: SettingsSummary = { pluginId, id, title };
      for (const name of ["description", "category", "icon"] as const) {
        const value = get(name);
        if (value !== undefined) {
          if (typeof value !== "string") throw new SettingsError("invalid_adapter");
          summary[name] = value;
        }
      }
      const slot: Slot = { scope, summary, adapter: {
        title,
        getSchema: getSchema.bind(adapter),
        getValues: getValues.bind(adapter),
        setValues: setValues.bind(adapter),
      } };
      if (scope.signal.aborted) throw new SettingsError("unavailable");
      this.slots.set(pluginId, slot);
      const onAbort = (): void => { void dispose(); };
      const dispose = scope.add("settings:registration", () => {
        scope.signal.removeEventListener("abort", onAbort);
        slot.adapter = undefined;
        if (this.slots.get(pluginId) === slot) this.slots.delete(pluginId);
      });
      scope.signal.addEventListener("abort", onAbort, { once: true });
      return dispose;
    } catch (error) {
      throw safeError(error, "invalid_adapter");
    }
  }

  list(): Promise<SettingsSummary[]> {
    return Promise.all([...this.slots.values()].map((slot) => this.withSlot(slot, "list", async () => ({ ...slot.summary }))));
  }

  schema(pluginId: string): Promise<SettingsField[]> {
    return this.withSlot(this.slots.get(pluginId), "schema", async (adapter, signal, check) => {
      const fields = normalizeSchema(await this.invoke(() => adapter.getSchema(signal)));
      check();
      return publicSchema(fields);
    });
  }

  read(pluginId: string): Promise<SettingsReadResult> {
    return this.withSlot(this.slots.get(pluginId), "read", async (adapter, signal, check) => {
      const fields = normalizeSchema(await this.invoke(() => adapter.getSchema(signal)));
      check();
      const raw = await this.invoke(() => adapter.getValues(signal));
      check();
      if (!isRecord(raw)) throw new SettingsError("adapter_failed");
      const result: SettingsReadResult = { values: {}, secretSet: {} };
      for (const field of fields) {
        const value = own(raw, field.key, "adapter_failed");
        if (field.secret) result.secretSet[field.key] = secretSet(value);
        else if (value !== undefined) result.values[field.key] = copyData(value, "adapter_failed");
      }
      return result;
    });
  }

  patch(pluginId: string, patch: unknown): Promise<void> {
    return this.withSlot(this.slots.get(pluginId), "patch", async (adapter, signal, check) => {
      if (!isRecord(patch)) throw new SettingsError("invalid_patch");
      // Snapshot before awaiting schema so caller mutation cannot bypass validation.
      const clean = copyData(patch, "invalid_patch") as Record<string, unknown>;
      const fields = normalizeSchema(await this.invoke(() => adapter.getSchema(signal)));
      check();
      const byKey = new Map(fields.map((field) => [field.key, field]));
      for (const [key, value] of Object.entries(clean)) {
        const field = byKey.get(key);
        if (!field) throw new SettingsError("invalid_patch");
        validateValue(field, value);
      }
      check();
      if (Object.keys(clean).length > 0) await this.invoke(() => adapter.setValues(clean, signal));
    });
  }

  private withSlot<T>(
    slot: Slot | undefined,
    operation: string,
    fn: (adapter: SettingsAdapter, signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    if (!slot || !slot.adapter || slot.scope.signal.aborted) return Promise.reject(new SettingsError("unavailable"));
    return slot.scope.run(`settings:${operation}`, async (signal) => {
      const check = (): void => {
        if (!slot.adapter || signal.aborted || this.slots.get(slot.summary.pluginId) !== slot) {
          throw new SettingsError("unavailable");
        }
      };
      try {
        check();
        const result = await fn(slot.adapter!, signal, check);
        check();
        return result;
      } catch (error) {
        throw safeError(error, "adapter_failed");
      }
    });
  }

  private async invoke<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new SettingsError("adapter_failed");
    }
  }
}
