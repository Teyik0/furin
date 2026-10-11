// biome-ignore-all lint/performance/noAwaitInLoops: Observe shutdown and schedule OS operations in order.
import { dirname, resolve } from "node:path";
import { watchProcessExit } from "./process-exit";

export interface NativeRestartPlan {
  cwd: string;
  env: NodeJS.ProcessEnv;
  launcher: string;
  pids: number[];
}

export function nativeLauncherPath(entry: string): string {
  let launcher = "bin/launcher";
  if (process.platform === "darwin") {
    launcher = "MacOS/launcher";
  }
  if (process.platform === "win32") {
    launcher = "bin/launcher.exe";
  }
  return resolve(dirname(entry), "../../..", launcher);
}

const WINDOWS_TASK = `
$ErrorActionPreference = 'Stop'
$task = $env:FURIN_RESTART_TASK
$action = New-ScheduledTaskAction -Execute $env:FURIN_RESTART_BUN -Argument (
  '"' + $env:FURIN_RESTART_HELPER + '" "' + $env:FURIN_RESTART_ORIGIN + '" "' + $env:FURIN_RESTART_KEY + '"')
$user = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-ScheduledTaskPrincipal -UserId $user.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$registered = $service.GetFolder('\\').GetTask($task)
$registered.SetSecurityDescriptor(('D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + $user.User.Value + ')'), 0)
Start-ScheduledTask -TaskName $task
`;

async function deleteTask(task: string) {
  const child = Bun.spawn(["schtasks.exe", "/delete", "/tn", task, "/f"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  if ((await child.exited) !== 0) {
    throw new Error("Unable to remove the native restart task.");
  }
}

function stopHelper(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

/** Arm a transient helper. Environment is handed off in memory, never written to disk. */
export async function armNativeRestart(plan: NativeRestartPlan, helper: string) {
  if (!((await Bun.file(plan.launcher).exists()) && (await Bun.file(helper).exists()))) {
    throw new Error("The packaged native launcher or restart helper is missing.");
  }
  const key = crypto.randomUUID();
  const ready = Promise.withResolvers<number>();
  let claimed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1024,
    async fetch(request) {
      if (
        request.headers.has("origin") ||
        request.headers.get("authorization") !== `Bearer ${key}`
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/plan" && !claimed) {
        claimed = true;
        return Response.json(plan, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && path === "/ready" && claimed) {
        const pid: unknown = await request.json();
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
          return new Response("Invalid PID", { status: 400 });
        }
        ready.resolve(pid);
        return new Response(null, { status: 204 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const task = `FurinRestart_${crypto.randomUUID().replaceAll("-", "")}`;
  let child: Bun.Subprocess | undefined;
  let helperPid: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (process.platform === "win32") {
      const scheduler = Bun.spawn(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TASK],
        {
          env: {
            ...process.env,
            FURIN_RESTART_TASK: task,
            FURIN_RESTART_BUN: process.execPath,
            FURIN_RESTART_HELPER: helper,
            FURIN_RESTART_ORIGIN: server.url.origin,
            FURIN_RESTART_KEY: key,
          },
          stdout: "ignore",
          stderr: "ignore",
          timeout: 5000,
          killSignal: "SIGKILL",
        }
      );
      if ((await scheduler.exited) !== 0) {
        throw new Error("Unable to schedule the native restart helper.");
      }
    } else {
      child = Bun.spawn([process.execPath, helper, server.url.origin, key], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, BUN_OPTIONS: undefined },
      });
      child.unref();
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Native restart helper did not become ready.")),
        5000
      );
    });
    helperPid = await Promise.race([
      ready.promise,
      deadline,
      ...(child
        ? [
            child.exited.then(() => {
              throw new Error("Native restart helper exited before readiness.");
            }),
          ]
        : []),
    ]);
    if (process.platform === "win32") {
      await deleteTask(task);
    }
    return {
      cancel() {
        if (helperPid) {
          stopHelper(helperPid);
        }
      },
    };
  } catch (error) {
    if (helperPid) {
      stopHelper(helperPid);
    }
    child?.kill("SIGKILL");
    if (child) {
      await child.exited;
    }
    if (process.platform === "win32") {
      await deleteTask(task).catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await server.stop(false);
  }
}

export async function runNativeRestart(plan: NativeRestartPlan, acknowledge: () => Promise<void>) {
  const watches: ReturnType<typeof watchProcessExit>[] = [];
  try {
    for (const pid of new Set(plan.pids)) {
      watches.push(watchProcessExit(pid));
    }
    await acknowledge();
    const pending = new Set(watches);
    const deadline = Date.now() + 30_000;
    while (pending.size) {
      for (const watch of pending) {
        if (watch.exited()) {
          pending.delete(watch);
        }
      }
      if (Date.now() > deadline) {
        throw new Error("The old native process did not exit.");
      }
      if (pending.size) {
        await Bun.sleep(25);
      }
    }
    const env = { ...plan.env };
    env.ELECTROBUN_LAUNCHER_PID = undefined;
    env.FURIN_NATIVE_OPEN = undefined;
    const child = Bun.spawn([plan.launcher], {
      cwd: plan.cwd,
      env,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  } finally {
    for (const watch of watches) {
      watch.close();
    }
  }
}

if (import.meta.main) {
  try {
    const [origin, key, ...extra] = Bun.argv.slice(2);
    if (!(origin && key) || extra.length) {
      throw new Error("Invalid native restart invocation.");
    }
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("Invalid native restart origin.");
    }
    const headers = { authorization: `Bearer ${key}` };
    const response = await fetch(new URL("/plan", url), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error("Native restart handoff failed.");
    }
    const plan = (await response.json()) as NativeRestartPlan;
    await runNativeRestart(plan, async () => {
      const result = await fetch(new URL("/ready", url), {
        method: "POST",
        headers,
        body: JSON.stringify(process.pid),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!result.ok) {
        throw new Error("Native restart readiness failed.");
      }
      await result.arrayBuffer();
    });
  } catch {
    console.error("[furin-electrobun] Native restart helper failed.");
    process.exitCode = 1;
  }
}
