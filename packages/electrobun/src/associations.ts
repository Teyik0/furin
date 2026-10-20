import type { Pointer } from "bun:ffi";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssociationResult, AssociationTarget, DesktopIdentity } from "./capabilities";

/** A document type the application can open; Linux needs its MIME type to list it. */
export interface FileHandler {
  extensions: string[];
  mimeType?: string;
  name: string;
}

interface AssociationOptions {
  dataDir: string;
  helper: string;
  identity: DesktopIdentity;
  openExternal: (url: string) => boolean;
}
const EXTENSION = /^[a-z0-9][a-z0-9._-]*$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const DESKTOP_MIME_TYPES = /^MimeType=(.*)$/m;
const WINDOWS_VALUE = /REG_SZ\s+(.+)$/m;
const UNSAFE_PATH = /["\r\n\0]/;
const INVALID_DESKTOP_PATH = /[\r\n\0]/;
const DESKTOP_RESERVED = /[\\"`$]/g;

function validate(target: AssociationTarget) {
  if (
    "scheme" in target
      ? !SCHEME.test(target.scheme)
      : !EXTENSION.test(target.extension) ||
        (target.mimeType !== undefined && !MIME.test(target.mimeType))
  ) {
    throw new Error("Invalid native association target.");
  }
}

async function command(args: string[]) {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output, error };
}

async function requireCommand(args: string[], message: string): Promise<void> {
  const result = await command(args);
  if (result.code !== 0) {
    throw new Error(message);
  }
}

async function readWindows(target: AssociationTarget): Promise<AssociationResult> {
  const key =
    "scheme" in target
      ? `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${target.scheme}\\UserChoice`
      : `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${target.extension}\\UserChoice`;
  const result = await command(["reg.exe", "query", key, "/v", "ProgId"]);
  return {
    status: "confirmed",
    application:
      result.code === 0 ? (result.output.match(WINDOWS_VALUE)?.[1]?.trim() ?? null) : null,
  };
}

function windowsInvocation(args: string[]) {
  if (args.some((value) => UNSAFE_PATH.test(value))) {
    throw new Error("Invalid native helper path.");
  }
  return `${args.map((value) => `"${value}"`).join(" ")} "%1"`;
}

async function addWindowsValues(entries: string[][]) {
  for (const values of entries) {
    // biome-ignore lint/performance/noAwaitInLoops: Registry commands build each handler in a defined order.
    await requireCommand(
      ["reg.exe", "add", ...values, "/f"],
      "Unable to register the native handler."
    );
  }
}

/**
 * Lists the application in "Open with" and Default Apps through per-user ProgIDs
 * and registered capabilities. Windows reserves the default choice for the user.
 */
async function registerWindowsHandlers(
  invocation: string,
  identity: DesktopIdentity,
  schemes: string[],
  files: FileHandler[]
) {
  const classes = "HKCU\\Software\\Classes";
  const capabilities = `Software\\${identity.identifier}\\Capabilities`;
  const entries: string[][] = [];
  for (const file of files) {
    for (const extension of file.extensions) {
      validate({ extension });
      const progId = `${identity.identifier}.${extension.toLowerCase()}`;
      entries.push(
        [`${classes}\\${progId}`, "/ve", "/d", file.name],
        [`${classes}\\${progId}\\shell\\open\\command`, "/ve", "/d", invocation],
        [`${classes}\\.${extension}\\OpenWithProgids`, "/v", progId, "/d", ""],
        [`HKCU\\${capabilities}\\FileAssociations`, "/v", `.${extension}`, "/d", progId]
      );
    }
  }
  for (const scheme of schemes) {
    validate({ scheme });
    const progId = `${identity.identifier}.url.${scheme}`;
    entries.push(
      [`${classes}\\${progId}`, "/ve", "/d", `URL:${identity.name}`],
      [`${classes}\\${progId}`, "/v", "URL Protocol", "/d", ""],
      [`${classes}\\${progId}\\shell\\open\\command`, "/ve", "/d", invocation],
      [`HKCU\\${capabilities}\\URLAssociations`, "/v", scheme, "/d", progId]
    );
  }
  if (entries.length === 0) {
    return;
  }
  await addWindowsValues([
    ...entries,
    [`HKCU\\${capabilities}`, "/v", "ApplicationName", "/d", identity.name],
    [`HKCU\\${capabilities}`, "/v", "ApplicationDescription", "/d", identity.name],
    ["HKCU\\Software\\RegisteredApplications", "/v", identity.identifier, "/d", capabilities],
  ]);
}

async function registerWindows(invocation: string, schemes: string[], name: string) {
  await addWindowsValues(
    schemes.flatMap((scheme) => {
      validate({ scheme });
      const key = `HKCU\\Software\\Classes\\${scheme}`;
      return [
        [key, "/ve", "/d", `URL:${name}`],
        [key, "/v", "URL Protocol", "/d", ""],
        [`${key}\\shell\\open\\command`, "/ve", "/d", invocation],
      ];
    })
  );
}

async function macAssociation(
  target: AssociationTarget,
  identifier: string | undefined
): Promise<AssociationResult> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFStringCreateWithCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    CFStringGetCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
  });
  let services: ReturnType<typeof dlopen> | undefined;
  const references: (Pointer | bigint)[] = [];
  try {
    const ls = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", {
      LSCopyDefaultHandlerForURLScheme: { args: [FFIType.ptr], returns: FFIType.ptr },
      LSCopyDefaultRoleHandlerForContentType: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.ptr,
      },
      LSSetDefaultHandlerForURLScheme: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      LSSetDefaultRoleHandlerForContentType: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      UTTypeCreatePreferredIdentifierForTag: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
    });
    services = ls;
    const keep = (reference: Pointer | bigint | null) => {
      if (!reference) {
        throw new Error("macOS could not resolve the association.");
      }
      references.push(reference);
      return reference;
    };
    const string = (value: string) =>
      keep(cf.symbols.CFStringCreateWithCString(null, Buffer.from(`${value}\0`), 0x08_00_01_00));
    const subject =
      "scheme" in target
        ? string(target.scheme)
        : keep(
            ls.symbols.UTTypeCreatePreferredIdentifierForTag(
              string("public.filename-extension"),
              string(target.extension),
              null
            )
          );
    if (identifier) {
      const application = string(identifier);
      const status =
        "scheme" in target
          ? ls.symbols.LSSetDefaultHandlerForURLScheme(subject, application)
          : ls.symbols.LSSetDefaultRoleHandlerForContentType(subject, 2, application);
      if (status !== 0) {
        throw new Error(`macOS could not change the default (${status}).`);
      }
    }
    const pointer =
      "scheme" in target
        ? ls.symbols.LSCopyDefaultHandlerForURLScheme(subject)
        : ls.symbols.LSCopyDefaultRoleHandlerForContentType(subject, 2);
    let application: string | null = null;
    if (pointer) {
      keep(pointer);
      const buffer = Buffer.alloc(4096);
      if (!cf.symbols.CFStringGetCString(pointer, buffer, buffer.length, 0x08_00_01_00)) {
        throw new Error("macOS could not read the default.");
      }
      application = buffer.subarray(0, buffer.indexOf(0)).toString("utf8");
    }
    if (identifier && application !== identifier) {
      throw new Error("macOS did not confirm the requested default.");
    }
    return { status: "confirmed", application };
  } finally {
    for (const pointer of references) {
      cf.symbols.CFRelease(pointer);
    }
    services?.close();
    cf.close();
  }
}

function desktopArgument(value: string) {
  if (INVALID_DESKTOP_PATH.test(value)) {
    throw new Error("Invalid native helper path.");
  }
  return `"${value.replaceAll("%", "%%").replace(DESKTOP_RESERVED, (char) => `\\${char}`)}"`;
}

export function createAssociations(options: AssociationOptions) {
  const args = [
    process.execPath,
    options.helper,
    options.dataDir,
    options.identity.identifier,
    options.identity.channel,
  ];
  const leaf = `${options.identity.identifier}.furin-native.desktop`;
  const mime = (target: AssociationTarget) =>
    "scheme" in target ? `x-scheme-handler/${target.scheme}` : target.mimeType;
  const installLinuxEntry = async (types: string[]) => {
    const directory = join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
      "applications"
    );
    await mkdir(directory, { recursive: true });
    const file = join(directory, leaf);
    const existing = Bun.file(file);
    const previous = (await existing.exists())
      ? ((await existing.text()).match(DESKTOP_MIME_TYPES)?.[1]?.split(";") ?? [])
      : [];
    const supported = [...new Set([...previous.filter((type) => MIME.test(type)), ...types])];
    await writeFile(
      file,
      `[Desktop Entry]\nType=Application\nName=${options.identity.name}\nNoDisplay=true\nExec=${args.map(desktopArgument).join(" ")} %u\nMimeType=${supported.join(";")};\n`
    );
    // Best effort: "Open with" menus read the cache; a missing tool only delays listing.
    await command(["update-desktop-database", directory]).catch(() => undefined);
  };
  const read = async (target: AssociationTarget): Promise<AssociationResult> => {
    validate(target);
    if (process.platform === "darwin") {
      return macAssociation(target, undefined);
    }
    if (process.platform === "win32") {
      return readWindows(target);
    }
    const type = mime(target);
    if (!type) {
      return { status: "unsupported" };
    }
    try {
      const result = await command(["xdg-mime", "query", "default", type]);
      if (result.code !== 0) {
        throw new Error("Unable to query the default application.");
      }
      return { status: "confirmed", application: result.output.trim() || null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "unsupported" };
      }
      throw error;
    }
  };
  return {
    read,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit platform dispatch with verified results and unsupported-tool handling.
    async requestDefault(target: AssociationTarget): Promise<AssociationResult> {
      validate(target);
      if (options.identity.channel === "dev") {
        throw new Error("Default applications cannot be changed by a development build.");
      }
      if (process.platform === "darwin") {
        return macAssociation(target, options.identity.identifier);
      }
      if (process.platform === "win32") {
        // Opens this app's page, listed through its registered capabilities.
        const page = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(options.identity.identifier)}`;
        if (!options.openExternal(page)) {
          throw new Error("Windows default application settings are unavailable.");
        }
        return { status: "user-action-required" };
      }
      const type = mime(target);
      if (!type) {
        return { status: "unsupported" };
      }
      try {
        await installLinuxEntry([type]);
        const result = await command(["xdg-mime", "default", leaf, type]);
        if (result.code !== 0) {
          throw new Error("Unable to request the default application.");
        }
        const confirmed = await read(target);
        if (confirmed.status !== "confirmed" || confirmed.application !== leaf) {
          throw new Error("Linux did not confirm the requested default.");
        }
        return confirmed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "unsupported" };
        }
        throw error;
      }
    },
    /**
     * Owned `protocols` become this app's handlers. Shared `schemes` and `files`
     * only list the app as a choice: the user's defaults are never changed.
     */
    async registerHandlers(handlers: {
      files: FileHandler[];
      protocols: string[];
      schemes: string[];
    }) {
      const shared = handlers.schemes.filter((scheme) => !handlers.protocols.includes(scheme));
      if (
        process.platform === "darwin" ||
        handlers.protocols.length + shared.length + handlers.files.length === 0
      ) {
        return;
      }
      if (!(await Bun.file(options.helper).exists())) {
        throw new Error("The native open helper is missing.");
      }
      if (process.platform === "win32") {
        const invocation = windowsInvocation(args);
        await registerWindows(invocation, handlers.protocols, options.identity.name);
        await registerWindowsHandlers(invocation, options.identity, shared, handlers.files);
        return;
      }
      const owned = handlers.protocols.map((scheme) => {
        validate({ scheme });
        return `x-scheme-handler/${scheme}`;
      });
      const listed = [
        ...shared.map((scheme) => {
          validate({ scheme });
          return `x-scheme-handler/${scheme}`;
        }),
        ...handlers.files.flatMap((file) => {
          if (file.mimeType === undefined) {
            return [];
          }
          if (!MIME.test(file.mimeType)) {
            throw new Error("Invalid native association target.");
          }
          return [file.mimeType];
        }),
      ];
      await installLinuxEntry([...owned, ...listed]);
      for (const type of owned) {
        // biome-ignore lint/performance/noAwaitInLoops: Preserve registration order; report a failed command immediately.
        const result = await command(["xdg-mime", "default", leaf, type]);
        if (result.code !== 0) {
          throw new Error("Unable to register the native protocol.");
        }
      }
    },
  };
}
