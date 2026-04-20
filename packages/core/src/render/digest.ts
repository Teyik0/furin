/**
 * Computes a deterministic, opaque 10-hex-character digest for an error.
 *
 * Purpose: render this digest in client-facing error UIs (e.g. `Error ID:
 * a3f2b9c1d8`) and log the same digest alongside the full stack on the server,
 * so support can correlate user reports with server logs without leaking stack
 * traces or sensitive message content to the browser.
 *
 * Deterministic: identical error message + stack ⇒ identical digest across
 * restarts, processes, and environments (server + client).
 *
 * Uses a pure-JS 53-bit hash so the function works identically in Bun and in
 * the browser — `computeErrorDigest` is called from `FurinErrorBoundary`, which
 * runs on both sides.
 */
export function computeErrorDigest(err: unknown): string {
  let message = "";
  let stack = "";

  if (err instanceof Error) {
    message = err.message;
    stack = err.stack ?? "";
  } else if (typeof err === "string") {
    message = err;
  } else {
    // Non-Error, non-string throws (e.g. `throw { code: 401 }`, `throw 42`,
    // `throw null`). Without this branch every such value would collapse to
    // the same empty `message`/`stack` and therefore the same digest, defeating
    // the whole point of correlating distinct failures with distinct IDs.
    // Prefer JSON.stringify for stable shape-aware hashing of plain objects;
    // fall back to String(err) when the value isn't JSON-serialisable
    // (circular refs, BigInt, symbols, …).
    try {
      message = JSON.stringify(err) ?? String(err);
    } catch {
      message = String(err);
    }
  }

  const input = `${message}\n${stack}`;
  const hash = cyrb53(input);
  const hex = hash.toString(16).padStart(14, "0");
  return hex.slice(0, 10);
}

/**
 * cyrb53 (c) 2018 bryc (github.com/bryc)
 * A fast, deterministic 53-bit string hash that works in any JS environment.
 * Produces a Number safe for JS integer arithmetic (max 2^53 - 1).
 * Licensed under Public Domain.
 */
function cyrb53(input: string): number {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    // biome-ignore lint/suspicious/noBitwiseOperators: cyrb53 hash requires XOR
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    // biome-ignore lint/suspicious/noBitwiseOperators: cyrb53 hash requires XOR
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }

  // biome-ignore lint/suspicious/noBitwiseOperators: cyrb53 finalization requires XOR and unsigned shift
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  // biome-ignore lint/suspicious/noBitwiseOperators: cyrb53 finalization requires XOR and unsigned shift
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

  // biome-ignore lint/suspicious/noBitwiseOperators: cyrb53 combines 32-bit halves with bitwise AND
  return 4_294_967_296 * (2_097_151 & h2) + (2_097_151 & h1);
}
