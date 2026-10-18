import { type Context, Elysia, ValidationError } from "elysia";
import type { RequestLogger } from "evlog";
import type { HeadOptions, RenderingMode } from "./client.ts";
import { applySchemaDefaults, coerceRouteInput } from "./server/router/schemas.ts";
import type { FurinSchema, FurinUnwrap, FurinUnwrapInput } from "./shared/elysia-contract.ts";
import { getSchemaValidator, isTypeBoxObjectSchema } from "./shared/elysia-contract.ts";
import type { RemountDependency, RemountDeps } from "./shared/page-key.ts";

type NoFields = NonNullable<unknown>;
type Awaitable<T> = Promise<T> | T;
export const FURIN_RENDER_DECORATOR = "$furinRender";

export interface FurinNativeRouteContext {
  params: unknown;
  query: unknown;
  request: Request;
  [key: string]: unknown;
}

export type FurinRouteDispatcher = (context: FurinNativeRouteContext) => unknown;

interface LoaderData {
  [key: string]: unknown;
}
type ReservedRenderContextKey =
  | "catch"
  | "children"
  | "finally"
  | "key"
  | "params"
  | "path"
  | "query"
  | "ref"
  | "then"
  | "toJSON";
type PublicLoaderData = LoaderData & {
  [Key in ReservedRenderContextKey]?: never;
} & {
  [Key in `__furin${string}`]?: never;
};
type RequestLoaderData = PublicLoaderData & {
  [Key in keyof Context | "log"]?: never;
};
interface SchemaValues {
  [key: string]: unknown;
}
type ParamsOf<Schema extends FurinSchema | undefined> = Schema extends FurinSchema
  ? FurinUnwrap<Schema>
  : NoFields;
type SearchInputOf<Schema extends FurinSchema | undefined> = Schema extends FurinSchema
  ? FurinUnwrapInput<Schema>
  : NoFields;
declare const privateFieldBrand: unique symbol;
declare const ssrFieldBrand: unique symbol;
declare const inheritedDataBrand: unique symbol;
declare const loaderDataBrand: unique symbol;
declare const routeContractBrand: unique symbol;
declare const layoutRouteBrand: unique symbol;
declare const noRequestLoader: unique symbol;
type PrivateField<Value> = Promise<Value> & { readonly [privateFieldBrand]: true };
interface SsrField<Value> {
  readonly [ssrFieldBrand]: Value;
}
type UnwrapSsrField<Value> = Value extends SsrField<infer Data> ? Data : Value;
type RenderParentData<Data extends LoaderData> = {
  [Key in keyof Data]: UnwrapSsrField<Data[Key]>;
};
type SsrParentData<Data extends LoaderData> = PublicParentData<Data> & {
  [Key in keyof Data as Data[Key] extends SsrField<unknown>
    ? Key
    : never]: Data[Key] extends SsrField<infer Value> ? Value : never;
};
type SsrLoaderParentData<Data extends LoaderData> = SsrParentData<Data> & {
  [Key in keyof Data as Data[Key] extends PrivateField<unknown>
    ? Key
    : never]: Data[Key] extends PrivateField<infer Value> ? Value : never;
};
interface NoRequestLoader extends LoaderData {
  readonly [noRequestLoader]: never;
}
type PublicParentData<Data extends LoaderData> = Omit<
  Data,
  {
    [Key in keyof Data]: Data[Key] extends
      | PrivateField<unknown>
      | SsrField<unknown>
      | { parentType: PrivateField<unknown> }
      | { parentType: SsrField<unknown> }
      | { loaderType: PrivateField<unknown> }
      | { loaderType: SsrField<unknown> }
      ? Key
      : never;
  }[keyof Data]
>;
type RequestDataOfRoute<Route> = Route extends { requestLoader: infer RequestLoaderFn }
  ? NonNullable<RequestLoaderFn> extends (...args: never[]) => infer Result
    ? Awaited<Result> extends NoRequestLoader
      ? NoFields
      : Awaited<Result>
    : NoFields
  : NoFields;
type InheritedDataOfRoute<Route> = Route extends {
  readonly [inheritedDataBrand]?: infer Data;
}
  ? NonNullable<Data> extends LoaderData
    ? NonNullable<Data>
    : NoFields
  : NoFields;
type OwnDataOfRoute<Route> = Route extends { loader: (...args: never[]) => infer Result }
  ? Awaited<Result> extends LoaderData
    ? Awaited<Result>
    : NoFields
  : NoFields;
type DataOfRoute<Route> = WithoutParentDataConflicts<
  WithoutParentDataConflicts<
    InheritedDataOfRoute<Route>,
    "ssr" extends (Route extends { mode: infer Mode } ? Mode : never)
      ? { [Key in keyof OwnDataOfRoute<Route>]: SsrField<OwnDataOfRoute<Route>[Key]> }
      : OwnDataOfRoute<Route>
  >,
  {
    [Key in keyof RequestDataOfRoute<Route>]: PrivateField<Awaited<RequestDataOfRoute<Route>[Key]>>;
  }
>;
type PromisedData<Data extends LoaderData> = {
  [Key in keyof Data]: Promise<Awaited<Data[Key]>>;
};

export interface RequestLoaderContext<Params = NoFields, Query = NoFields> {
  readonly cookies: { get: (name: string) => unknown };
  readonly headers: {
    entries: () => IterableIterator<[string, string]>;
    get: (name: string) => string | null;
    has: (name: string) => boolean;
  };
  readonly log: RequestLogger;
  readonly params: Params;
  readonly path: string;
  readonly query: Query;
  readonly request: Request;
}

interface SharedRouteConfig {
  tags?: readonly string[];
}

type RenderingConfig = SharedRouteConfig &
  (
    | {
        mode: "ssr";
        revalidate?: never;
      }
    | {
        mode: "ssg";
        revalidate?: never;
      }
    | {
        mode: "isr";
        revalidate: number;
      }
  );

export type DefineRouteConfig<Params = NoFields, Query = NoFields> = RenderingConfig & {
  remountDeps?: RemountDeps<Params, Query>;
};

type ConfigFor<Params, Query> = DefineRouteConfig<Params, Query>;

type StaticParamsContext<ParentParams, ParentData extends LoaderData> = {
  params: Partial<ParentParams>;
} & PromisedData<PublicParentData<ParentData>>;

type StaticParamsResult<Params, ParentParams> = Omit<Params, keyof ParentParams> & Partial<Params>;

type StaticParams<Params, ParentParams, ParentData extends LoaderData> = (
  context: StaticParamsContext<ParentParams, ParentData>
) => Awaitable<readonly StaticParamsResult<Params, ParentParams>[]>;

interface ErasedStaticParamsContext {
  params: unknown;
  [key: string]: unknown;
}

type RouteMetadata = RenderingConfig & {
  remountDeps?: (context: never) => readonly RemountDependency[];
  staticParams?: (context: ErasedStaticParamsContext) => Awaitable<readonly unknown[]>;
};

type PublicLoaderContext<Params, Query> = {
  params: Params;
  query: Query;
  path: string;
  log: RequestLogger;
} & Pick<Context, "redirect">;

type LoaderContext<
  Params,
  Query,
  ParentData extends LoaderData,
  Mode extends RenderingMode = "ssr",
> = (Mode extends "ssr"
  ? {
      params: Params;
      query: Query;
      log: RequestLogger;
    } & Omit<Context<{ params: Params; query: Query }>, "params" | "query">
  : PublicLoaderContext<Params, Query>) &
  PromisedData<Mode extends "ssr" ? SsrLoaderParentData<ParentData> : PublicParentData<ParentData>>;

/** Carries a readable message into a compile error for a forbidden builder transition. */
interface FurinTypeError<Message extends string> {
  readonly "~furinError": Message;
}

type PageRequestLoaderCheck<
  Mode extends RenderingMode,
  RequestData extends LoaderData,
  ValidComponent,
> = Mode extends "ssr"
  ? RequestData extends NoRequestLoader
    ? ValidComponent
    : FurinTypeError<"SSR pages cannot declare requestLoader(); use loader() and defer()">
  : ValidComponent;

type Loader<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode = "ssr",
> = (context: LoaderContext<Params, Query, ParentData, Mode>) => Awaitable<Data>;

type RequestDataContext<RequestData extends LoaderData> = RequestData extends NoRequestLoader
  ? NoFields
  : PromisedData<RequestData>;

type RequestLoader<Params, Query, Data extends LoaderData> = (
  context: RequestLoaderContext<Params, Query>
) => Awaitable<Data>;

/**
 * Same-name parent/loader fields whose types are incompatible map to a
 * readable branded error object; compatible overrides (same-type) map to
 * `never` and are dropped from the mapped type.
 */
type ParentDataConflicts<ParentData extends LoaderData, Data extends LoaderData> = {
  [Key in keyof Data & keyof ParentData as UnwrapSsrField<Data[Key]> extends UnwrapSsrField<
    ParentData[Key]
  >
    ? never
    : Key]: {
    __furinConflict: "this loader key overwrites a parent loader key with an incompatible type";
    parentType: ParentData[Key];
    loaderType: Data[Key];
  };
};

type WithoutParentDataConflicts<ParentData extends LoaderData, Data extends LoaderData> = Omit<
  ParentData,
  keyof Data
> &
  Omit<Data, keyof ParentDataConflicts<ParentData, Data>> &
  ParentDataConflicts<ParentData, Data>;

type RenderLoaderData<
  ParentData extends LoaderData,
  Data extends LoaderData,
> = WithoutParentDataConflicts<RenderParentData<ParentData>, Data>;

type RenderContext<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> = {
  params: Params;
  path: string;
  query: Query;
} & WithoutParentDataConflicts<RenderLoaderData<ParentData, Data>, RequestDataContext<RequestData>>;

type Component<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> = (props: RenderContext<Params, Query, ParentData, Data, RequestData>) => React.ReactNode;

type LayoutComponent<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> = (
  props: RenderContext<Params, Query, ParentData, Data, RequestData> & {
    children: React.ReactNode;
  }
) => React.ReactNode;

type Head<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode,
> = (
  context: RenderContext<
    Params,
    Query,
    Mode extends "ssr" ? SsrParentData<ParentData> : PublicParentData<ParentData>,
    Data,
    NoFields
  >
) => HeadOptions;

export function getFurinRenderer(context: object): FurinRouteDispatcher | undefined {
  const renderer = (context as { $furinRender?: unknown })[FURIN_RENDER_DECORATOR];
  return typeof renderer === "function" ? (renderer as FurinRouteDispatcher) : undefined;
}

const OUTSIDE_FURIN_ERROR =
  "[furin] route.elysia must be mounted through furin(); it has no renderer outside the Furin plugin.";

function renderRoute(context: object): unknown {
  const renderer = getFurinRenderer(context);
  if (!renderer) {
    throw new Error(OUTSIDE_FURIN_ERROR);
  }
  return renderer(context as unknown as FurinNativeRouteContext);
}

function registerPlain() {
  return new Elysia().get("", renderRoute);
}

function registerSchema<
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
>(paramsSchema: ParamsSchema, querySchema: QuerySchema) {
  return new Elysia().get("", { params: paramsSchema, query: querySchema }, renderRoute);
}

function registerQuery<QuerySchema extends FurinSchema>(querySchema: QuerySchema) {
  return new Elysia().get("", { query: querySchema }, renderRoute);
}

function schemaValues(value: unknown): SchemaValues {
  return value !== null && typeof value === "object" ? (value as SchemaValues) : {};
}

function selectLayoutSchemaValues(schema: FurinSchema, value: unknown): SchemaValues {
  const values = schemaValues(value);
  if (!isTypeBoxObjectSchema(schema)) {
    return values;
  }
  const { properties } = schema;
  if (properties === null || typeof properties !== "object") {
    return values;
  }
  const selected: SchemaValues = {};
  for (const key of Object.keys(properties)) {
    if (key in values) {
      selected[key] = values[key];
    }
  }
  return selected;
}

async function validateLayoutSchema(
  type: "params" | "query",
  schema: FurinSchema,
  value: unknown
): Promise<SchemaValues> {
  const selectedValues = selectLayoutSchemaValues(schema, value);
  const selected = isTypeBoxObjectSchema(schema)
    ? coerceRouteInput(schema, applySchemaDefaults(schema, selectedValues))
    : selectedValues;
  const validator = getSchemaValidator(schema);
  if (validator?.Check(selected) === false) {
    throw new ValidationError(type, selected, [...validator.Errors(selected)], schema);
  }
  const parsed = await validator?.parse(selected, type);
  return { ...schemaValues(value), ...schemaValues(parsed) };
}

function registerLayout(
  paramsSchema: FurinSchema | undefined,
  querySchema: FurinSchema | undefined
) {
  const app = new Elysia();
  if (paramsSchema || querySchema) {
    app.derive(async (context) => ({
      params: paramsSchema
        ? await validateLayoutSchema("params", paramsSchema, context.params)
        : context.params,
      query: querySchema
        ? await validateLayoutSchema("query", querySchema, context.query)
        : context.query,
    }));
  }
  return app;
}

function withStaticParams<Params, ParentParams, ParentData extends LoaderData>(
  metadata: RouteMetadata,
  staticParams: StaticParams<Params, ParentParams, ParentData>,
  hasRequestLoader: boolean
): RouteMetadata {
  if (metadata.mode === "ssr") {
    throw new TypeError("[furin] staticParams() requires mode ssg or isr.");
  }
  if (hasRequestLoader) {
    throw new TypeError("[furin] staticParams() must be declared before requestLoader().");
  }
  if (metadata.staticParams) {
    throw new TypeError("[furin] staticParams() can only be declared once.");
  }
  return { ...metadata, staticParams: staticParams as RouteMetadata["staticParams"] };
}

function assertStaticParamsOutsideConfig(options: object): void {
  if ("staticParams" in options) {
    throw new TypeError("[furin] staticParams() must be chained after config().");
  }
}

function assertPageRequestLoaderMode(metadata: RouteMetadata, requestLoader: unknown): void {
  if (metadata.mode === "ssr" && requestLoader !== undefined) {
    throw new TypeError(
      "[furin] SSR pages cannot declare requestLoader(); use loader() and defer()."
    );
  }
}

/**
 * Phantom type state threaded through the single route builder. Each stage
 * method returns the same `RouteChain` class narrowed with `Pick`/`Omit`, so
 * the builder has one runtime implementation and one source of inference.
 */
interface ChainState {
  /** Own public loader data (`NoFields` until `loader()`). */
  data: LoaderData;
  loaded: boolean;
  mode: RenderingMode;
  params: unknown;
  parentData: LoaderData;
  parentParams: unknown;
  query: unknown;
  requestData: LoaderData;
  /** Shape of the runtime `schemas` field exposed on the route terminal. */
  schemas: RouteSchemas | undefined;
  /** Navigation input for the resolved query (schema input side). */
  search: unknown;
}

type RouteSchemas =
  | { query: FurinSchema }
  | { params: FurinSchema; query: FurinSchema | undefined };

type WithState<State extends ChainState, Patch extends Partial<ChainState>> = {
  [Key in keyof ChainState]: Key extends keyof Patch ? Patch[Key] : State[Key];
};

interface InitialState<
  Params,
  Query,
  Search,
  Schemas extends RouteSchemas | undefined,
  ParentData extends LoaderData,
  ParentParams,
  Mode extends RenderingMode,
> {
  data: NoFields;
  loaded: false;
  mode: Mode;
  params: Params;
  parentData: ParentData;
  parentParams: ParentParams;
  query: Query;
  requestData: NoRequestLoader;
  schemas: Schemas;
  search: Search;
}

/**
 * Resolved public contract of a route: its layouts' params/query merged with
 * its own (child overrides parent, as `mergeRouteSchemas()` does at runtime),
 * plus the navigation input side of the resolved query.
 */
interface RouteContract {
  params: unknown;
  query: unknown;
  search: unknown;
}

interface EmptyContract {
  params: NoFields;
  query: NoFields;
  search: NoFields;
}

type ContractOf<Route> = Route extends { readonly [routeContractBrand]?: infer Contract }
  ? NonNullable<Contract> extends RouteContract
    ? NonNullable<Contract>
    : EmptyContract
  : EmptyContract;

type Flatten<Value> = { [Key in keyof Value]: Value[Key] };

type MergeSchemaValues<Parent, Child> = keyof Child extends never
  ? Parent
  : keyof Parent extends never
    ? Child
    : Flatten<Omit<Parent, keyof Child> & Child>;

type ResolvedConfig<
  Parent extends RouteContract,
  ParamsSchema extends FurinSchema | undefined,
  QuerySchema extends FurinSchema | undefined,
> = ConfigFor<
  MergeSchemaValues<Parent["params"], ParamsOf<ParamsSchema>>,
  MergeSchemaValues<Parent["query"], ParamsOf<QuerySchema>>
>;

type ConfiguredRoute<
  Parent extends RouteContract,
  ParentData extends LoaderData,
  ParamsSchema extends FurinSchema | undefined,
  QuerySchema extends FurinSchema | undefined,
  Schemas extends RouteSchemas | undefined,
  Mode extends RenderingMode,
> = ConfiguredStage<
  InitialState<
    MergeSchemaValues<Parent["params"], ParamsOf<ParamsSchema>>,
    MergeSchemaValues<Parent["query"], ParamsOf<QuerySchema>>,
    MergeSchemaValues<Parent["search"], SearchInputOf<QuerySchema>>,
    Schemas,
    ParentData,
    Parent["params"],
    Mode
  >
>;

interface ChainRuntime {
  head: unknown;
  loader: unknown;
  metadata: RouteMetadata;
  paramsSchema: FurinSchema | undefined;
  querySchema: FurinSchema | undefined;
  requestLoader: unknown;
}

// Named stages keep compile errors readable, e.g. "Property 'staticParams'
// does not exist on type 'SsrRouteStage<...>'".

/** SSR routes render per request: `staticParams()` needs mode `ssg` or `isr`. */
interface SsrRouteStage<State extends ChainState> extends Omit<RouteChain<State>, "staticParams"> {}

/** `staticParams()` must come first and only once, before `requestLoader()`. */
interface StaticParamsClosedStage<State extends ChainState>
  extends Omit<RouteChain<State>, "staticParams"> {}

/** After `loader()`: attach `head()` or finish with `page()`/`layout()`. */
interface LoadedRouteStage<State extends ChainState>
  extends Pick<RouteChain<State>, "head" | "layout" | "page"> {}

/** `head()` metadata is page-only: a headed route can only finish with `page()`. */
interface HeadedPageStage<State extends ChainState> extends Pick<RouteChain<State>, "page"> {}

type ConfiguredStage<State extends ChainState> = State["mode"] extends infer Mode
  ? Mode extends "ssr"
    ? SsrRouteStage<State>
    : RouteChain<State>
  : never;

type ElysiaOfSchemas<Schemas> = Schemas extends {
  params: infer ParamsSchema extends FurinSchema;
  query: infer QuerySchema extends FurinSchema | undefined;
}
  ? ReturnType<typeof registerSchema<ParamsSchema, QuerySchema>>
  : Schemas extends { query: infer QuerySchema extends FurinSchema }
    ? ReturnType<typeof registerQuery<QuerySchema>>
    : ReturnType<typeof registerPlain>;

type RouteTerminal<State extends ChainState> = {
  __type: "FURIN_ROUTE";
  head:
    | Head<State["params"], State["query"], State["parentData"], State["data"], State["mode"]>
    | undefined;
  mode: State["mode"];
  readonly [inheritedDataBrand]?: State["parentData"];
  readonly [loaderDataBrand]?: RenderLoaderData<State["parentData"], State["data"]>;
  readonly [routeContractBrand]?: {
    params: State["params"];
    query: State["query"];
    search: State["search"];
  };
  remountDeps: RouteMetadata["remountDeps"];
  requestLoader: RequestLoader<State["params"], State["query"], State["requestData"]> | undefined;
  revalidate: number | undefined;
  staticParams: RouteMetadata["staticParams"];
  tags: readonly string[] | undefined;
} & (State["loaded"] extends true
  ? {
      loader: Loader<
        State["params"],
        State["query"],
        State["parentData"],
        State["data"],
        State["mode"]
      >;
    }
  : NoFields) &
  (State["schemas"] extends RouteSchemas ? { schemas: State["schemas"] } : NoFields);

type PageComponentOf<State extends ChainState> = Component<
  State["params"],
  State["query"],
  State["parentData"],
  State["data"],
  State["requestData"]
>;

type LayoutComponentOf<State extends ChainState> = LayoutComponent<
  State["params"],
  State["query"],
  State["parentData"],
  State["data"],
  State["requestData"]
>;

type PageTerminal<State extends ChainState> = RouteTerminal<State> & {
  component: PageComponentOf<State>;
  elysia: ElysiaOfSchemas<State["schemas"]>;
  page: PageComponentOf<State>;
};

/** Type-only brand: `config({ layout })` accepts routes built with `.layout()`. */
export interface FurinLayoutRoute {
  readonly [layoutRouteBrand]: true;
}

type LayoutTerminal<State extends ChainState> = RouteTerminal<State> &
  FurinLayoutRoute & {
    component: LayoutComponentOf<State>;
    elysia: ReturnType<typeof registerLayout>;
    layout: LayoutComponentOf<State>;
  };

function registerPage(
  paramsSchema: FurinSchema | undefined,
  querySchema: FurinSchema | undefined
): unknown {
  if (paramsSchema !== undefined) {
    return registerSchema(paramsSchema, querySchema);
  }
  return querySchema === undefined ? registerPlain() : registerQuery(querySchema);
}

function schemaFields(paramsSchema: FurinSchema | undefined, querySchema: FurinSchema | undefined) {
  if (paramsSchema !== undefined) {
    return { schemas: { params: paramsSchema, query: querySchema } };
  }
  return querySchema === undefined ? {} : { schemas: { query: querySchema } };
}

function terminalFields(runtime: ChainRuntime) {
  const { head, loader, metadata, paramsSchema, querySchema, requestLoader } = runtime;
  return {
    __type: "FURIN_ROUTE" as const,
    mode: metadata.mode,
    revalidate: metadata.revalidate,
    remountDeps: metadata.remountDeps,
    staticParams: metadata.staticParams,
    tags: metadata.tags,
    head,
    ...(loader === undefined ? {} : { loader }),
    requestLoader,
    ...schemaFields(paramsSchema, querySchema),
  };
}

class RouteChain<State extends ChainState> {
  protected readonly runtime: ChainRuntime;

  constructor(runtime: ChainRuntime) {
    this.runtime = runtime;
  }

  requestLoader<Data extends RequestLoaderData>(
    requestLoader: RequestLoader<State["params"], State["query"], Data>
  ): StaticParamsClosedStage<WithState<State, { requestData: Data }>> {
    return new RouteChain<WithState<State, { requestData: Data }>>({
      ...this.runtime,
      requestLoader,
    });
  }

  staticParams(
    staticParams: StaticParams<State["params"], State["parentParams"], State["parentData"]>
  ): StaticParamsClosedStage<State> {
    const { metadata, requestLoader } = this.runtime;
    return new RouteChain<State>({
      ...this.runtime,
      metadata: withStaticParams(metadata, staticParams, requestLoader !== undefined),
    });
  }

  loader<Data extends PublicLoaderData>(
    loader: Loader<State["params"], State["query"], State["parentData"], Data, State["mode"]>
  ): LoadedRouteStage<WithState<State, { data: Data; loaded: true }>> {
    return new RouteChain<WithState<State, { data: Data; loaded: true }>>({
      ...this.runtime,
      loader,
    });
  }

  /** Head metadata is page-only: a headed chain can only terminate with `page()`. */
  head(
    head: Head<State["params"], State["query"], State["parentData"], State["data"], State["mode"]>
  ): HeadedPageStage<State> {
    return new RouteChain<State>({ ...this.runtime, head });
  }

  page(
    component: PageRequestLoaderCheck<State["mode"], State["requestData"], PageComponentOf<State>>
  ): PageTerminal<State> {
    const { metadata, paramsSchema, querySchema, requestLoader } = this.runtime;
    assertPageRequestLoaderMode(metadata, requestLoader);
    return {
      ...terminalFields(this.runtime),
      component,
      elysia: registerPage(paramsSchema, querySchema),
      page: component,
    } as unknown as PageTerminal<State>;
  }

  layout(component: LayoutComponentOf<State>): LayoutTerminal<State> {
    const { paramsSchema, querySchema } = this.runtime;
    return {
      ...terminalFields(this.runtime),
      component,
      elysia: registerLayout(paramsSchema, querySchema),
      layout: component,
    } as unknown as LayoutTerminal<State>;
  }
}

interface ConfigOptions {
  params?: FurinSchema | undefined;
  query?: FurinSchema | undefined;
}

function configure(options: RouteMetadata & ConfigOptions): unknown {
  assertStaticParamsOutsideConfig(options);
  return new RouteChain({
    head: undefined,
    loader: undefined,
    metadata: options,
    paramsSchema: options.params,
    querySchema: options.query,
    requestLoader: undefined,
  });
}

/**
 * First stage of the builder: `config()` is MANDATORY and must declare at
 * least `layout` and `mode`. Loader/page/layout are intentionally unreachable
 * before it — a route without an explicit rendering contract does not compile.
 */
class UnconfiguredRoute {
  config<
    LayoutRoute extends FurinLayoutRoute,
    QuerySchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ResolvedConfig<ContractOf<LayoutRoute>, undefined, QuerySchema> & {
      layout: LayoutRoute;
      mode: Mode;
      params?: undefined;
      query: QuerySchema;
    }
  ): ConfiguredRoute<
    ContractOf<LayoutRoute>,
    DataOfRoute<LayoutRoute>,
    undefined,
    QuerySchema,
    { query: QuerySchema },
    Mode
  >;
  config<
    LayoutRoute extends FurinLayoutRoute,
    ParamsSchema extends FurinSchema,
    QuerySchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ResolvedConfig<ContractOf<LayoutRoute>, ParamsSchema, QuerySchema> & {
      layout: LayoutRoute;
      mode: Mode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): ConfiguredRoute<
    ContractOf<LayoutRoute>,
    DataOfRoute<LayoutRoute>,
    ParamsSchema,
    QuerySchema,
    { params: ParamsSchema; query: QuerySchema },
    Mode
  >;
  config<
    LayoutRoute extends FurinLayoutRoute,
    ParamsSchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ResolvedConfig<ContractOf<LayoutRoute>, ParamsSchema, undefined> & {
      layout: LayoutRoute;
      mode: Mode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): ConfiguredRoute<
    ContractOf<LayoutRoute>,
    DataOfRoute<LayoutRoute>,
    ParamsSchema,
    undefined,
    { params: ParamsSchema; query: undefined },
    Mode
  >;
  config<LayoutRoute extends FurinLayoutRoute, Mode extends RenderingMode>(
    options: ResolvedConfig<ContractOf<LayoutRoute>, undefined, undefined> & {
      layout: LayoutRoute;
      mode: Mode;
      params?: undefined;
      query?: undefined;
    }
  ): ConfiguredRoute<
    ContractOf<LayoutRoute>,
    DataOfRoute<LayoutRoute>,
    undefined,
    undefined,
    undefined,
    Mode
  >;
  config(options: RouteMetadata & ConfigOptions): unknown {
    return configure(options);
  }
}

/**
 * Stage for `pages/root.tsx` — the document shell has no layout above it, so
 * `config()` requires only `mode` (the TanStack `createRootRoute` analogue).
 */
class UnconfiguredRootRoute {
  config<QuerySchema extends FurinSchema, Mode extends RenderingMode>(
    options: ResolvedConfig<EmptyContract, undefined, QuerySchema> & {
      mode: Mode;
      params?: undefined;
      query: QuerySchema;
    }
  ): ConfiguredRoute<EmptyContract, NoFields, undefined, QuerySchema, { query: QuerySchema }, Mode>;
  config<
    ParamsSchema extends FurinSchema,
    QuerySchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ResolvedConfig<EmptyContract, ParamsSchema, QuerySchema> & {
      mode: Mode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): ConfiguredRoute<
    EmptyContract,
    NoFields,
    ParamsSchema,
    QuerySchema,
    { params: ParamsSchema; query: QuerySchema },
    Mode
  >;
  config<ParamsSchema extends FurinSchema, Mode extends RenderingMode>(
    options: ResolvedConfig<EmptyContract, ParamsSchema, undefined> & {
      mode: Mode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): ConfiguredRoute<
    EmptyContract,
    NoFields,
    ParamsSchema,
    undefined,
    { params: ParamsSchema; query: undefined },
    Mode
  >;
  config<Mode extends RenderingMode>(
    options: ResolvedConfig<EmptyContract, undefined, undefined> & {
      mode: Mode;
      params?: undefined;
      query?: undefined;
    }
  ): ConfiguredRoute<EmptyContract, NoFields, undefined, undefined, undefined, Mode>;
  config(options: RouteMetadata & ConfigOptions): unknown {
    return configure(options);
  }
}

export function defineRoute(): UnconfiguredRoute {
  return new UnconfiguredRoute();
}

export function defineRootRoute(): UnconfiguredRootRoute {
  return new UnconfiguredRootRoute();
}

/** Resolved contract (inherited + own params/query, search input) of a route terminal. */
export type RouteContractOf<Route> = Route extends {
  readonly [routeContractBrand]?: infer Contract;
}
  ? NonNullable<Contract> extends RouteContract
    ? NonNullable<Contract>
    : never
  : never;

export type RouteParams<Route> = RouteContractOf<Route>["params"];

export type RouteLoaderData<Route> = Route extends {
  readonly [loaderDataBrand]?: infer Data;
}
  ? NonNullable<Data>
  : Route extends { loader: (...args: never[]) => infer Data }
    ? Awaited<Data>
    : never;
