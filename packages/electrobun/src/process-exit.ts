import { dlopen, FFIType } from "bun:ffi";
import { closeSync } from "node:fs";

/** Pin kernel process identities, not reusable PID numbers. */
export function watchProcessExit(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7f_ff_ff_ff) {
    throw new Error("Invalid native restart PID.");
  }
  if (process.platform === "win32") {
    const library = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    const handle = library.symbols.OpenProcess(0x10_00_00, 0, pid);
    if (!handle) {
      library.close();
      throw new Error("Cannot watch the native process.");
    }
    return {
      exited() {
        const status = library.symbols.WaitForSingleObject(handle, 0);
        if (status !== 0 && status !== 258) {
          throw new Error("Native process wait failed.");
        }
        return status === 0;
      },
      close() {
        library.symbols.CloseHandle(handle);
        library.close();
      },
    };
  }
  if (process.platform === "darwin") {
    const library = dlopen("libSystem.B.dylib", {
      kqueue: { args: [], returns: FFIType.i32 },
      kevent: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const fd = library.symbols.kqueue();
    const event = Buffer.alloc(32);
    event.writeBigUInt64LE(BigInt(pid), 0);
    event.writeInt16LE(-5, 8); // EVFILT_PROC
    event.writeUInt16LE(0x15, 10); // EV_ADD | EV_ENABLE | EV_ONESHOT
    event.writeUInt32LE(0x80_00_00_00, 12); // NOTE_EXIT
    const timeout = Buffer.alloc(16);
    if (fd < 0 || library.symbols.kevent(fd, event, 1, null, 0, timeout) < 0) {
      if (fd >= 0) {
        closeSync(fd);
      }
      library.close();
      throw new Error("Cannot watch the native process.");
    }
    return {
      exited() {
        const status = library.symbols.kevent(fd, null, 0, event, 1, timeout);
        if (status < 0) {
          throw new Error("Native process wait failed.");
        }
        return status > 0;
      },
      close() {
        closeSync(fd);
        library.close();
      },
    };
  }
  const library = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  });
  const fd = library.symbols.syscall(434, pid, 0); // pidfd_open: x64 and arm64
  if (fd < 0) {
    library.close();
    throw new Error("Cannot watch the native process; Linux kernel 5.3+ is required.");
  }
  const descriptor = Buffer.alloc(8);
  descriptor.writeInt32LE(fd, 0);
  descriptor.writeInt16LE(1, 4); // POLLIN
  return {
    exited() {
      const status = library.symbols.poll(descriptor, 1, 0);
      if (status < 0) {
        throw new Error("Native process wait failed.");
      }
      return status > 0;
    },
    close() {
      closeSync(fd);
      library.close();
    },
  };
}
