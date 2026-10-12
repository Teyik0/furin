import { closeSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DesktopIdentity, OpenEvent } from "./capabilities";

interface InstanceOptions {
  dataDir: string;
  extensions: string[];
  identity: DesktopIdentity;
  onActivate: () => void;
  onOpen: (event: OpenEvent) => void;
  schemes: string[];
}
interface Descriptor {
  channel: string;
  identifier: string;
  key: string;
  origin: string;
}
function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
const privateDirectory = (dataDir: string) => join(dataDir, ".furin-native");
const descriptorPath = (dataDir: string) => join(privateDirectory(dataDir), "descriptor.json");
const WINDOWS_PRIVATE_DIRECTORY = `
$ErrorActionPreference = 'Stop'
$path = $env:FURIN_NATIVE_DIRECTORY
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) { throw 'Native directory belongs to another user' }
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;

async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Native instance directory must not be a link.");
  }
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid?.()) {
      throw new Error("Native instance directory belongs to another user.");
    }
    await chmod(path, 0o700);
    return;
  }
  const acl = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_DIRECTORY],
    {
      env: { ...process.env, FURIN_NATIVE_DIRECTORY: path },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    }
  );
  if ((await acl.exited) !== 0) {
    throw new Error("Cannot secure native instance directory.");
  }
}

async function lock(path: string) {
  const { dlopen, FFIType } = await import("bun:ffi");
  if (process.platform === "win32") {
    const library = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.u64,
        ],
        returns: FFIType.u64,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    const handle = library.symbols.CreateFileW(
      Buffer.from(`${path}\0`, "utf16le"),
      0xc0_00_00_00,
      0,
      null,
      4,
      0x80,
      0n
    );
    if (BigInt(handle) === 0xffffffffffffffffn) {
      const error = library.symbols.GetLastError();
      library.close();
      if (error === 32 || error === 33) {
        return;
      }
      throw new Error(`Native instance lock failed (${error}).`);
    }
    return () => {
      library.symbols.CloseHandle(handle);
      library.close();
    };
  }
  const library = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(path, "a+", 0o600);
  } catch (error) {
    library.close();
    throw error;
  }
  if (library.symbols.flock(fd, 6) !== 0) {
    closeSync(fd);
    library.close();
    return;
  }
  return () => {
    closeSync(fd);
    library.close();
  };
}

/** Narrow native handoff, never a proxy to arbitrary application HTTP routes. */
export async function openNativeInstance(options: InstanceOptions) {
  await secureDirectory(privateDirectory(options.dataDir));
  const unlock = await lock(join(privateDirectory(options.dataDir), "instance.lock"));
  if (!unlock) {
    return;
  }
  let server: ReturnType<typeof Bun.serve> | undefined;
  const file = descriptorPath(options.dataDir);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const key = crypto.randomUUID();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 16 * 1024,
      async fetch(request) {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/open" ||
          request.headers.has("origin") ||
          request.headers.get("authorization") !== `Bearer ${key}`
        ) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const input: unknown = await request.json();
          if (!object(input)) {
            return new Response("Invalid event", { status: 400 });
          }
          if (input.type === "activate") {
            options.onActivate();
          } else if (input.type === "url" && typeof input.url === "string") {
            const url = new URL(input.url);
            if (!options.schemes.includes(url.protocol.slice(0, -1).toLowerCase())) {
              return new Response("Unregistered scheme", { status: 400 });
            }
            options.onOpen({ type: "url", url: url.href });
          } else if (
            input.type === "file" &&
            typeof input.path === "string" &&
            options.extensions.includes(extname(input.path).slice(1).toLowerCase())
          ) {
            options.onOpen({ type: "file", path: input.path });
          } else {
            return new Response("Unregistered event", { status: 400 });
          }
          return new Response(null, { status: 202 });
        } catch {
          return new Response("Invalid event", { status: 400 });
        }
      },
    });
    await writeFile(
      temporary,
      JSON.stringify({
        origin: server.url.origin,
        key,
        identifier: options.identity.identifier,
        channel: options.identity.channel,
      } satisfies Descriptor),
      { flag: "wx", mode: 0o600 }
    );
    await rename(temporary, file);
    const owned = server;
    let stopped: Promise<void> | undefined;
    return {
      stop() {
        stopped ??= (async () => {
          try {
            await owned.stop(true);
            await rm(file, { force: true });
          } finally {
            unlock();
          }
        })();
        return stopped;
      },
    };
  } catch (error) {
    await server?.stop(true);
    unlock();
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function forwardNativeOpen(
  dataDir: string,
  identity: Pick<DesktopIdentity, "identifier" | "channel">,
  event?: OpenEvent
): Promise<boolean> {
  const file = Bun.file(descriptorPath(dataDir));
  if (!(await file.exists())) {
    return false;
  }
  const descriptor: unknown = await file.json();
  if (
    !(
      object(descriptor) &&
      typeof descriptor.origin === "string" &&
      typeof descriptor.key === "string" &&
      descriptor.identifier === identity.identifier &&
      descriptor.channel === identity.channel
    )
  ) {
    throw new Error("The native descriptor does not match this application.");
  }
  const origin = new URL(descriptor.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Invalid native instance origin.");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/open", origin), {
      method: "POST",
      body: JSON.stringify(event ?? { type: "activate" }),
      headers: { authorization: `Bearer ${descriptor.key}`, "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return false;
  }
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error("The native instance rejected this event.");
  }
  return true;
}
