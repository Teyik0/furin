import { type FurinInstance, instanceSlot } from "../instance.ts";

export class AutoInvalidateRegistry {
  private readonly pathToTags = new Map<string, Set<string>>();
  private readonly pathOwners = new Map<string, Map<string, Set<string>>>();
  private readonly tagToPaths = new Map<string, Set<string>>();

  private reindexPath(urlPath: string): void {
    const previous = this.pathToTags.get(urlPath);
    if (previous) {
      for (const tag of previous) {
        const paths = this.tagToPaths.get(tag);
        paths?.delete(urlPath);
        if (paths?.size === 0) {
          this.tagToPaths.delete(tag);
        }
      }
    }

    const uniqueTags = new Set<string>();
    for (const tags of this.pathOwners.get(urlPath)?.values() ?? []) {
      for (const tag of tags) {
        uniqueTags.add(tag);
      }
    }
    if (uniqueTags.size === 0) {
      this.pathToTags.delete(urlPath);
      return;
    }
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

  registerLoaderTags(urlPath: string, tags: readonly string[] | undefined, owner?: string): void {
    const ownerKey = owner ?? "default";
    let owners = this.pathOwners.get(urlPath);
    if (tags === undefined || tags.length === 0) {
      owners?.delete(ownerKey);
      if (owners?.size === 0) {
        this.pathOwners.delete(urlPath);
      }
    } else {
      if (!owners) {
        owners = new Map<string, Set<string>>();
        this.pathOwners.set(urlPath, owners);
      }
      owners.set(ownerKey, new Set(tags));
    }
    this.reindexPath(urlPath);
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

  tagsForPath(path: string): string[] {
    return [...(this.pathToTags.get(path) ?? [])];
  }

  unregisterPath(urlPath: string, owner?: string): void {
    if (owner === undefined) {
      this.pathOwners.delete(urlPath);
    } else {
      const owners = this.pathOwners.get(urlPath);
      owners?.delete(owner);
      if (owners?.size === 0) {
        this.pathOwners.delete(urlPath);
      }
    }
    this.reindexPath(urlPath);
  }

  reset(): void {
    this.pathToTags.clear();
    this.pathOwners.clear();
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
  registerLoaderTags: (urlPath, tags, owner) =>
    instanceAutoInvalidateRegistry().registerLoaderTags(urlPath, tags, owner),
  reset: () => instanceAutoInvalidateRegistry().reset(),
  unregisterPath: (urlPath, owner) =>
    instanceAutoInvalidateRegistry().unregisterPath(urlPath, owner),
};
