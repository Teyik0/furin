// Sidecar started by `startProcess()`. The test process writes `<pid>` when it
// spawns a child and `-<pid>` once that child exits. When the test process
// exits by any means (`--bail`, crash, kill), its end of stdin closes and every
// child still registered is terminated, so none outlives the test run.
const running = new Set<number>();
const decoder = new TextDecoder();
let pending = "";

for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const pid = Number(line);
    if (pid > 0) {
      running.add(pid);
    } else {
      running.delete(-pid);
    }
  }
}

for (const pid of running) {
  try {
    process.kill(pid);
  } catch {
    // Already exited.
  }
}
