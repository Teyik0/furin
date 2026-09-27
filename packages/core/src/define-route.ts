import { type Context, Elysia, ValidationError } from "elysia";
import type { RequestLogger } from "evlog";
import type { HeadOptions, RenderingMode } from "./client.ts";
import { applySchemaDefaults, coerceRouteInput } from "./server/router/schemas.ts";
import type {
  ElysiaRouteLeaf,
  ElysiaRouteParams,
  FurinSchema,
  FurinUnwrap,
} from "./shared/elysia-contract.ts";
import { getSchemaValidator, isTypeBoxObjectSchema } from "./shared/elysia-contract.ts";

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
interface SchemaValues {
  [key: string]: unknown;
}
type ParamsOf<Schema extends FurinSchema | undefined> = Schema extends FurinSchema
  ? FurinUnwrap<Schema>
  : NoFields;
declare const privateFieldBrand: unique symbol;
declare const ssrFieldBrand: unique symbol;
declare const inheritedDataBrand: unique symbol;
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
type ParamsOfRoute<Route> = Route extends {
  component: (props: infer Props) => unknown;
}
  ? Props extends { params: infer Params }
    ? Params
    : NoFields
  : NoFields;
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

export type DefineRouteConfig = RenderingConfig;

type ConfigFor = RenderingConfig;

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

type RouteMetadata = DefineRouteConfig & {
  staticParams?: (context: ErasedStaticParamsContext) => Awaitable<readonly unknown[]>;
};

type ConfiguredChain<Mode extends RenderingMode, Chain> = Mode extends "ssr"
  ? Omit<Chain, "staticParams">
  : Chain;

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
  PromisedData<Mode extends "ssr" ? SsrParentData<ParentData> : PublicParentData<ParentData>>;

type PageRequestLoaderCheck<
  Mode extends RenderingMode,
  RequestData extends LoaderData,
> = Mode extends "ssr"
  ? RequestData extends NoRequestLoader
    ? []
    : [error: "SSR pages cannot declare requestLoader(); use loader() and defer()"]
  : [];

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

function registerPlain<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode,
>(loader: Loader<Params, Query, ParentData, Data, Mode> | undefined) {
  return new Elysia().get("", async (context) => {
    const renderer = getFurinRenderer(context);
    if (renderer) {
      return renderer(context as unknown as FurinNativeRouteContext);
    }
    return Response.json(
      loader
        ? await loader({
            ...context,
            params: {} as Params,
            query: {} as Query,
          } as unknown as LoaderContext<Params, Query, ParentData, Mode>)
        : {}
    );
  });
}

function registerSchema<
  Params,
  Query,
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode,
>(
  paramsSchema: ParamsSchema,
  querySchema: QuerySchema,
  loader: Loader<Params, Query, ParentData, Data, Mode> | undefined
) {
  return new Elysia().get("", { params: paramsSchema, query: querySchema }, async (context) => {
    const renderer = getFurinRenderer(context);
    if (renderer) {
      return renderer(context as unknown as FurinNativeRouteContext);
    }
    return Response.json(
      loader
        ? await loader({
            ...context,
            params: context.params as Params,
            query: context.query as Query,
          } as unknown as LoaderContext<Params, Query, ParentData, Mode>)
        : {}
    );
  });
}

function registerQuery<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode,
>(querySchema: QuerySchema, loader: Loader<NoFields, Query, ParentData, Data, Mode> | undefined) {
  return new Elysia().get("", { query: querySchema }, async (context) => {
    const renderer = getFurinRenderer(context);
    if (renderer) {
      return renderer(context as unknown as FurinNativeRouteContext);
    }
    return Response.json(
      loader
        ? await loader({
            ...context,
            params: {},
            query: context.query as Query,
          } as unknown as LoaderContext<NoFields, Query, ParentData, Mode>)
        : {}
    );
  });
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

function registerLayout<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  Mode extends RenderingMode,
>(
  paramsSchema: FurinSchema | undefined,
  querySchema: FurinSchema | undefined,
  loader: Loader<Params, Query, ParentData, Data, Mode> | undefined
) {
  const app = new Elysia();
  if (paramsSchema || querySchema || loader) {
    app.derive(async (context) => {
      const params = paramsSchema
        ? await validateLayoutSchema("params", paramsSchema, context.params)
        : context.params;
      const query = querySchema
        ? await validateLayoutSchema("query", querySchema, context.query)
        : context.query;
      if (getFurinRenderer(context)) {
        return { params, query };
      }
      return {
        ...(loader
          ? await loader({
              ...context,
              params: params as Params,
              query: query as Query,
            } as unknown as LoaderContext<Params, Query, ParentData, Mode>)
          : {}),
      };
    });
  }
  return app;
}

function withMetadata<Mode extends RenderingMode, ParentData extends LoaderData>(
  metadata: RouteMetadata
) {
  return {
    mode: metadata.mode as Mode,
    revalidate: metadata.revalidate,
    staticParams: metadata.staticParams,
    tags: metadata.tags,
  } as {
    mode: Mode;
    revalidate: number | undefined;
    staticParams: RouteMetadata["staticParams"];
    tags: readonly string[] | undefined;
    readonly [inheritedDataBrand]?: ParentData;
  };
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

class NoSchemaChain<
  Params = NoFields,
  Query = NoFields,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoRequestLoader,
  ParentParams = NoFields,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly metadata: RouteMetadata;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<Data extends PublicLoaderData>(
    requestLoader: RequestLoader<Params, Query, Data>
  ): Omit<NoSchemaChain<Params, Query, ParentData, Data, ParentParams, Mode>, "staticParams"> {
    return new NoSchemaChain(this.metadata, requestLoader);
  }

  staticParams(
    staticParams: StaticParams<Params, ParentParams, ParentData>
  ): Omit<
    NoSchemaChain<Params, Query, ParentData, RequestData, ParentParams, Mode>,
    "staticParams"
  > {
    return new NoSchemaChain(
      withStaticParams(this.metadata, staticParams, this.requestLoaderFunction !== undefined),
      this.requestLoaderFunction
    );
  }

  loader<Data extends PublicLoaderData>(
    loader: Loader<Params, Query, ParentData, Data, Mode>
  ): LoadedNoSchema<Params, Query, ParentData, Data, RequestData, Mode> {
    return new LoadedNoSchema(this.metadata, loader, undefined, this.requestLoaderFunction);
  }

  page(
    component: Component<Params, Query, ParentData, NoFields, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerPlain<Params, Query, ParentData, NoFields, Mode>(undefined),
      page: component,
      requestLoader: this.requestLoaderFunction,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, NoFields, Mode>(
        undefined,
        undefined,
        undefined
      ),
      layout: component,
      requestLoader: this.requestLoaderFunction,
    };
  }
}

class LoadedNoSchema<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly headFunction: Head<Params, Query, ParentData, Data, Mode> | undefined;
  protected readonly loaderFunction: Loader<Params, Query, ParentData, Data, Mode>;
  protected readonly metadata: RouteMetadata;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    loader: Loader<Params, Query, ParentData, Data, Mode>,
    head: Head<Params, Query, ParentData, Data, Mode> | undefined,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.loaderFunction = loader;
    this.headFunction = head;
    this.requestLoaderFunction = requestLoader;
  }

  head(
    head: Head<Params, Query, ParentData, Data, Mode>
  ): HeadedNoSchema<Params, Query, ParentData, Data, RequestData, Mode> {
    return new HeadedNoSchema(this.metadata, this.loaderFunction, head, this.requestLoaderFunction);
  }

  page(
    component: Component<Params, Query, ParentData, Data, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerPlain<Params, Query, ParentData, Data, Mode>(this.loaderFunction),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, Data, Mode>(
        undefined,
        undefined,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }
}

class HeadedNoSchema<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> extends LoadedNoSchema<Params, Query, ParentData, Data, RequestData, Mode> {
  declare readonly head: never;
}

class QuerySchemaChain<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoRequestLoader,
  ParentParams = NoFields,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly metadata: RouteMetadata;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<NoFields, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    querySchema: QuerySchema,
    requestLoader: RequestLoader<NoFields, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.querySchema = querySchema;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<Data extends PublicLoaderData>(
    requestLoader: RequestLoader<NoFields, Query, Data>
  ): Omit<
    QuerySchemaChain<Query, QuerySchema, ParentData, Data, ParentParams, Mode>,
    "staticParams"
  > {
    return new QuerySchemaChain(this.metadata, this.querySchema, requestLoader);
  }

  staticParams(
    staticParams: StaticParams<NoFields, ParentParams, ParentData>
  ): Omit<
    QuerySchemaChain<Query, QuerySchema, ParentData, RequestData, ParentParams, Mode>,
    "staticParams"
  > {
    return new QuerySchemaChain(
      withStaticParams(this.metadata, staticParams, this.requestLoaderFunction !== undefined),
      this.querySchema,
      this.requestLoaderFunction
    );
  }

  loader<Data extends PublicLoaderData>(
    loader: Loader<NoFields, Query, ParentData, Data, Mode>
  ): LoadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData, Mode> {
    return new LoadedQuerySchema(
      this.metadata,
      this.querySchema,
      loader,
      undefined,
      this.requestLoaderFunction
    );
  }

  page(
    component: Component<NoFields, Query, ParentData, NoFields, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerQuery<Query, QuerySchema, ParentData, NoFields, Mode>(
        this.querySchema,
        undefined
      ),
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
    };
  }

  layout(component: LayoutComponent<NoFields, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<NoFields, Query, ParentData, NoFields, Mode>(
        undefined,
        this.querySchema,
        undefined
      ),
      layout: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
    };
  }
}

class LoadedQuerySchema<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly headFunction: Head<NoFields, Query, ParentData, Data, Mode> | undefined;
  protected readonly loaderFunction: Loader<NoFields, Query, ParentData, Data, Mode>;
  protected readonly metadata: RouteMetadata;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<NoFields, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    querySchema: QuerySchema,
    loader: Loader<NoFields, Query, ParentData, Data, Mode>,
    head: Head<NoFields, Query, ParentData, Data, Mode> | undefined,
    requestLoader: RequestLoader<NoFields, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.querySchema = querySchema;
    this.loaderFunction = loader;
    this.headFunction = head;
    this.requestLoaderFunction = requestLoader;
  }

  head(
    head: Head<NoFields, Query, ParentData, Data, Mode>
  ): HeadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData, Mode> {
    return new HeadedQuerySchema(
      this.metadata,
      this.querySchema,
      this.loaderFunction,
      head,
      this.requestLoaderFunction
    );
  }

  page(
    component: Component<NoFields, Query, ParentData, Data, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerQuery<Query, QuerySchema, ParentData, Data, Mode>(
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }

  layout(component: LayoutComponent<NoFields, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<NoFields, Query, ParentData, Data, Mode>(
        undefined,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }
}

class HeadedQuerySchema<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> extends LoadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData, Mode> {
  declare readonly head: never;
}

class SchemaChain<
  Params,
  Query,
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoRequestLoader,
  ParentParams = NoFields,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly metadata: RouteMetadata;
  protected readonly paramsSchema: ParamsSchema;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    paramsSchema: ParamsSchema,
    querySchema: QuerySchema,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.paramsSchema = paramsSchema;
    this.querySchema = querySchema;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<RequestLoaderData extends PublicLoaderData>(
    requestLoader: RequestLoader<Params, Query, RequestLoaderData>
  ): Omit<
    SchemaChain<
      Params,
      Query,
      ParamsSchema,
      QuerySchema,
      ParentData,
      RequestLoaderData,
      ParentParams,
      Mode
    >,
    "staticParams"
  > {
    return new SchemaChain(this.metadata, this.paramsSchema, this.querySchema, requestLoader);
  }

  staticParams(
    staticParams: StaticParams<Params, ParentParams, ParentData>
  ): Omit<
    SchemaChain<
      Params,
      Query,
      ParamsSchema,
      QuerySchema,
      ParentData,
      RequestData,
      ParentParams,
      Mode
    >,
    "staticParams"
  > {
    return new SchemaChain(
      withStaticParams(this.metadata, staticParams, this.requestLoaderFunction !== undefined),
      this.paramsSchema,
      this.querySchema,
      this.requestLoaderFunction
    );
  }

  loader<Data extends PublicLoaderData>(
    loader: Loader<Params, Query, ParentData, Data, Mode>
  ): LoadedSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, RequestData, Mode> {
    return new LoadedSchema(
      this.metadata,
      this.paramsSchema,
      this.querySchema,
      loader,
      undefined,
      this.requestLoaderFunction
    );
  }

  page(
    component: Component<Params, Query, ParentData, NoFields, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, NoFields, Mode>(
        this.paramsSchema,
        this.querySchema,
        undefined
      ),
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, NoFields, Mode>(
        this.paramsSchema,
        this.querySchema,
        undefined
      ),
      layout: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
    };
  }
}

class LoadedSchema<
  Params,
  Query,
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> {
  protected readonly headFunction: Head<Params, Query, ParentData, Data, Mode> | undefined;
  protected readonly loaderFunction: Loader<Params, Query, ParentData, Data, Mode>;
  protected readonly metadata: RouteMetadata;
  protected readonly paramsSchema: ParamsSchema;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: RouteMetadata,
    paramsSchema: ParamsSchema,
    querySchema: QuerySchema,
    loader: Loader<Params, Query, ParentData, Data, Mode>,
    head: Head<Params, Query, ParentData, Data, Mode> | undefined,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.paramsSchema = paramsSchema;
    this.querySchema = querySchema;
    this.loaderFunction = loader;
    this.headFunction = head;
    this.requestLoaderFunction = requestLoader;
  }

  head(
    head: Head<Params, Query, ParentData, Data, Mode>
  ): HeadedSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, RequestData, Mode> {
    return new HeadedSchema(
      this.metadata,
      this.paramsSchema,
      this.querySchema,
      this.loaderFunction,
      head,
      this.requestLoaderFunction
    );
  }

  page(
    component: Component<Params, Query, ParentData, Data, RequestData>,
    ..._requestLoaderCheck: PageRequestLoaderCheck<Mode, RequestData>
  ) {
    assertPageRequestLoaderMode(this.metadata, this.requestLoaderFunction);
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, Mode>(
        this.paramsSchema,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata<Mode, ParentData>(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, Data, Mode>(
        this.paramsSchema,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
      useLoaderData: (): RenderLoaderData<ParentData, Data> =>
        undefined as unknown as RenderLoaderData<ParentData, Data>,
    };
  }
}

class HeadedSchema<
  Params,
  Query,
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
  Mode extends RenderingMode = RenderingMode,
> extends LoadedSchema<
  Params,
  Query,
  ParamsSchema,
  QuerySchema,
  ParentData,
  Data,
  RequestData,
  Mode
> {
  declare readonly head: never;
}

/**
 * First stage of the builder: `config()` is MANDATORY and must declare at
 * least `layout` and `mode`. Loader/page/layout are intentionally unreachable
 * before it — a route without an explicit rendering contract does not compile.
 */
class UnconfiguredRoute {
  config<LayoutRoute, QuerySchema extends FurinSchema, Mode extends RenderingMode>(
    options: ConfigFor & {
      layout: LayoutRoute;
      mode: Mode;
      params?: undefined;
      query: QuerySchema;
    }
  ): ConfiguredChain<
    Mode,
    QuerySchemaChain<
      ParamsOf<QuerySchema>,
      QuerySchema,
      DataOfRoute<LayoutRoute>,
      NoRequestLoader,
      ParamsOfRoute<LayoutRoute>,
      Mode
    >
  >;
  config<
    LayoutRoute,
    ParamsSchema extends FurinSchema,
    QuerySchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ConfigFor & {
      layout: LayoutRoute;
      mode: Mode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): ConfiguredChain<
    Mode,
    SchemaChain<
      ParamsOf<ParamsSchema>,
      ParamsOf<QuerySchema>,
      ParamsSchema,
      QuerySchema,
      DataOfRoute<LayoutRoute>,
      NoRequestLoader,
      ParamsOfRoute<LayoutRoute>,
      Mode
    >
  >;
  config<LayoutRoute, ParamsSchema extends FurinSchema, Mode extends RenderingMode>(
    options: ConfigFor & {
      layout: LayoutRoute;
      mode: Mode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): ConfiguredChain<
    Mode,
    SchemaChain<
      ParamsOf<ParamsSchema>,
      NoFields,
      ParamsSchema,
      undefined,
      DataOfRoute<LayoutRoute>,
      NoRequestLoader,
      ParamsOfRoute<LayoutRoute>,
      Mode
    >
  >;
  config<LayoutRoute, Mode extends RenderingMode>(
    options: ConfigFor & {
      layout: LayoutRoute;
      mode: Mode;
      params?: undefined;
      query?: undefined;
    }
  ): ConfiguredChain<
    Mode,
    NoSchemaChain<
      NoFields,
      NoFields,
      DataOfRoute<LayoutRoute>,
      NoRequestLoader,
      ParamsOfRoute<LayoutRoute>,
      Mode
    >
  >;
  config<
    LayoutRoute,
    ParamsSchema extends FurinSchema | undefined,
    QuerySchema extends FurinSchema | undefined,
  >(
    options: DefineRouteConfig & {
      layout: LayoutRoute;
      mode: RenderingMode;
      params?: ParamsSchema;
      query?: QuerySchema;
    }
  ): unknown {
    assertStaticParamsOutsideConfig(options);
    if (options.params === undefined) {
      if (options.query !== undefined) {
        return new QuerySchemaChain<
          ParamsOf<Exclude<QuerySchema, undefined>>,
          Exclude<QuerySchema, undefined>,
          DataOfRoute<LayoutRoute>,
          NoRequestLoader,
          ParamsOfRoute<LayoutRoute>
        >(options, options.query as Exclude<QuerySchema, undefined>, undefined);
      }
      return new NoSchemaChain<
        NoFields,
        NoFields,
        DataOfRoute<LayoutRoute>,
        NoRequestLoader,
        ParamsOfRoute<LayoutRoute>
      >(options, undefined);
    }
    return new SchemaChain<
      ParamsOf<Exclude<ParamsSchema, undefined>>,
      ParamsOf<Exclude<QuerySchema, undefined>>,
      Exclude<ParamsSchema, undefined>,
      Exclude<QuerySchema, undefined>,
      DataOfRoute<LayoutRoute>,
      NoRequestLoader,
      ParamsOfRoute<LayoutRoute>
    >(
      options,
      options.params as Exclude<ParamsSchema, undefined>,
      options.query as Exclude<QuerySchema, undefined>,
      undefined
    );
  }
}

/**
 * Stage for `pages/root.tsx` — the document shell has no layout above it, so
 * `config()` requires only `mode` (the TanStack `createRootRoute` analogue).
 */
class UnconfiguredRootRoute {
  config<QuerySchema extends FurinSchema, Mode extends RenderingMode>(
    options: ConfigFor & {
      mode: Mode;
      params?: undefined;
      query: QuerySchema;
    }
  ): ConfiguredChain<
    Mode,
    QuerySchemaChain<ParamsOf<QuerySchema>, QuerySchema, NoFields, NoRequestLoader, NoFields, Mode>
  >;
  config<
    ParamsSchema extends FurinSchema,
    QuerySchema extends FurinSchema,
    Mode extends RenderingMode,
  >(
    options: ConfigFor & {
      mode: Mode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): ConfiguredChain<
    Mode,
    SchemaChain<
      ParamsOf<ParamsSchema>,
      ParamsOf<QuerySchema>,
      ParamsSchema,
      QuerySchema,
      NoFields,
      NoRequestLoader,
      NoFields,
      Mode
    >
  >;
  config<ParamsSchema extends FurinSchema, Mode extends RenderingMode>(
    options: ConfigFor & {
      mode: Mode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): ConfiguredChain<
    Mode,
    SchemaChain<
      ParamsOf<ParamsSchema>,
      NoFields,
      ParamsSchema,
      undefined,
      NoFields,
      NoRequestLoader,
      NoFields,
      Mode
    >
  >;
  config<Mode extends RenderingMode>(
    options: ConfigFor & {
      mode: Mode;
      params?: undefined;
      query?: undefined;
    }
  ): ConfiguredChain<
    Mode,
    NoSchemaChain<NoFields, NoFields, NoFields, NoRequestLoader, NoFields, Mode>
  >;
  config<ParamsSchema extends FurinSchema | undefined, QuerySchema extends FurinSchema | undefined>(
    options: DefineRouteConfig & {
      mode: RenderingMode;
      params?: ParamsSchema;
      query?: QuerySchema;
    }
  ): unknown {
    assertStaticParamsOutsideConfig(options);
    if (options.params === undefined) {
      if (options.query !== undefined) {
        return new QuerySchemaChain<
          ParamsOf<Exclude<QuerySchema, undefined>>,
          Exclude<QuerySchema, undefined>,
          NoFields
        >(options, options.query as Exclude<QuerySchema, undefined>, undefined);
      }
      return new NoSchemaChain<NoFields, NoFields, NoFields>(options, undefined);
    }
    return new SchemaChain<
      ParamsOf<Exclude<ParamsSchema, undefined>>,
      ParamsOf<Exclude<QuerySchema, undefined>>,
      Exclude<ParamsSchema, undefined>,
      Exclude<QuerySchema, undefined>,
      NoFields
    >(
      options,
      options.params as Exclude<ParamsSchema, undefined>,
      options.query as Exclude<QuerySchema, undefined>,
      undefined
    );
  }
}

export function defineRoute(): UnconfiguredRoute {
  return new UnconfiguredRoute();
}

export function defineRootRoute(): UnconfiguredRootRoute {
  return new UnconfiguredRootRoute();
}

export type RouteParams<Route> = Route extends { elysia: infer App }
  ? ElysiaRouteParams<ElysiaRouteLeaf<App>>
  : never;

export type RouteLoaderData<Route> = Route extends { useLoaderData: () => infer Data }
  ? Data
  : never;
