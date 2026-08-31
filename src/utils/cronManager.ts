import { CronJob, validateCronExpression } from "cron";
import type { GenerationContext } from "./generationContext";

type CronHandler = () => void | Promise<void>;

interface CronTask {
  cron: string;
  description?: string;
  job: CronJob | null;
  running: number;
  executionsStarted: number;
  executionsFinished: number;
  overlapWarningLogged: boolean;
}

class CronManager {
  private tasks: Map<string, CronTask> = new Map();

  set(
    name: string,
    cron: string,
    handler: CronHandler,
    context?: GenerationContext
  ): () => void {
    if (this.tasks.has(name)) {
      console.warn(
        `[CRON] Cron task "${name}" already exists; keeping the existing task.`,
      );
      return () => undefined;
    }

    const validate = validateCronExpression(cron)
    if (!validate.valid) {
      console.log(`CronManager set new cronJob ${name} error while invalid cron`, validate.error);
      return () => undefined;
    }

    let job: CronJob;
    const taskState: CronTask = {
      cron,
      job: null,
      running: 0,
      executionsStarted: 0,
      executionsFinished: 0,
      overlapWarningLogged: false,
    };

    job = new CronJob(cron, () => {
      if (context?.signal.aborted) return;
      if (taskState.running > 0) {
        if (!taskState.overlapWarningLogged) {
          taskState.overlapWarningLogged = true;
          console.warn(`[CRON] Cron task "${name}" is still running; skipping overlapping execution.`);
        }
        return;
      }
      taskState.running += 1;
      taskState.executionsStarted += 1;
      const task = Promise.resolve().then(handler).finally(() => {
        taskState.running = Math.max(0, taskState.running - 1);
        taskState.executionsFinished += 1;
        taskState.overlapWarningLogged = false;
      });
      if (context) {
        context.trackTask(task, { label: `cron:${name}:execution` });
        task.catch(console.error);
      } else {
        task.catch(console.error);
      }
    });

    taskState.job = job;
    job.start();
    this.tasks.set(name, taskState);
    const stopCronTask = (): void => {
      this.del(name);
    };
    const dispose = context?.trackDisposable(stopCronTask, {
      label: `cron:${name}:job`,
    }) ?? stopCronTask;
    return dispose;
  }

  del(name: string): boolean {
    const task = this.tasks.get(name);
    if (!task) return false;
    if (task.job) {
      task.job.stop();
    }
    this.tasks.delete(name);
    return true;
  }

  ls(raw?: boolean): string[] | Map<string, CronTask> {
    if (raw) {
      return this.tasks;
    }
    return Array.from(this.tasks.keys());
  }

  clear(): void {
    for (const task of this.tasks.values()) {
      if (task.job) {
        task.job.stop();
      }
    }
    this.tasks.clear();
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }
}

const cronManager = new CronManager();

export { cronManager };
