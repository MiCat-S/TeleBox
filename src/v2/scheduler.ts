import type { CronJob } from "cron";
import type { ResourceScope } from "./lifecycle";

export interface ScheduledJob {
  cron: string;
  timeZone?: string;
  description: string;
}

interface SchedulerLogger {
  error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export class PluginScheduler {
  private readonly jobs = new Map<string, CronJob>();
  private readonly registering = new Set<string>();
  private cron?: Promise<typeof import("cron")>;
  private running = 0;

  constructor(private readonly logger: SchedulerLogger) {}

  async register(
    pluginId: string,
    id: string,
    spec: ScheduledJob,
    scope: ResourceScope,
    handler: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    scope.signal.throwIfAborted();
    const key = JSON.stringify([pluginId, id]);
    if (this.jobs.has(key) || this.registering.has(key)) {
      throw new Error("Scheduled job already registered");
    }
    this.registering.add(key);
    const createJob = async (signal: AbortSignal): Promise<() => Promise<void>> => {
      let cron: typeof import("cron");
      try {
        cron = await (this.cron ??= import("cron"));
      } catch {
        this.reportFailure("scheduler.load_failed");
        throw new Error("Cron scheduler could not load");
      }
      signal.throwIfAborted();
      let stopped = false;
      let running = false;
      const finish = (): void => {
        running = false;
        this.running -= 1;
      };
      let job: CronJob;
      try {
        job = cron.CronJob.from({
          cronTime: spec.cron,
          timeZone: spec.timeZone,
          start: false,
          runOnInit: false,
          // Our guard suppresses overlap while scope tracks actual settlement.
          // Cron's waitForCompletion stop path would add polling timers.
          waitForCompletion: false,
          onTick: () => {
            if (stopped || running || signal.aborted) return;
            running = true;
            this.running += 1;
            return scope.run("scheduler:callback", async (callbackSignal) => {
              try {
                await handler(callbackSignal);
              } finally {
                finish();
              }
            }).catch(() => {
              this.reportFailure("scheduler.callback_failed");
            });
          },
          errorHandler: () => this.reportFailure("scheduler.timer_failed"),
        });
      } catch {
        this.reportFailure("scheduler.registration_failed");
        throw new Error("Invalid scheduled job");
      }
      signal.throwIfAborted();
      this.jobs.set(key, job);
      const onAbort = (): void => { void dispose(); };
      const dispose = scope.add("scheduler:timer", () => {
        stopped = true;
        signal.removeEventListener("abort", onAbort);
        job.stop();
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
        job.start();
      } catch {
        await dispose();
        signal.throwIfAborted();
        this.reportFailure("scheduler.registration_failed");
        throw new Error("Scheduled job could not start");
      }
      return dispose;
    };
    return scope.run("scheduler:register", (signal) => createJob(signal).finally(() => {
      this.registering.delete(key);
    }));
  }

  snapshot(): { jobs: number; running: number } {
    return { jobs: this.jobs.size, running: this.running };
  }

  private reportFailure(event: string): void {
    try {
      // Neither configuration nor callback error payloads cross the log boundary.
      this.logger.error(event);
    } catch {
      // A failing logger must not escape a timer callback or retain its run slot.
    }
  }
}
