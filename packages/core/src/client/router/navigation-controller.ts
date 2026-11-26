import { log } from "evlog";
import { deepEqual, type SearchParamsInput } from "../../shared/search-params.ts";
import { CacheGeneration } from "./cache-generation.ts";
import {
  generateHistoryKey,
  getHistoryKey,
  getHistorySearch,
  saveScrollPosition,
} from "./history.ts";
import {
  normalizeHref,
  shouldAutoRefreshPath,
  stripHashFromHref,
  toLogical,
} from "./link-utils.ts";
import type { OptimisticRuntime } from "./optimistic.ts";
import type { PageResult } from "./page-fetch.ts";
import type { PendingScreen } from "./pending.ts";
import type { LoadedClientRoute, RouterState } from "./types.ts";

/** What React renders: the committed page plus navigation status. */
export interface NavigationSnapshot {
  /** Logical href (basePath stripped) of the committed page. */
  href: string;
  isNavigating: boolean;
  /** Pending screen shown in place of the committed page while a slow navigation loads. */
  pending?: PendingScreen;
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
  /** Pending screen of the route `href` targets, measured against the committed match. */
  resolvePending: (request: {
    currentMatch: LoadedClientRoute | null;
    href: string;
  }) => Promise<PendingScreen | undefined>;
}

export interface NavigateRequest {
  /** Runs right before the new snapshot is published (HMR swaps components here). */
  beforeCommit?: () => void;
  hmrRefresh?: boolean;
  /** `false` keeps the current page on screen instead of the target's pending screen. */
  pending?: boolean;
  replace?: boolean;
  resetScroll?: boolean;
  /**
   * Validated search the destination will read. Only with it can a page
   * already loaded for the same path be reused (see `loaderDeps`, `shallow`).
   */
  search?: SearchParamsInput;
  /** Same path: commit the new URL and search in place without running loaders. */
  shallow?: boolean;
  /** Returning `false` discards the navigation result instead of committing it. */
  shouldCommit?: () => boolean;
}

export type RefreshRequest = Omit<NavigateRequest, "replace" | "search" | "shallow">;

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
  /** The page once `promise` resolved, so it can be matched synchronously. */
  settled?: FetchedPage;
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

function pathnameOf(href: string): string {
  return normalizeHref(new URL(href, "http://furin.local").pathname);
}

/**
 * True when `state` is a page loaded for `href`'s path whose route declares
 * `loaderDeps` and reads the same dependencies from `search`.
 */
function sharesLoaderDeps(
  state: RouterState,
  stateHref: string,
  href: string,
  search: SearchParamsInput
): boolean {
  const loaderDeps = state.match?.pageRoute.loaderDeps;
  return (
    loaderDeps !== undefined &&
    pathnameOf(stateHref) === pathnameOf(href) &&
    deepEqual(
      loaderDeps((state.data.query as SearchParamsInput | undefined) ?? {}),
      loaderDeps(search)
    )
  );
}

/** The same loaded page, read with another search. */
function withSearch(state: RouterState, search: SearchParamsInput): RouterState {
  return { ...state, data: { ...state.data, query: search }, finalHref: undefined };
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
  /** When the current pending screen must stay until, at the earliest. */
  #pendingUntil = 0;

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
      pending: false,
      replace: true,
      resetScroll: request?.resetScroll ?? false,
      shouldCommit: request?.shouldCommit,
    });
  };

  readonly prefetch = (
    href: string,
    staleTime: number | undefined,
    search?: SearchParamsInput
  ): void => {
    const existing = this.#cache.get(href);
    if (
      (existing && !isExpired(existing)) ||
      (search && (this.#inPlace(href, search, false) || this.#sharedPage(href, search)))
    ) {
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
    history.replaceState(
      {
        ...historyStateObject(),
        _furinKey: getHistoryKey(history.state) ?? generateHistoryKey(),
        _furinSearch: this.#snapshot.state.data.query,
      },
      ""
    );
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
      this.#publish({
        ...this.#snapshot,
        isNavigating,
        pending: isNavigating ? this.#snapshot.pending : undefined,
      });
    }
  }

  /**
   * Shows the target's pending screen once the navigation outlasts its `ms`,
   * counted from the navigation start so a slow route module does not delay it.
   * A superseding navigation to the same screen keeps it up without a blink.
   */
  #schedulePending(href: string, kind: NavigationKind, version: number): void {
    const startedAt = Date.now();
    const wanted =
      kind.type === "pop" || !(kind.request.hmrRefresh || kind.request.pending === false);
    const screen = wanted
      ? this.#config.resolvePending({ currentMatch: this.#currentMatch(), href })
      : Promise.resolve(undefined);
    screen
      .then((resolved) => {
        const shown = this.#snapshot.pending;
        if (
          this.#version !== version ||
          (shown && shown.component === resolved?.component && shown.depth === resolved.depth)
        ) {
          return;
        }
        if (shown) {
          this.#publish({ ...this.#snapshot, pending: undefined });
        }
        if (!resolved) {
          return;
        }
        setTimeout(
          () => {
            if (this.#version === version && this.#snapshot.isNavigating) {
              this.#pendingUntil = Date.now() + resolved.minMs;
              this.#publish({ ...this.#snapshot, pending: resolved });
            }
          },
          startedAt + resolved.ms - Date.now()
        );
      })
      .catch((error: unknown) => {
        log.warn({ action: "pending_resolve_failed", error: String(error), href });
      });
  }

  /** Keeps a shown pending screen up for its `minMs`. */
  async #holdPending(): Promise<void> {
    const remaining = this.#snapshot.pending ? this.#pendingUntil - Date.now() : 0;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  #store(href: string, entry: PageCacheEntry): void {
    entry.promise.then(
      (page) => {
        entry.settled = page;
      },
      () => undefined
    );
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
    const search = kind.type === "push" ? kind.request.search : getHistorySearch(history.state);
    const shallow = kind.type === "push" && kind.request.shallow === true;
    if (
      search &&
      this.#inPlace(href, search, shallow) &&
      !(kind.type === "push" && kind.request.shouldCommit?.() === false)
    ) {
      this.#commitInPlace(href, kind, search);
      return;
    }
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
    this.#schedulePending(href, kind, version);
    try {
      if (abort.signal.aborted) {
        return;
      }
      committed = await Promise.race([
        this.#load(href, kind, version, abort.signal, search),
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
    signal: AbortSignal,
    search: SearchParamsInput | undefined
  ): Promise<boolean> {
    const loaded = await this.#read(
      href,
      signal,
      kind.type === "push" && kind.request.hmrRefresh === true,
      search
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
    await this.#holdPending();
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
    hmrRefresh: boolean,
    search: SearchParamsInput | undefined
  ): Promise<{ fetched: boolean; page: FetchedPage }> {
    const cached = this.#cache.get(href);
    if (cached && !isExpired(cached) && !this.#optimistic.has(href)) {
      const page = await cached.promise;
      if (this.#isReusable(href, page)) {
        return { fetched: false, page };
      }
    }
    const shared = search && this.#sharedPage(href, search);
    if (shared) {
      return { fetched: false, page: shared };
    }
    return { fetched: true, page: await this.#fetchConfirmed(href, signal, hmrRefresh) };
  }

  /** Whether the committed page can take `href` without loading: same path, and loader deps kept or `shallow`. */
  #inPlace(href: string, search: SearchParamsInput, shallow: boolean): boolean {
    const { href: committedHref, state } = this.#snapshot;
    return (
      state.match !== null &&
      !(state.error || state.notFound) &&
      !this.#optimistic.has(committedHref) &&
      (shallow
        ? pathnameOf(committedHref) === pathnameOf(href)
        : sharesLoaderDeps(state, committedHref, href, search))
    );
  }

  /** A cached page for another search of `href`'s path that reads the same loader deps. */
  #sharedPage(href: string, search: SearchParamsInput): FetchedPage | undefined {
    if (this.#optimistic.has(href)) {
      return;
    }
    for (const [cachedHref, entry] of this.#cache) {
      const page = entry.settled;
      if (
        page?.result.kind === "page" &&
        !isExpired(entry) &&
        this.#isReusable(cachedHref, page) &&
        sharesLoaderDeps(page.result.state, cachedHref, href, search)
      ) {
        return {
          ...page,
          result: { ...page.result, state: withSearch(page.result.state, search) },
        };
      }
    }
  }

  /** Publishes the committed page under the new URL and search; supersedes pending navigations. */
  #commitInPlace(href: string, kind: NavigationKind, search: SearchParamsInput): void {
    this.#beginUserNavigation()();
    this.#version += 1;
    this.#pendingAbort?.abort();
    this.#pendingAbort = null;
    const committedHref =
      kind.type === "push"
        ? this.#commitPush(
            {
              ...kind.request,
              // The page stays: keep the scroll position unless a hash asks to move.
              resetScroll: kind.request.resetScroll ?? href.includes("#"),
            },
            href,
            search
          )
        : this.#commitPop(kind.key, href, href, search);
    this.#publish({
      ...this.#snapshot,
      href: committedHref,
      isNavigating: false,
      pending: undefined,
      state: withSearch(this.#snapshot.state, search),
    });
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
      ({ page } = await this.#read(href, signal, false, undefined));
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
        ? this.#commitPush(kind.request, effective, state.data.query)
        : this.#commitPop(kind.key, effective, requestedHref, state.data.query);
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
  #commitPush(request: NavigateRequest, effective: string, search: unknown): string {
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
          _furinSearch: search,
        },
        "",
        physical
      );
    } else {
      if (this.#renderedHistoryKey) {
        saveScrollPosition(this.#renderedHistoryKey);
      }
      history.pushState({ _furinKey: generateHistoryKey(), _furinSearch: search }, "", physical);
    }
    this.#renderedHistoryKey = getHistoryKey(history.state);
    const url = new URL(physical, window.location.origin);
    return normalizeHref(toLogical(url.pathname, basePath)) + url.search;
  }

  /** Adopts the popped entry (canonicalised after redirects) and returns the committed logical href. */
  #commitPop(
    key: string | undefined,
    effective: string,
    requestedHref: string,
    search: unknown
  ): string {
    if (effective !== requestedHref) {
      history.replaceState(
        { ...historyStateObject(), _furinSearch: search },
        "",
        this.#config.basePath + effective
      );
    }
    this.#renderedHistoryKey = key;
    if (key) {
      this.#pendingScroll = { key, type: "restore" };
    }
    return normalizeHref(effective);
  }
}
