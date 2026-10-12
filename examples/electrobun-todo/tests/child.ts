/** Resolve only after the owned child exits, including when its deadline expires. */
export async function waitForChild(child: ReturnType<typeof Bun.spawn>, deadlineMs: number) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, deadlineMs);
  try {
    const exitCode = await child.exited;
    if (timedOut) {
      throw new Error(`Child exceeded ${deadlineMs}ms deadline`);
    }
    return exitCode;
  } finally {
    clearTimeout(timer);
  }
}
