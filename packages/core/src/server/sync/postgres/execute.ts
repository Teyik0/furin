import type { AtomicMutationResult, AtomicMutationValue, MutationLease } from "../adapter.ts";
import { MutationLeaseLost } from "../execution-error.ts";
import type { PostgresSyncAdapter } from "./index.ts";

export async function executePostgresMutation<T, Tx>(
  journal: PostgresSyncAdapter,
  lease: MutationLease,
  tx: Tx,
  callback: (tx: Tx) => AtomicMutationValue<T> | Promise<AtomicMutationValue<T>>
): Promise<AtomicMutationResult<T>> {
  if (!(await journal.lockMutation(lease))) {
    throw new MutationLeaseLost("[furin] Mutation lease lost; the transaction was rolled back.");
  }
  const result = await callback(tx);
  const completion = await journal.completeLockedMutation({ ...result, lease });
  if (completion.kind === "lost") {
    throw new MutationLeaseLost("[furin] Mutation lease lost; the transaction was rolled back.");
  }
  return { ...result, cursor: completion.cursor, kind: "committed" };
}
