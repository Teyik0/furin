import { expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { postgresSyncNotifier } from "../../../../src/server/sync/postgres/index.ts";

const POSTGRES_NOTIFICATION_CHANNEL_PATTERN = /^furin_sync_[a-f0-9]{52}$/;

test("publishes the cursor on a stable namespace-specific PostgreSQL channel", async () => {
  const notifications: Array<{ channel: string; payload: string | undefined }> = [];
  const sql = (() => Promise.resolve([])) as unknown as SQL;
  sql.notify = mock((channel: string, payload?: string) => {
    notifications.push({ channel, payload });
    return Promise.resolve();
  });

  const notifier = postgresSyncNotifier({ namespace: "task manager/é", sql });
  await notifier.publish("42");

  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.payload).toBe("42");
  expect(notifications[0]?.channel).toMatch(POSTGRES_NOTIFICATION_CHANNEL_PATTERN);
  expect(new TextEncoder().encode(notifications[0]?.channel).byteLength).toBe(63);
});

test("isolates PostgreSQL notification channels by namespace", async () => {
  const channels: string[] = [];
  const sql = (() => Promise.resolve([])) as unknown as SQL;
  sql.notify = mock((channel: string) => {
    channels.push(channel);
    return Promise.resolve();
  });

  await postgresSyncNotifier({ namespace: "application-a", sql }).publish("1");
  await postgresSyncNotifier({ namespace: "application-b", sql }).publish("1");

  expect(channels[0]).not.toBe(channels[1]);
});

test("subscribes to cursor notifications and releases its Bun SQL listener", async () => {
  let notifyListener: ((payload: string) => void) | undefined;
  const unlisten = mock(() => Promise.resolve());
  const sql = (() => Promise.resolve([])) as unknown as SQL;
  sql.listen = mock(
    (
      _channel: string,
      onnotify: (payload: string) => void,
      _onlisten?: (() => void) | undefined
    ) => {
      notifyListener = onnotify;
      return Promise.resolve({
        channel: "test",
        unlisten,
        [Symbol.asyncDispose]: unlisten,
      });
    }
  );

  const received: string[] = [];
  const subscription = await postgresSyncNotifier({
    namespace: "task-manager",
    sql,
  }).subscribe((cursor) => received.push(cursor));

  notifyListener?.("7");
  expect(received).toEqual(["7"]);

  await subscription.unsubscribe();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

test("reads the durable cursor after the initial LISTEN and every reconnect", async () => {
  let cursor = "3";
  let listenCallback: (() => void) | undefined;
  const queriedNamespaces: unknown[] = [];
  const sql = ((
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Array<{ current_cursor: string }>> => {
    queriedNamespaces.push(...values);
    return Promise.resolve([{ current_cursor: cursor }]);
  }) as unknown as SQL;
  sql.listen = mock(
    (
      _channel: string,
      _onnotify: (payload: string) => void,
      onlisten?: (() => void) | undefined
    ) => {
      listenCallback = onlisten;
      const unlisten = () => Promise.resolve();
      return Promise.resolve({
        channel: "test",
        unlisten,
        [Symbol.asyncDispose]: unlisten,
      });
    }
  );

  const received: string[] = [];
  await postgresSyncNotifier({ namespace: "task-manager", sql }).subscribe((nextCursor) => {
    received.push(nextCursor);
  });

  listenCallback?.();
  await Bun.sleep(0);
  cursor = "4";
  listenCallback?.();
  await Bun.sleep(0);

  expect(received).toEqual(["3", "4"]);
  expect(queriedNamespaces).toEqual(["task-manager", "task-manager"]);
});
