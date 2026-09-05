import {ResourceScope} from "./lifecycle";
import {JsonStore} from "./storage";
import type {PluginLogger} from "./sdk";

export enum LogLevel {DEBUG = 0, INFO = 1, WARNING = 2, ERROR = 3, SILENT = 4}
export type ProtocolLogLevel = "debug" | "info" | "warn" | "error" | "none";
type Fields = Readonly<Record<string, string | number | boolean>>;
type Config = Record<string, unknown> & {level: LogLevel};
export interface LogSink {write(level: Exclude<LogLevel, LogLevel.SILENT>, event: string, fields?: Fields): void;}

function validateLevel(level: unknown): asserts level is LogLevel {
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 4) {
    throw new Error("Invalid persisted logging level");
  }
}

/** Application-owned level state; the sink owns output and backpressure. */
export class RuntimeLogger implements PluginLogger {
  private level = LogLevel.INFO;
  private tail: Promise<void> = Promise.resolve();
  private readonly store: JsonStore<Config>;

  constructor(file: string, private readonly sink: LogSink, private readonly scope: ResourceScope) {
    this.store = new JsonStore(file, {level: LogLevel.INFO});
    scope.add("logger-storage", () => this.store.close());
  }

  private serialize(operation: (signal: AbortSignal) => Promise<void>, caller?: AbortSignal): Promise<void> {
    return this.scope.run("logger:configuration", signal => {
      const combined = caller ? AbortSignal.any([signal, caller]) : signal;
      const result = this.tail.then(() => {
        combined.throwIfAborted();
        return operation(combined);
      });
      this.tail = result.then(() => undefined, () => undefined);
      return result;
    });
  }

  initialize(caller?: AbortSignal): Promise<void> {
    return this.serialize(async signal => {
      const record = await this.store.read(signal);
      validateLevel(record.level);
      signal.throwIfAborted();
      this.level = record.level;
    }, caller);
  }

  setLevel(level: LogLevel, caller?: AbortSignal): Promise<void> {
    validateLevel(level);
    return this.serialize(async signal => {
      await this.store.update(current => ({...current, level}), signal);
      signal.throwIfAborted();
      this.level = level;
    }, caller);
  }

  getLevel(): LogLevel {return this.level;}
  getLevelName(): string {return LogLevel[this.level];}
  getProtocolLevel(): ProtocolLogLevel {
    return (["debug", "info", "warn", "error", "none"] as const)[this.level];
  }

  private emit(level: Exclude<LogLevel, LogLevel.SILENT>, event: string, fields?: Fields): void {
    if (!this.scope.signal.aborted && level >= this.level) this.sink.write(level, event, fields);
  }
  debug(event: string, fields?: Fields): void {this.emit(LogLevel.DEBUG, event, fields);}
  info(event: string, fields?: Fields): void {this.emit(LogLevel.INFO, event, fields);}
  warn(event: string, fields?: Fields): void {this.emit(LogLevel.WARNING, event, fields);}
  error(event: string, fields?: Fields): void {this.emit(LogLevel.ERROR, event, fields);}
}
