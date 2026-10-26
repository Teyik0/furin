import { log } from "evlog";
import { CacheGeneration } from "./cache-generation.ts";
import { generateHistoryKey, getHistoryKey, saveScrollPosition } from "./history.ts";
import {
  normalizeHref,
  shouldAutoRefreshPath,
  stripHashFromHref,
  toLogical,
} from "./link-utils.ts";
import type { OptimisticRuntime } from "./optimistic.ts";
import type { PageResult } from "./page-fetch.ts";
import type { LoadedClientRoute, RouterState } from "./types.ts";

/** What React renders: the committed page plus navigation status. */
export interface NavigationSnapshot {
  /** Logical href (basePath stripped) of the committed page. */
  href: string;
  isNavigating: boolean;
  /** Bumped on every non-error commit so error boundaries reset. */
  resetVersion: number;
  state: RouterState;
}

export interface NavigationControllerConfig {
  basePath: string;
  /** Stale time of snapshots cached by navigations. */
  defaultStaleTime: number;
  fetchPage: (request: {
    /** Match of the committed page, read when the fetch needs it. */
    currentMatch: () => LoadedClientRoute | null;
    hmrRefresh: boolean;
    href: string;
    signal: AbortSignal | undefined;
  }) => Promise<PageResult>;
  maxCacheSize: number;
}

export interface NavigateRequest {
  /** Runs right before the new snapshot is published (HMR swaps components here). */
  beforeCommit?: () => void;
  hmrRefresh?: boolean;
  replace?: boolean;
  resetScroll?: boolean;
  /** Returning `false` discards the navigation result instead of committing it. */
  shouldCommit?: () => boolean;
}

export type RefreshRequest = Omit<NavigateRequest, "replace">;

export type ScrollInstruction = { type: "restore"; key: string } | { type: "reset"; href: string };

/** A fetched page with the versions it was read at. */
interface FetchedPage {
  /** Cache generation when the fetch started. */
  generation: number;
  result: PageResult;
  /** Optimistic revision of the href when the fetch started; unknown for prefetches. */
  revision: number | undefined;
}

interface PageCacheEntry {
  createdAt: number;
  promise: Promise<FetchedPage>;
  staleTime: number;
}

type Renderable = Extract<PageResult, { state: RouterState }>;

type NavigationKind =
  | { type: "push"; request: NavigateRequest }
  | { type: "pop"; key: string | undefined };

const MAX_REDIRECTS = 10;

function isRenderable(result: PageResult): result is Renderable {
  return result.kind === "page" || result.kind === "error" || result.kind === "notFound";
}

function isExpired(entry: PageCacheEntry): boolean {
  return Date.now() - entry.createdAt > entry.staleTime;
}

function historyStateObject(): object {
  const value = history.state;
  return value !== null && typeof value === "object" ? value : {};
}

/**
 * Framework-agnostic SPA navigation: page fetching through a versioned
 * prefetch cache, redirects, aborts, history push/pop and the committed
 * snapshot. React subscribes to it with `useSyncExternalStore`.
 */
export class NavigationController {
  #config: NavigationControllerConfig;
  readonly #optimistic: OptimisticRuntime;
  readonly #cache = new Map<string, PageCacheEntry>();
  readonly #generation = new CacheGeneration();
  readonly #listeners = new Set<() => void>();
  #snapshot: NavigationSnapshot;
  /** Monotonic counter discarding superseded navigations. */
  #version = 0;
  /** In-flight navigation; aborted when superseded or when it ends uncommitted. */
  #pendingAbort: AbortController | null = null;
  /** Owns the visible page's deferred stream until replacement or an access-context change. */
  #committedAbort: AbortController | null = null;
  #contextAbort = new AbortController();
  #pendingUserNavigation: { promise: Promise<void>; resolve: () => void } | null = null;
  #renderedHistoryKey: string | undefined;
  #pendingScroll: ScrollInstruction | null = null;

  constructor(options: {
    config: NavigationControllerConfig;
    initial: NavigationSnapshot;
    optimistic: OptimisticRuntime;
  }) {
    this.#config = options.config;
    this.#optimistic = options.optimistic;
    this.#snapshot = options.initial;
  }

  configure(config: NavigationControllerConfig): void {
    this.#config = config;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): NavigationSnapshot => this.#snapshot;

  readonly navigate = (href: string, request?: NavigateRequest): Promise<void> =>
    this.#run(normalizeHref(href), { type: "push", request: request ?? {} });

  /** Browser back/forward: the URL already changed, render its page. */
  readonly popState = (): void => {
    if (this.#renderedHistoryKey) {
      saveScrollPosition(this.#renderedHistoryKey);
    }
    const key = getHistoryKey(history.state);
    const href =
      normalizeHref(toLogical(window.location.pathname, this.#config.basePath)) +
      window.location.search;
    this.#run(href, { type: "pop", key }).catch((error: unknown) => {
      log.error({ action: "popstate_failed", error: String(error) });
    });
  };

  /** Re-fetches the current URL in place. */
  readonly refresh = (request?: RefreshRequest): Promise<void> => {
    const href =
      toLogical(window.location.pathname, this.#config.basePath) + window.location.search;
    this.invalidatePath(href, "page");
    return this.navigate(href, {
      beforeCommit: request?.beforeCommit,
      hmrRefresh: request?.hmrRefresh,
      replace: true,
      resetScroll: request?.resetScroll ?? false,
      shouldCommit: request?.shouldCommit,
    });
  };

  readonly prefetch = (href: string, staleTime: number | undefined): void => {
    const existing = this.#cache.get(href);
    if (existing && !isExpired(existing)) {
      return;
    }
    const generation = this.#generation.current;
    const entry: PageCacheEntry = {
      createdAt: Date.now(),
      promise: this.#config
        .fetchPage({
          currentMatch: this.#currentMatch,
          hmrRefresh: false,
          href,
          signal: this.#contextAbort.signal,
        })
        .then((result) => ({ generation, result, revision: undefined })),
      staleTime: staleTime ?? this.#config.defaultStaleTime,
    };
    this.#store(href, entry);
    // Failures, errors and not-found pages are transient: never serve them later.
    entry.promise.then(({ result }) => {
      if (
        !(result.kind === "page" || result.kind === "redirect") &&
        this.#cache.get(href) === entry
      ) {
        this.#cache.delete(href);
      }
    });
  };

  /** Drops cached pages under `path` and marks in-flight ones stale. */
  readonly invalidatePath = (path: string, type: "page" | "layout"): void => {
    const normalizedPath = normalizeHref(new URL(path, "http://furin.local").pathname);
    const affects = (href: string) =>
      shouldAutoRefreshPath(normalizeHref(stripHashFromHref(href)), [
        { path: normalizedPath, type },
      ]);
    this.#generation.bump(affects);
    for (const key of [...this.#cache.keys()]) {
      if (affects(key)) {
        this.#cache.delete(key);
      }
    }
  };

  /** Access changes must also prevent old navigations and deferred streams from publishing. */
  invalidateContext(): void {
    this.#version += 1;
    const pendingAbort = this.#pendingAbort;
    const committedAbort = this.#committedAbort;
    const contextAbort = this.#contextAbort;
    const pendingNavigation = this.#pendingUserNavigation;
    this.#pendingAbort = null;
    this.#committedAbort = null;
    this.#contextAbort = new AbortController();
    this.#pendingUserNavigation = null;
    this.invalidatePath("/", "layout");
    this.#setNavigating(false);
    pendingAbort?.abort();
    committedAbort?.abort();
    contextAbort.abort();
    pendingNavigation?.resolve();
  }

  /** Drops cached pages whose state reads an invalidated query. */
  invalidateQueries(affected: (state: RouterState) => boolean): void {
    this.#generation.bump((_href, state) => affected(state));
    for (const [href, entry] of this.#cache) {
      entry.promise
        .then(({ result }) => {
          if (isRenderable(result) && affected(result.state) && this.#cache.get(href) === entry) {
            this.#cache.delete(href);
          }
        })
        .catch(() => undefined);
    }
  }

  /** Republishes the current page so hot-swapped components render. */
  rerender(): void {
    this.#publish({ ...this.#snapshot, state: { ...this.#snapshot.state } });
  }

  /** Resolves once no user navigation (push or pop) is pending. */
  async waitForUserNavigation(): Promise<void> {
    while (this.#pendingUserNavigation) {
      // biome-ignore lint/performance/noAwaitInLoops: superseded user navigations must settle in sequence before HMR may refresh the final URL
      await this.#pendingUserNavigation.promise;
    }
  }

  /** Keys the initial history entry so its scroll position can be restored. */
  adoptHistoryEntry(): void {
    history.scrollRestoration = "manual";
    if (!getHistoryKey(history.state)) {
      history.replaceState({ ...historyStateObject(), _furinKey: generateHistoryKey() }, "");
    }
    this.#renderedHistoryKey = getHistoryKey(history.state);
  }

  /** Scroll work for the page just committed, consumed once after React renders it. */
  takeScrollInstruction(): ScrollInstruction | null {
    const instruction = this.#pendingScroll;
    this.#pendingScroll = null;
    return instruction;
  }

  readonly #currentMatch = (): LoadedClientRoute | null => this.#snapshot.state.match;

  #publish(snapshot: NavigationSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #setNavigating(isNavigating: boolean): void {
    if (this.#snapshot.isNavigating !== isNavigating) {
      this.#publish({ ...this.#snapshot, isNavigating });
    }
  }

  #store(href: string, entry: PageCacheEntry): void {
    this.#cache.delete(href);
    this.#cache.set(href, entry);
    if (this.#cache.size > this.#config.maxCacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (typeof oldest === "string") {
        this.#cache.delete(oldest);
      }
    }
  }

  #beginUserNavigation(): () => void {
    this.#pendingUserNavigation?.resolve();
    const navigation = Promise.withResolvers<void>();
    this.#pendingUserNavigation = navigation;
    return () => {
      if (this.#pendingUserNavigation === navigation) {
        this.#pendingUserNavigation = null;
      }
      navigation.resolve();
    };
  }

  #startAbort(): AbortController {
    this.#pendingAbort?.abort();
    const controller = new AbortController();
    this.#pendingAbort = controller;
    return controller;
  }

  #settleAbort(controller: AbortController, committed: boolean): void {
    if (this.#pendingAbort === controller) {
      this.#pendingAbort = null;
    }
    if (!committed) {
      controller.abort();
      return;
    }
    this.#committedAbort?.abort();
    this.#committedAbort = controller;
  }

  async #run(href: string, kind: NavigationKind): Promise<void> {
    const hmrRefresh = kind.type === "push" && kind.request.hmrRefresh === true;
    const finishUserNavigation = hmrRefresh ? undefined : this.#beginUserNavigation();
    this.#version += 1;
    const version = this.#version;
    const abort = this.#startAbort();
    const cancelled = Promise.withResolvers<false>();
    const onAbort = () => cancelled.resolve(false);
    abort.signal.addEventListener("abort", onAbort, { once: true });
    let committed = false;
    this.#setNavigating(true);
    try {
      if (abort.signal.aborted) {
        return;
      }
      committed = await Promise.race([
        this.#load(href, kind, version, abort.signal),
        cancelled.promise,
      ]);
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      this.#settleAbort(abort, committed);
      finishUserNavigation?.();
      if (this.#version === version) {
        this.#setNavigating(false);
      }
    }
  }

  #accepts(kind: NavigationKind, version: number): boolean {
    return (
      this.#version === version && (kind.type === "pop" || kind.request.shouldCommit?.() !== false)
    );
  }

  async #load(
    href: string,
    kind: NavigationKind,
    version: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const loaded = await this.#read(
      href,
      signal,
      kind.type === "push" && kind.request.hmrRefresh === true
    );
    if (!this.#accepts(kind, version)) {
      return false;
    }
    const { page } = loaded;
    if (
      kind.type === "push" &&
      loaded.fetched &&
      page.result.kind === "page" &&
      this.#generation.isFresh(href, page.result.state, page.generation)
    ) {
      this.#store(href, {
        createdAt: Date.now(),
        promise: Promise.resolve(page),
        staleTime: this.#config.defaultStaleTime,
      });
    }
    if (page.result.kind === "hardNavigate" || page.result.kind === "aborted") {
      log.warn({
        action: "navigate_fallback",
        href,
        reason: page.result.kind === "aborted" ? "aborted" : page.result.reason,
      });
      this.#hardNavigate(kind, href);
      return false;
    }
    const resolved = await this.#followRedirects(page, href, signal);
    if (this.#version !== version) {
      return false;
    }
    if (!resolved) {
      this.#hardNavigate(kind, href);
      return false;
    }
    if (!this.#accepts(kind, version)) {
      return false;
    }
    return this.#commit(resolved, kind, href);
  }

  #hardNavigate(kind: NavigationKind, href: string): void {
    if (kind.type === "pop") {
      window.location.reload();
      return;
    }
    window.location.href = this.#config.basePath + href;
  }

  async #read(
    href: string,
    signal: AbortSignal,
    hmrRefresh: boolean
  ): Promise<{ fetched: boolean; page: FetchedPage }> {
    const cached = this.#cache.get(href);
    if (cached && !isExpired(cached) && !this.#optimistic.has(href)) {
      const page = await cached.promise;
      if (this.#isReusable(href, page)) {
        return { fetched: false, page };
      }
    }
    return { fetched: true, page: await this.#fetchConfirmed(href, signal, hmrRefresh) };
  }

  /** A cached page is reusable only when nothing it depends on changed since its fetch. */
  #isReusable(href: string, page: FetchedPage): boolean {
    const { result } = page;
    return (
      result.kind === "page" &&
      result.reusable() &&
      this.#optimistic.publishable(href, page.revision ?? this.#optimistic.revision(href)) &&
      this.#generation.isFresh(href, result.state, page.generation)
    );
  }

  /** Fetches after pending local writes settle, retrying if one lands mid-flight. */
  async #fetchConfirmed(
    href: string,
    signal: AbortSignal,
    hmrRefresh: boolean
  ): Promise<FetchedPage> {
    for (;;) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a snapshot must be read after local writes settle.
        await this.#optimistic.wait(href, signal);
      } catch (error) {
        if (signal.aborted) {
          return {
            generation: this.#generation.current,
            result: { kind: "aborted" },
            revision: undefined,
          };
        }
        throw error;
      }
      const revision = this.#optimistic.revision(href);
      const generation = this.#generation.current;
      const result = await this.#config.fetchPage({
        currentMatch: this.#currentMatch,
        hmrRefresh,
        href,
        signal,
      });
      if (this.#optimistic.publishable(href, revision)) {
        return { generation, result, revision };
      }
    }
  }

  async #followRedirects(
    initial: FetchedPage,
    initialHref: string,
    signal: AbortSignal
  ): Promise<{ href: string; page: FetchedPage; result: Renderable } | null> {
    let page = initial;
    let href = initialHref;
    const visited = new Set([href]);
    for (let count = 0; page.result.kind === "redirect"; count += 1) {
      href = normalizeHref(page.result.href);
      if (count >= MAX_REDIRECTS || visited.has(href)) {
        return null;
      }
      visited.add(href);
      // biome-ignore lint/performance/noAwaitInLoops: each redirect target depends on the previous response.
      ({ page } = await this.#read(href, signal, false));
    }
    return isRenderable(page.result) ? { href, page, result: page.result } : null;
  }

  #commit(
    resolved: { href: string; page: FetchedPage; result: Renderable },
    kind: NavigationKind,
    requestedHref: string
  ): boolean {
    const { state } = resolved.result;
    const effective = state.finalHref ?? resolved.href;
    if (
      !this.#optimistic.publishable(
        effective,
        resolved.page.revision ?? this.#optimistic.revision(effective)
      )
    ) {
      return false;
    }
    if (!(state.error || state.notFound)) {
      this.#optimistic.commit(effective);
    }
    if (kind.type === "push") {
      kind.request.beforeCommit?.();
    }
    const href =
      kind.type === "push"
        ? this.#commitPush(kind.request, effective)
        : this.#commitPop(kind.key, effective, requestedHref);
    this.#publish({
      href,
      isNavigating: false,
      resetVersion: state.error ? this.#snapshot.resetVersion : this.#snapshot.resetVersion + 1,
      state,
    });
    if (state.title) {
      document.title = state.title;
    }
    if (kind.type === "pop" && !kind.key) {
      window.scrollTo({ behavior: "instant", top: 0 });
    }
    return true;
  }

  /** Pushes (or replaces) the history entry and returns the committed logical href. */
  #commitPush(request: NavigateRequest, effective: string): string {
    const { basePath } = this.#config;
    const physical = basePath + effective;
    if (request.resetScroll ?? true) {
      this.#pendingScroll = { href: physical, type: "reset" };
    }
    if (request.replace) {
      history.replaceState(
        {
          ...historyStateObject(),
          _furinKey: getHistoryKey(history.state) ?? generateHistoryKey(),
        },
        "",
        physical
      );
    } else {
      if (this.#renderedHistoryKey) {
        saveScrollPosition(this.#renderedHistoryKey);
      }
      history.pushState({ _furinKey: generateHistoryKey() }, "", physical);
    }
    this.#renderedHistoryKey = getHistoryKey(history.state);
    const url = new URL(physical, window.location.origin);
    return normalizeHref(toLogical(url.pathname, basePath)) + url.search;
  }

  /** Adopts the popped entry (canonicalised after redirects) and returns the committed logical href. */
  #commitPop(key: string | undefined, effective: string, requestedHref: string): string {
    if (effective !== requestedHref) {
      history.replaceState(history.state, "", this.#config.basePath + effective);
    }
    this.#renderedHistoryKey = key;
    if (key) {
      this.#pendingScroll = { key, type: "restore" };
    }
    return normalizeHref(effective);
  }
}
