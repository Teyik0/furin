import type { SyncAdapter, SyncNotifier, SyncSubscription } from "./adapter.ts";

interface ListenerSubscription {
  listener: (cursor: string) => void;
}

export class PollingSyncNotifier implements SyncNotifier {
  readonly recovery = "self" as const;
  private readonly adapter: SyncAdapter;
  private readonly intervalMs: number;
  private readonly listeners = new Set<ListenerSubscription>();
  private cursor: string | undefined;
  private initialization: Promise<void> | undefined;
  private polling: Promise<void> | undefined;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(adapter: SyncAdapter, intervalMs: number) {
    this.adapter = adapter;
    this.intervalMs = intervalMs;
  }

  publish(cursor: string): Promise<void> {
    this.revision += 1;
    this.emit(cursor);
    return Promise.resolve();
  }

  async subscribe(listener: (cursor: string) => void): Promise<SyncSubscription> {
    const subscription = { listener };
    this.listeners.add(subscription);
    try {
      await this.start();
    } catch (error) {
      this.listeners.delete(subscription);
      throw error;
    }
    return {
      unsubscribe: () => {
        this.listeners.delete(subscription);
        if (this.listeners.size === 0 && this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        return Promise.resolve();
      },
    };
  }

  private emit(cursor: string): void {
    if (cursor === this.cursor) {
      return;
    }
    this.cursor = cursor;
    for (const subscription of [...this.listeners]) {
      try {
        subscription.listener(cursor);
      } catch {
        // Notifications are best-effort wake-ups; durable recovery reads the change log.
      }
    }
  }

  private async poll(): Promise<void> {
    const { revision } = this;
    try {
      const cursor = await this.adapter.currentCursor();
      if (revision === this.revision && this.listeners.size > 0) {
        this.emit(cursor);
      }
    } catch {
      // A later poll retries transient adapter failures.
    }
  }

  private async start(): Promise<void> {
    if (this.timer || this.polling) {
      return;
    }
    if (!this.initialization) {
      const { revision } = this;
      this.initialization = this.adapter
        .currentCursor()
        .then((cursor) => {
          if (revision === this.revision) {
            this.cursor = cursor;
          }
        })
        .finally(() => {
          this.initialization = undefined;
        });
    }
    await this.initialization;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.listeners.size === 0 || this.timer || this.polling) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = this.poll().finally(() => {
        this.polling = undefined;
        this.schedulePoll();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
