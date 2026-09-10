// biome-ignore-all lint/correctness/useJsxKeyInIterable: table cells receive stable column keys in DataTable
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type DevtoolsCacheEntry,
  type DevtoolsRoute,
  type DevtoolsServerEvent,
  type DevtoolsSnapshot,
  isDevtoolsServerEvent,
  isDevtoolsSnapshot,
} from "./protocol.ts";

const EVENT_NAME = "furin.devtools";
const MAX_EVENTS = 1000;
const TRAILING_SLASH = /\/$/;

type DashboardTab =
  | "cache"
  | "connections"
  | "hmr"
  | "loaders"
  | "payloads"
  | "requests"
  | "resources"
  | "routes";
type BuildEvent = Extract<DevtoolsServerEvent, { type: "hmr.build.finished" }>;
type ClientPhaseEvent = Extract<DevtoolsServerEvent, { type: "hmr.client.phase" }>;
type DevErrorEvent = Extract<DevtoolsServerEvent, { type: "dev.error" }>;
type DevReadyEvent = Extract<DevtoolsServerEvent, { type: "dev.ready" }>;
type FullReloadEvent = Extract<DevtoolsServerEvent, { type: "hmr.full-reload" }>;
type HmrCycleEvent = Extract<DevtoolsServerEvent, { type: "hmr.server.finished" }>;

const NAVIGATION: Array<{ id: DashboardTab; label: string }> = [
  { id: "hmr", label: "HMR" },
  { id: "requests", label: "Requests" },
  { id: "loaders", label: "Loaders" },
  { id: "cache", label: "Cache" },
  { id: "routes", label: "Routes" },
  { id: "payloads", label: "Payloads" },
  { id: "resources", label: "Resources" },
  { id: "connections", label: "Connections" },
];

function basePath(): string {
  return window.location.pathname.replace(TRAILING_SLASH, "");
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value < 1 ? `${value.toFixed(2)} ms` : `${value.toFixed(1)} ms`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function StatusDot({ state }: { state: "bad" | "idle" | "live" | "warn" }): ReactNode {
  return <span aria-hidden="true" className={`status-dot status-${state}`} />;
}

function cycleState(status: "fulfilled" | "rejected", reloaded: boolean): "bad" | "live" | "warn" {
  if (status === "rejected") {
    return "bad";
  }
  return reloaded ? "warn" : "live";
}

function cycleResult(reloaded: boolean, painted: boolean): string {
  if (reloaded) {
    return "Full reload";
  }
  return painted ? "Painted" : "Applying";
}

function EmptyState({ children, title }: { children: ReactNode; title: string }): ReactNode {
  return (
    <div className="empty-state">
      <span className="empty-glyph">◇</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function Metric({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: string;
}): ReactNode {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function PageHeader({
  count,
  description,
  title,
}: {
  count: number | null;
  description: string;
  title: string;
}): ReactNode {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">Furin runtime analysis</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {count === null ? null : <span className="count">{count}</span>}
    </header>
  );
}

function useDevtools(): {
  connected: boolean;
  connectionError: string | null;
  events: DevtoolsServerEvent[];
  refresh: () => Promise<void>;
  snapshot: DevtoolsSnapshot | null;
} {
  const [snapshot, setSnapshot] = useState<DevtoolsSnapshot | null>(null);
  const [events, setEvents] = useState<DevtoolsServerEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch(`${basePath()}/snapshot`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
    }
    const candidate: unknown = await response.json();
    if (!isDevtoolsSnapshot(candidate)) {
      return;
    }
    setSnapshot(candidate);
    setEvents(candidate.events);
  }, []);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = async (): Promise<void> => {
      try {
        const response = await fetch(`${basePath()}/snapshot`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
        }
        const candidate: unknown = await response.json();
        if (!isDevtoolsSnapshot(candidate)) {
          throw new Error("The development server returned an incompatible snapshot.");
        }
        if (disposed) {
          return;
        }
        setConnectionError(null);
        setSnapshot(candidate);
        setEvents(candidate.events);
        source = new EventSource(`${basePath()}/events?after=${candidate.lastEventId}`);
        source.addEventListener("open", () => setConnected(true));
        source.addEventListener("error", () => setConnected(false));
        source.addEventListener(EVENT_NAME, (event) => {
          try {
            const next: unknown = JSON.parse((event as MessageEvent<string>).data);
            if (!isDevtoolsServerEvent(next) || next.instanceId !== candidate.instance.id) {
              return;
            }
            setEvents((current) => {
              if (current.some((item) => item.id === next.id)) {
                return current;
              }
              const retained =
                next.type === "browser.resources"
                  ? current.filter(
                      (item) => item.type !== "browser.resources" || item.clientId !== next.clientId
                    )
                  : current;
              return [...retained, next].slice(-MAX_EVENTS);
            });
          } catch {
            // Ignore malformed diagnostics without taking down the dashboard.
          }
        });
        refreshTimer = setInterval(() => {
          if (document.visibilityState === "visible") {
            refresh().catch(() => undefined);
          }
        }, 5000);
      } catch (error) {
        if (disposed) {
          return;
        }
        setConnectionError(error instanceof Error ? error.message : String(error));
        retryTimer = setTimeout(() => {
          connect().catch(() => undefined);
        }, 500);
      }
    };
    connect().catch(() => undefined);
    return () => {
      disposed = true;
      source?.close();
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [refresh]);

  return { connected, connectionError, events, refresh, snapshot };
}

function findClientBuild(
  cycle: HmrCycleEvent,
  events: DevtoolsServerEvent[]
): BuildEvent | undefined {
  return events
    .filter(
      (event): event is BuildEvent =>
        event.type === "hmr.build.finished" && event.cycleId === cycle.cycleId
    )
    .at(-1);
}

function HmrWaterfall({
  after,
  before,
  clientBuild,
  cycle,
  paint,
}: {
  after: ClientPhaseEvent | undefined;
  before: ClientPhaseEvent | undefined;
  clientBuild: BuildEvent | undefined;
  cycle: HmrCycleEvent;
  paint: ClientPhaseEvent | undefined;
}): ReactNode {
  const detect = Math.max(0, (clientBuild?.startedAt ?? cycle.startedAt) - cycle.detectedAt);
  const clientBuildDuration =
    clientBuild?.durationMs ??
    Math.max(0, (before?.clientTimestamp ?? cycle.timestamp) - cycle.detectedAt - detect);
  const socket = Math.max(
    0,
    (before?.clientTimestamp ?? (clientBuild?.startedAt ?? cycle.startedAt) + clientBuildDuration) -
      ((clientBuild?.startedAt ?? cycle.startedAt) + clientBuildDuration)
  );
  const apply = Math.max(0, after?.durationMs ?? 0);
  const nextPaint = Math.max(0, (paint?.durationMs ?? apply) - apply);
  const stages = [
    { duration: detect, label: "Watcher → build" },
    {
      duration: clientBuildDuration,
      label: clientBuild ? "Client build" : "Build + socket",
    },
    { duration: socket, label: "Socket" },
    { duration: apply, label: "Apply" },
    { duration: nextPaint, label: "Next paint" },
  ];
  const total = Math.max(
    1,
    stages.reduce((sum, stage) => sum + stage.duration, 0)
  );

  return (
    <figure aria-label="HMR phase timings" className="waterfall">
      {stages.map((stage, index) => (
        <div className="waterfall-row" key={stage.label}>
          <span>{stage.label}</span>
          <div className="waterfall-track">
            <i
              style={{
                marginLeft: `${(stages.slice(0, index).reduce((sum, item) => sum + item.duration, 0) / total) * 100}%`,
                width: `${Math.max(1.5, (stage.duration / total) * 100)}%`,
              }}
            />
          </div>
          <strong>{formatDuration(stage.duration)}</strong>
        </div>
      ))}
    </figure>
  );
}

function HmrCycleList({
  builds,
  events,
  onSelect,
  selectedCycleId,
}: {
  builds: HmrCycleEvent[];
  events: DevtoolsServerEvent[];
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  selectedCycleId: string;
}): ReactNode {
  return (
    <aside aria-label="HMR cycles" className="cycle-list">
      {builds.map((build) => {
        const cyclePaint = events.findLast(
          (event) =>
            event.type === "hmr.client.phase" &&
            event.cycleId === build.cycleId &&
            event.phase === "paint"
        );
        const cycleReload = events.some(
          (event) => event.type === "hmr.full-reload" && event.cycleId === build.cycleId
        );
        return (
          <button
            className={build.cycleId === selectedCycleId ? "cycle active" : "cycle"}
            data-cycle-id={build.cycleId}
            key={build.cycleId}
            onClick={onSelect}
            type="button"
          >
            <StatusDot state={cycleState(build.status, cycleReload)} />
            <span>
              <strong>{basename(build.changedModules[0] ?? "Observed update")}</strong>
              <small>{cycleResult(cycleReload, cyclePaint !== undefined)}</small>
            </span>
            <time>{formatTime(build.timestamp)}</time>
          </button>
        );
      })}
    </aside>
  );
}

function unresolvedDevError(events: DevtoolsServerEvent[]): DevErrorEvent | undefined {
  const latestError = events
    .filter((event): event is DevErrorEvent => event.type === "dev.error")
    .at(-1);
  if (latestError === undefined) {
    return;
  }
  const latestReady = events
    .filter((event): event is DevReadyEvent => event.type === "dev.ready")
    .at(-1);
  return !latestReady || latestReady.timestamp < latestError.timestamp ? latestError : undefined;
}

function clientEventsForCycle(
  cycle: HmrCycleEvent | null,
  events: DevtoolsServerEvent[]
): ClientPhaseEvent[] {
  if (!cycle) {
    return [];
  }
  return events.filter(
    (event): event is ClientPhaseEvent =>
      event.type === "hmr.client.phase" && event.cycleId === cycle.cycleId
  );
}

function HmrPanel({
  events,
  snapshot,
}: {
  events: DevtoolsServerEvent[];
  snapshot: DevtoolsSnapshot;
}): ReactNode {
  const builds = useMemo(
    () =>
      events
        .filter((event): event is HmrCycleEvent => event.type === "hmr.server.finished")
        .toReversed(),
    [events]
  );
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const selectCycle = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
    setSelectedCycleId(event.currentTarget.dataset.cycleId ?? null);
  }, []);
  const selected =
    builds.find((build) => build.cycleId === selectedCycleId) ?? builds.at(0) ?? null;
  const clientEvents = clientEventsForCycle(selected, events);
  const before = clientEvents.findLast((event) => event.phase === "before-update");
  const after = clientEvents.findLast((event) => event.phase === "after-update");
  const paint = clientEvents.findLast((event) => event.phase === "paint");
  const reload =
    selected === null
      ? undefined
      : events.findLast(
          (event): event is FullReloadEvent =>
            event.type === "hmr.full-reload" && event.cycleId === selected.cycleId
        );
  const clientBuild = selected === null ? undefined : findClientBuild(selected, events);
  const total =
    selected === null
      ? null
      : Math.max(
          selected.durationMs,
          (paint?.clientTimestamp ?? selected.timestamp) - selected.detectedAt
        );
  const connection = events.findLast((event) => event.type === "hmr.connection.changed");
  const unresolvedError = unresolvedDevError(events);

  return (
    <>
      <PageHeader
        count={builds.length}
        description="Every source change traced from detection through Bun, transport, application and the next paint opportunity."
        title="Hot module replacement"
      />
      <section className="metrics-grid">
        <Metric
          detail={connection ? `browser ${connection.clientId.slice(0, 8)}` : "waiting for app"}
          label="HMR connection"
          value={connection?.state ?? "unknown"}
        />
        <Metric
          detail={selected ? basename(selected.changedModules[0] ?? "unknown") : "no build yet"}
          label="Last cycle"
          value={formatDuration(total)}
        />
        <Metric
          detail={`${snapshot.runtime.graph.edges} import edges`}
          label="Furin graph"
          value={`${snapshot.runtime.graph.modules} modules`}
        />
        <Metric
          detail={`${formatBytes(snapshot.runtime.memory.heapBytes)} JS heap`}
          label="Server RSS"
          value={formatBytes(snapshot.runtime.memory.rssBytes)}
        />
      </section>
      {unresolvedError ? (
        <div className="error-callout">
          <StatusDot state="bad" />
          <div>
            <strong>
              {unresolvedError.error.phase} · {unresolvedError.error.message}
            </strong>
            <p>
              {unresolvedError.error.file ?? unresolvedError.error.route}
              {unresolvedError.error.line ? `:${unresolvedError.error.line}` : ""}
            </p>
          </div>
        </div>
      ) : null}
      {selected === null ? (
        <EmptyState title="Waiting for a source change">
          Open the application, edit a route or one of its dependencies, then save the file.
        </EmptyState>
      ) : (
        <div className="hmr-layout">
          <HmrCycleList
            builds={builds}
            events={events}
            onSelect={selectCycle}
            selectedCycleId={selected.cycleId}
          />
          <section className="cycle-detail">
            <div className="cycle-heading">
              <div>
                <p className="eyebrow">Cycle {selected.cycleId}</p>
                <h2>{selected.changedModules[0] ?? "Observed client update"}</h2>
              </div>
              <strong>{formatDuration(total)}</strong>
            </div>
            <HmrWaterfall
              after={after}
              before={before}
              clientBuild={clientBuild}
              cycle={selected}
              paint={paint}
            />
            {reload ? (
              <div className="reload-callout">
                <StatusDot state="warn" />
                <div>
                  <strong>Full reload · {reload.reason.replaceAll("-", " ")}</strong>
                  <p>
                    The event was persisted before navigation so the reason remains inspectable.
                  </p>
                </div>
              </div>
            ) : null}
            <div className="detail-grid">
              <article className="detail-card">
                <div className="card-title">
                  <h3>Invalidated by</h3>
                  <span>{selected.changedModules.length}</span>
                </div>
                <ModuleList modules={selected.changedModules} />
              </article>
              <article className="detail-card">
                <div className="card-title">
                  <h3>Client modules observed</h3>
                  <span>{clientBuild?.rebuiltModules.length ?? 0}</span>
                </div>
                <ModuleList modules={clientBuild?.rebuiltModules ?? []} />
                <p className="precision-note">
                  Bun exposes plugin loads but not its private incremental graph.
                </p>
              </article>
              <article className="detail-card">
                <div className="card-title">
                  <h3>Server modules rebuilt</h3>
                  <span>{selected.rebuiltModules.length}</span>
                </div>
                <ModuleList modules={selected.rebuiltModules} />
              </article>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ModuleList({ modules }: { modules: string[] }): ReactNode {
  if (modules.length === 0) {
    return <p className="muted">No module reported for this phase.</p>;
  }
  return (
    <ul className="module-list">
      {modules.map((module) => (
        <li key={module}>
          <span>↳</span>
          <code>{module}</code>
        </li>
      ))}
    </ul>
  );
}

function DataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<{ cells: ReactNode[]; id: string }>;
}): ReactNode {
  if (rows.length === 0) {
    return (
      <EmptyState title="No data collected">
        Keep this page open while exercising the application.
      </EmptyState>
    );
  }
  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell, index) => (
                <td key={columns[index]}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestsPanel({ events }: { events: DevtoolsServerEvent[] }): ReactNode {
  const requests = events.filter((event) => event.type === "request.finished").toReversed();
  return (
    <>
      <PageHeader
        count={requests.length}
        description="Completed server requests correlated with loader, cache and payload activity."
        title="Requests"
      />
      <DataTable
        columns={["Path", "Status", "Duration", "Time"]}
        rows={requests.map((event) => ({
          cells: [
            <code>{event.path}</code>,
            <span className={event.status >= 400 ? "tone-bad" : "tone-live"}>{event.status}</span>,
            formatDuration(event.durationMs),
            <time>{formatTime(event.timestamp)}</time>,
          ],
          id: String(event.id),
        }))}
      />
    </>
  );
}

function LoadersPanel({ events }: { events: DevtoolsServerEvent[] }): ReactNode {
  const loaders = events.filter((event) => event.type === "loader.finished").toReversed();
  return (
    <>
      <PageHeader
        count={loaders.length}
        description="Execution time and returned field names. Loader values never leave the server."
        title="Loaders"
      />
      <DataTable
        columns={["Loader", "Route", "Result", "Duration", "Fields"]}
        rows={loaders.map((event) => ({
          cells: [
            <code>{event.loader}</code>,
            <code>{event.path}</code>,
            <span className={event.status === "fulfilled" ? "tone-live" : "tone-bad"}>
              {event.status}
            </span>,
            formatDuration(event.durationMs),
            event.fieldNames.join(", ") || "—",
          ],
          id: String(event.id),
        }))}
      />
    </>
  );
}

function CachePanel({
  caches,
  events,
}: {
  caches: DevtoolsCacheEntry[];
  events: DevtoolsServerEvent[];
}): ReactNode {
  const accesses = events
    .filter((event) => event.type === "cache.access" || event.type === "cache.invalidated")
    .toReversed();
  return (
    <>
      <PageHeader
        count={caches.length}
        description="Current ISR and SSG loader entries, freshness decisions and invalidations."
        title="Cache"
      />
      <section className="metrics-grid compact">
        <Metric
          detail="loader snapshots"
          label="Fresh"
          value={String(caches.filter((entry) => entry.isFresh).length)}
        />
        <Metric
          detail="awaiting regeneration"
          label="Stale"
          value={String(caches.filter((entry) => !entry.isFresh).length)}
        />
        <Metric detail="retained decisions" label="Activity" value={String(accesses.length)} />
      </section>
      <DataTable
        columns={["Path", "Mode", "Age", "Revalidate", "Dependencies"]}
        rows={caches.map((entry) => ({
          cells: [
            <code>{entry.path}</code>,
            entry.mode.toUpperCase(),
            formatDuration(entry.ageMs),
            entry.revalidateSeconds === null ? "never" : `${entry.revalidateSeconds}s`,
            String(entry.dependencies.length),
          ],
          id: entry.id,
        }))}
      />
    </>
  );
}

function RoutesPanel({ routes }: { routes: DevtoolsRoute[] }): ReactNode {
  return (
    <>
      <PageHeader
        count={routes.length}
        description="Discovered files, rendering strategy and server data capabilities."
        title="Routes"
      />
      <DataTable
        columns={["Pattern / file", "Mode", "Data", "Tags"]}
        rows={routes.map((route) => ({
          cells: [
            <span className="stacked-cell">
              <code>{route.pattern}</code>
              <small>{route.file}</small>
            </span>,
            <span className={`mode mode-${route.mode}`}>{route.mode}</span>,
            `${route.hasLoader ? "loader" : "—"}${route.hasRequestLoader ? " + request" : ""}`,
            route.tags.join(", ") || "—",
          ],
          id: route.file,
        }))}
      />
    </>
  );
}

function PayloadsPanel({ events }: { events: DevtoolsServerEvent[] }): ReactNode {
  const payloads = events.filter((event) => event.type === "payload.serialized").toReversed();
  return (
    <>
      <PageHeader
        count={payloads.length}
        description="Serialized route-data and RSC payload sizes emitted by the server."
        title="Payloads"
      />
      <DataTable
        columns={["Path", "Kind", "Size", "Time"]}
        rows={payloads.map((event) => ({
          cells: [
            <code>{event.path}</code>,
            event.kind,
            formatBytes(event.bytes),
            <time>{formatTime(event.timestamp)}</time>,
          ],
          id: String(event.id),
        }))}
      />
    </>
  );
}

function ResourcesPanel({ events }: { events: DevtoolsServerEvent[] }): ReactNode {
  const latest = events.filter((event) => event.type === "browser.resources").at(-1);
  const resources = latest?.resources ?? [];
  return (
    <>
      <PageHeader
        count={resources.length}
        description="Resource Timing values reported by the most recently active application tab."
        title="Browser resources"
      />
      <DataTable
        columns={["Resource", "Type", "Transferred", "Decoded", "Duration"]}
        rows={resources.map((resource, index) => ({
          cells: [
            <code>{resource.name}</code>,
            resource.type,
            formatBytes(resource.transferredBytes),
            formatBytes(resource.decodedBytes),
            formatDuration(resource.durationMs),
          ],
          id: `${resource.name}:${index}`,
        }))}
      />
    </>
  );
}

function ConnectionsPanel({ events }: { events: DevtoolsServerEvent[] }): ReactNode {
  const browserStates = new Map<
    string,
    Extract<DevtoolsServerEvent, { type: "hmr.connection.changed" }>
  >();
  for (const event of events) {
    if (event.type === "hmr.connection.changed") {
      browserStates.set(event.clientId, event);
    }
  }
  const sync = events.filter((event) => event.type === "sync.connection.changed").toReversed();
  return (
    <>
      <PageHeader
        count={browserStates.size}
        description="Native Bun HMR and Furin sync transport state by application tab."
        title="Connections"
      />
      <DataTable
        columns={["Browser tab", "HMR state", "Last change"]}
        rows={[...browserStates.values()].map((event) => ({
          cells: [
            <code>{event.clientId}</code>,
            <span className={event.state === "connected" ? "tone-live" : "tone-bad"}>
              {event.state}
            </span>,
            <time>{formatTime(event.timestamp)}</time>,
          ],
          id: event.clientId,
        }))}
      />
      {sync.length === 0 ? null : (
        <>
          <h2 className="section-title">Sync transport</h2>
          <DataTable
            columns={["Browser tab", "State", "Cursor", "Time"]}
            rows={sync.map((event) => ({
              cells: [
                <code>{event.clientId}</code>,
                event.state,
                event.cursor ?? "—",
                <time>{formatTime(event.timestamp)}</time>,
              ],
              id: String(event.id),
            }))}
          />
        </>
      )}
    </>
  );
}

function ActivePanel({
  events,
  snapshot,
  tab,
}: {
  events: DevtoolsServerEvent[];
  snapshot: DevtoolsSnapshot;
  tab: DashboardTab;
}): ReactNode {
  if (tab === "hmr") {
    return <HmrPanel events={events} snapshot={snapshot} />;
  }
  if (tab === "requests") {
    return <RequestsPanel events={events} />;
  }
  if (tab === "loaders") {
    return <LoadersPanel events={events} />;
  }
  if (tab === "cache") {
    return <CachePanel caches={snapshot.caches} events={events} />;
  }
  if (tab === "routes") {
    return <RoutesPanel routes={snapshot.routes} />;
  }
  if (tab === "payloads") {
    return <PayloadsPanel events={events} />;
  }
  if (tab === "resources") {
    return <ResourcesPanel events={events} />;
  }
  return <ConnectionsPanel events={events} />;
}

function Dashboard(): ReactNode {
  const { connected, connectionError, events, refresh, snapshot } = useDevtools();
  const [tab, setTab] = useState<DashboardTab>("hmr");
  const selectTab = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
    const selectedTab = event.currentTarget.dataset.tab as DashboardTab | undefined;
    if (selectedTab) {
      setTab(selectedTab);
    }
  }, []);
  const refreshSnapshot = useCallback((): void => {
    refresh().catch(() => undefined);
  }, [refresh]);

  if (snapshot === null) {
    return (
      <main className="boot-screen">
        <span className="brand-mark">F</span>
        <p>Connecting to the Furin development runtime…</p>
        {connectionError ? <small>{connectionError} Retrying automatically.</small> : null}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">F</span>
          <div>
            <strong>Furin</strong>
            <small>Development control room</small>
          </div>
        </div>
        <nav aria-label="DevTools sections">
          {NAVIGATION.map((item, index) => (
            <button
              className={tab === item.id ? "active" : ""}
              data-tab={item.id}
              key={item.id}
              onClick={selectTab}
              type="button"
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>
            <StatusDot state={connected ? "live" : "bad"} />
            {connected ? "Event stream live" : "Reconnecting"}
          </span>
          <code>#{snapshot.instance.id.slice(0, 8)}</code>
        </div>
      </aside>
      <main className="workspace">
        <div className="topbar">
          <span>
            Instance <code>{snapshot.instance.prefix || "/"}</code>
          </span>
          <span>Protocol v{snapshot.version}</span>
          <button onClick={refreshSnapshot} type="button">
            Refresh snapshot
          </button>
        </div>
        <div className="canvas">
          <ActivePanel events={events} snapshot={snapshot} tab={tab} />
        </div>
      </main>
    </div>
  );
}

export function mountDevtoolsDashboard(element: HTMLElement): () => void {
  const root = createRoot(element);
  root.render(<Dashboard />);
  return () => root.unmount();
}

const dashboardRoot = document.getElementById("furin-devtools-root");
if (dashboardRoot) {
  mountDevtoolsDashboard(dashboardRoot);
}
