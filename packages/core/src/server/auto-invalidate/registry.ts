import { type FurinInstance, instanceSlot } from "../instance.ts";

export class AutoInvalidateRegistry {
  private readonly pathToTags = new Map<string, Set<string>>();
  private readonly tagToPaths = new Map<string, Set<string>>();

  registerLoaderTags(urlPath: string, tags: readonly string[] | undefined): void {
    if (!tags || tags.length === 0) {
      this.unregisterPath(urlPath);
      return;
    }

    this.unregisterPath(urlPath);

    const uniqueTags = new Set(tags);
    this.pathToTags.set(urlPath, uniqueTags);
    for (const tag of uniqueTags) {
      let paths = this.tagToPaths.get(tag);
      if (!paths) {
        paths = new Set<string>();
        this.tagToPaths.set(tag, paths);
      }
      paths.add(urlPath);
    }
  }

  pathsForTags(tags: readonly string[]): string[] {
    const paths = new Set<string>();
    for (const tag of tags) {
      for (const path of this.tagToPaths.get(tag) ?? []) {
        paths.add(path);
      }
    }
    return [...paths];
  }

  unregisterPath(urlPath: string): void {
    const tags = this.pathToTags.get(urlPath);
    if (!tags) {
      return;
    }

    for (const tag of tags) {
      const paths = this.tagToPaths.get(tag);
      if (!paths) {
        continue;
      }
      paths.delete(urlPath);
      if (paths.size === 0) {
        this.tagToPaths.delete(tag);
      }
    }
    this.pathToTags.delete(urlPath);
  }

  reset(): void {
    this.pathToTags.clear();
    this.tagToPaths.clear();
  }
}

const instanceAutoInvalidateRegistry = instanceSlot(() => new AutoInvalidateRegistry());

/** The current furin instance's registry (see server/instance.ts). */
export function getAutoInvalidateRegistry(instance?: FurinInstance): AutoInvalidateRegistry {
  return instanceAutoInvalidateRegistry(instance);
}

/**
 * Instance-scoped facade kept under the historical singleton name so call
 * sites read the same — every method resolves the current instance's registry.
 */
export const autoInvalidateRegistry: Pick<
  AutoInvalidateRegistry,
  "registerLoaderTags" | "pathsForTags" | "unregisterPath" | "reset"
> = {
  pathsForTags: (tags) => instanceAutoInvalidateRegistry().pathsForTags(tags),
  registerLoaderTags: (urlPath, tags) =>
    instanceAutoInvalidateRegistry().registerLoaderTags(urlPath, tags),
  reset: () => instanceAutoInvalidateRegistry().reset(),
  unregisterPath: (urlPath) => instanceAutoInvalidateRegistry().unregisterPath(urlPath),
};
