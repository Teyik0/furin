import { type Context, Elysia, ValidationError } from "elysia";
import type { RequestLogger } from "evlog";
import type { HeadOptions, RenderingMode } from "./client.ts";
import { applySchemaDefaults } from "./server/router/schemas.ts";
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
interface SchemaValues {
  [key: string]: unknown;
}
type ParamsOf<Schema extends FurinSchema | undefined> = Schema extends FurinSchema
  ? FurinUnwrap<Schema>
  : NoFields;
type DataOfRoute<Route> = Route extends {
  component: (props: infer Props) => unknown;
}
  ? Props extends { data: infer Data extends LoaderData }
    ? Data
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

type RenderingConfig<Params> = SharedRouteConfig &
  (
    | {
        mode: "ssr";
        revalidate?: never;
        staticParams?: never;
      }
    | {
        mode: "ssg";
        revalidate?: never;
        staticParams?: () => Awaitable<readonly Params[]>;
      }
    | {
        mode: "isr";
        revalidate: number;
        staticParams?: () => Awaitable<readonly Params[]>;
      }
  );

export type DefineRouteConfig = RenderingConfig<unknown>;

type ConfigFor<Params> = RenderingConfig<Params>;

type LoaderContext<Params, Query, ParentData extends LoaderData> = {
  params: Params;
  query: Query;
  log: RequestLogger;
} & Omit<Context<{ params: Params; query: Query }>, "params" | "query"> &
  PromisedData<ParentData>;

type Loader<Params, Query, ParentData extends LoaderData, Data extends LoaderData> = (
  context: LoaderContext<Params, Query, ParentData>
) => Awaitable<Data>;

type RequestDataContext<RequestData extends LoaderData> = keyof RequestData extends never
  ? NoFields
  : { requestData: Promise<RequestData> };

type RequestLoader<Params, Query, Data extends LoaderData> = (
  context: RequestLoaderContext<Params, Query>
) => Awaitable<Data>;

/**
 * Same-name parent/loader fields whose types are incompatible map to a
 * readable branded error object; compatible overrides (same-type) map to
 * `never` and are dropped from the mapped type.
 */
type ParentDataConflicts<ParentData extends LoaderData, Data extends LoaderData> = {
  [Key in keyof Data & keyof ParentData as Data[Key] extends ParentData[Key] ? never : Key]: {
    __furinConflict: "this loader key overwrites a parent loader key with an incompatible type";
    parentType: ParentData[Key];
    loaderType: Data[Key];
  };
};

type WithoutParentDataConflicts<
  ParentData extends LoaderData,
  Data extends LoaderData,
> = keyof ParentDataConflicts<ParentData, Data> extends never
  ? ParentData & Data
  : Omit<ParentData & Data, keyof ParentDataConflicts<ParentData, Data>> &
      ParentDataConflicts<ParentData, Data>;

type RenderContext<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> = {
  data: WithoutParentDataConflicts<ParentData, Data>;
  params: Params;
  path: string;
  query: Query;
} & RequestDataContext<RequestData>;

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

type Head<Params, Query, ParentData extends LoaderData, Data extends LoaderData> = (
  context: RenderContext<Params, Query, ParentData, Data, NoFields>
) => HeadOptions;

export function getFurinRenderer(context: object): FurinRouteDispatcher | undefined {
  const renderer = (context as { $furinRender?: unknown })[FURIN_RENDER_DECORATOR];
  return typeof renderer === "function" ? (renderer as FurinRouteDispatcher) : undefined;
}

function registerPlain<Params, Query, ParentData extends LoaderData, Data extends LoaderData>(
  loader: Loader<Params, Query, ParentData, Data> | undefined
) {
  return new Elysia().get("/", async (context) => {
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
          } as LoaderContext<Params, Query, ParentData>)
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
>(
  paramsSchema: ParamsSchema,
  querySchema: QuerySchema,
  loader: Loader<Params, Query, ParentData, Data> | undefined
) {
  return new Elysia().get(
    "/",
    async (context) => {
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
            } as LoaderContext<Params, Query, ParentData>)
          : {}
      );
    },
    { params: paramsSchema, query: querySchema }
  );
}

function registerQuery<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData,
  Data extends LoaderData,
>(querySchema: QuerySchema, loader: Loader<NoFields, Query, ParentData, Data> | undefined) {
  return new Elysia().get(
    "/",
    async (context) => {
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
            } as LoaderContext<NoFields, Query, ParentData>)
          : {}
      );
    },
    { query: querySchema }
  );
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
    ? applySchemaDefaults(schema, selectedValues)
    : selectedValues;
  const validator = getSchemaValidator(schema, { coerce: true, dynamic: true });
  const checked = await validator?.Check(selected);
  if (
    checked === false ||
    (checked !== null && typeof checked === "object" && "issues" in checked)
  ) {
    throw new ValidationError(type, schema, selected);
  }
  const parsed =
    checked !== null && typeof checked === "object" && "value" in checked
      ? checked.value
      : validator?.parse(selected);
  return { ...schemaValues(value), ...schemaValues(parsed) };
}

function registerLayout<Params, Query, ParentData extends LoaderData, Data extends LoaderData>(
  paramsSchema: FurinSchema | undefined,
  querySchema: FurinSchema | undefined,
  loader: Loader<Params, Query, ParentData, Data> | undefined
) {
  const app = new Elysia();
  if (paramsSchema || querySchema || loader) {
    app.resolve(async (context) => {
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
            } as LoaderContext<Params, Query, ParentData>)
          : {}),
      };
    });
  }
  return app;
}

function withMetadata<Metadata extends DefineRouteConfig>(metadata: Metadata) {
  return {
    mode: metadata.mode,
    revalidate: metadata.revalidate,
    staticParams: metadata.staticParams,
    tags: metadata.tags,
  };
}

class NoSchemaChain<
  Params = NoFields,
  Query = NoFields,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoFields,
> {
  protected readonly metadata: DefineRouteConfig;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<Data extends LoaderData>(
    requestLoader: RequestLoader<Params, Query, Data>
  ): NoSchemaChain<Params, Query, ParentData, Data> {
    return new NoSchemaChain(this.metadata, requestLoader);
  }

  loader<Data extends LoaderData>(
    loader: Loader<Params, Query, ParentData, Data>
  ): LoadedNoSchema<Params, Query, ParentData, Data, RequestData> {
    return new LoadedNoSchema(this.metadata, loader, undefined, this.requestLoaderFunction);
  }

  page(component: Component<Params, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerPlain<Params, Query, ParentData, NoFields>(undefined),
      page: component,
      requestLoader: this.requestLoaderFunction,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, NoFields>(undefined, undefined, undefined),
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
> {
  protected readonly headFunction: Head<Params, Query, ParentData, Data> | undefined;
  protected readonly loaderFunction: Loader<Params, Query, ParentData, Data>;
  protected readonly metadata: DefineRouteConfig;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    loader: Loader<Params, Query, ParentData, Data>,
    head: Head<Params, Query, ParentData, Data> | undefined,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.loaderFunction = loader;
    this.headFunction = head;
    this.requestLoaderFunction = requestLoader;
  }

  head(
    head: Head<Params, Query, ParentData, Data>
  ): HeadedNoSchema<Params, Query, ParentData, Data, RequestData> {
    return new HeadedNoSchema(this.metadata, this.loaderFunction, head, this.requestLoaderFunction);
  }

  page(component: Component<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerPlain<Params, Query, ParentData, Data>(this.loaderFunction),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, Data>(
        undefined,
        undefined,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
    };
  }
}

class HeadedNoSchema<
  Params,
  Query,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> extends LoadedNoSchema<Params, Query, ParentData, Data, RequestData> {
  declare readonly head: never;
}

class QuerySchemaChain<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoFields,
> {
  protected readonly metadata: DefineRouteConfig;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<NoFields, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    querySchema: QuerySchema,
    requestLoader: RequestLoader<NoFields, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.querySchema = querySchema;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<Data extends LoaderData>(
    requestLoader: RequestLoader<NoFields, Query, Data>
  ): QuerySchemaChain<Query, QuerySchema, ParentData, Data> {
    return new QuerySchemaChain(this.metadata, this.querySchema, requestLoader);
  }

  loader<Data extends LoaderData>(
    loader: Loader<NoFields, Query, ParentData, Data>
  ): LoadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData> {
    return new LoadedQuerySchema(
      this.metadata,
      this.querySchema,
      loader,
      undefined,
      this.requestLoaderFunction
    );
  }

  page(component: Component<NoFields, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerQuery<Query, QuerySchema, ParentData, NoFields>(this.querySchema, undefined),
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
    };
  }

  layout(component: LayoutComponent<NoFields, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<NoFields, Query, ParentData, NoFields>(
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
> {
  protected readonly headFunction: Head<NoFields, Query, ParentData, Data> | undefined;
  protected readonly loaderFunction: Loader<NoFields, Query, ParentData, Data>;
  protected readonly metadata: DefineRouteConfig;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<NoFields, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    querySchema: QuerySchema,
    loader: Loader<NoFields, Query, ParentData, Data>,
    head: Head<NoFields, Query, ParentData, Data> | undefined,
    requestLoader: RequestLoader<NoFields, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.querySchema = querySchema;
    this.loaderFunction = loader;
    this.headFunction = head;
    this.requestLoaderFunction = requestLoader;
  }

  head(
    head: Head<NoFields, Query, ParentData, Data>
  ): HeadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData> {
    return new HeadedQuerySchema(
      this.metadata,
      this.querySchema,
      this.loaderFunction,
      head,
      this.requestLoaderFunction
    );
  }

  page(component: Component<NoFields, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerQuery<Query, QuerySchema, ParentData, Data>(
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
    };
  }

  layout(component: LayoutComponent<NoFields, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<NoFields, Query, ParentData, Data>(
        undefined,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      schemas: { query: this.querySchema },
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
    };
  }
}

class HeadedQuerySchema<
  Query,
  QuerySchema extends FurinSchema,
  ParentData extends LoaderData,
  Data extends LoaderData,
  RequestData extends LoaderData,
> extends LoadedQuerySchema<Query, QuerySchema, ParentData, Data, RequestData> {
  declare readonly head: never;
}

class SchemaChain<
  Params,
  Query,
  ParamsSchema extends FurinSchema,
  QuerySchema extends FurinSchema | undefined,
  ParentData extends LoaderData = NoFields,
  RequestData extends LoaderData = NoFields,
> {
  protected readonly metadata: DefineRouteConfig;
  protected readonly paramsSchema: ParamsSchema;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    paramsSchema: ParamsSchema,
    querySchema: QuerySchema,
    requestLoader: RequestLoader<Params, Query, RequestData> | undefined
  ) {
    this.metadata = metadata;
    this.paramsSchema = paramsSchema;
    this.querySchema = querySchema;
    this.requestLoaderFunction = requestLoader;
  }

  requestLoader<RequestLoaderData extends LoaderData>(
    requestLoader: RequestLoader<Params, Query, RequestLoaderData>
  ): SchemaChain<Params, Query, ParamsSchema, QuerySchema, ParentData, RequestLoaderData> {
    return new SchemaChain(this.metadata, this.paramsSchema, this.querySchema, requestLoader);
  }

  loader<Data extends LoaderData>(
    loader: Loader<Params, Query, ParentData, Data>
  ): LoadedSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, RequestData> {
    return new LoadedSchema(
      this.metadata,
      this.paramsSchema,
      this.querySchema,
      loader,
      undefined,
      this.requestLoaderFunction
    );
  }

  page(component: Component<Params, Query, ParentData, NoFields, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, NoFields>(
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
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, NoFields>(
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
> {
  protected readonly headFunction: Head<Params, Query, ParentData, Data> | undefined;
  protected readonly loaderFunction: Loader<Params, Query, ParentData, Data>;
  protected readonly metadata: DefineRouteConfig;
  protected readonly paramsSchema: ParamsSchema;
  protected readonly querySchema: QuerySchema;
  protected readonly requestLoaderFunction: RequestLoader<Params, Query, RequestData> | undefined;

  constructor(
    metadata: DefineRouteConfig,
    paramsSchema: ParamsSchema,
    querySchema: QuerySchema,
    loader: Loader<Params, Query, ParentData, Data>,
    head: Head<Params, Query, ParentData, Data> | undefined,
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
    head: Head<Params, Query, ParentData, Data>
  ): HeadedSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, RequestData> {
    return new HeadedSchema(
      this.metadata,
      this.paramsSchema,
      this.querySchema,
      this.loaderFunction,
      head,
      this.requestLoaderFunction
    );
  }

  page(component: Component<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data>(
        this.paramsSchema,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      loader: this.loaderFunction,
      page: component,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
    };
  }

  layout(component: LayoutComponent<Params, Query, ParentData, Data, RequestData>) {
    return {
      __type: "FURIN_ROUTE" as const,
      ...withMetadata(this.metadata),
      component,
      elysia: registerLayout<Params, Query, ParentData, Data>(
        this.paramsSchema,
        this.querySchema,
        this.loaderFunction
      ),
      head: this.headFunction,
      layout: component,
      loader: this.loaderFunction,
      requestLoader: this.requestLoaderFunction,
      schemas: { params: this.paramsSchema, query: this.querySchema },
      useLoaderData: (): ParentData & Data => undefined as unknown as ParentData & Data,
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
> extends LoadedSchema<Params, Query, ParamsSchema, QuerySchema, ParentData, Data, RequestData> {
  declare readonly head: never;
}

/**
 * First stage of the builder: `config()` is MANDATORY and must declare at
 * least `layout` and `mode`. Loader/page/layout are intentionally unreachable
 * before it — a route without an explicit rendering contract does not compile.
 */
class UnconfiguredRoute {
  config<LayoutRoute, QuerySchema extends FurinSchema>(
    options: ConfigFor<NoFields> & {
      layout: LayoutRoute;
      mode: RenderingMode;
      params?: undefined;
      query: QuerySchema;
    }
  ): QuerySchemaChain<ParamsOf<QuerySchema>, QuerySchema, DataOfRoute<LayoutRoute>>;
  config<LayoutRoute, ParamsSchema extends FurinSchema, QuerySchema extends FurinSchema>(
    options: ConfigFor<ParamsOf<ParamsSchema>> & {
      layout: LayoutRoute;
      mode: RenderingMode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): SchemaChain<
    ParamsOf<ParamsSchema>,
    ParamsOf<QuerySchema>,
    ParamsSchema,
    QuerySchema,
    DataOfRoute<LayoutRoute>
  >;
  config<LayoutRoute, ParamsSchema extends FurinSchema>(
    options: ConfigFor<ParamsOf<ParamsSchema>> & {
      layout: LayoutRoute;
      mode: RenderingMode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): SchemaChain<
    ParamsOf<ParamsSchema>,
    NoFields,
    ParamsSchema,
    undefined,
    DataOfRoute<LayoutRoute>
  >;
  config<LayoutRoute>(
    options: ConfigFor<NoFields> & {
      layout: LayoutRoute;
      mode: RenderingMode;
      params?: undefined;
      query?: undefined;
    }
  ): NoSchemaChain<NoFields, NoFields, DataOfRoute<LayoutRoute>>;
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
  ) {
    if (options.params === undefined) {
      if (options.query !== undefined) {
        return new QuerySchemaChain<
          ParamsOf<Exclude<QuerySchema, undefined>>,
          Exclude<QuerySchema, undefined>,
          DataOfRoute<LayoutRoute>
        >(options, options.query as Exclude<QuerySchema, undefined>, undefined);
      }
      return new NoSchemaChain<NoFields, NoFields, DataOfRoute<LayoutRoute>>(options, undefined);
    }
    return new SchemaChain<
      ParamsOf<Exclude<ParamsSchema, undefined>>,
      ParamsOf<Exclude<QuerySchema, undefined>>,
      Exclude<ParamsSchema, undefined>,
      Exclude<QuerySchema, undefined>,
      DataOfRoute<LayoutRoute>
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
  config<QuerySchema extends FurinSchema>(
    options: ConfigFor<NoFields> & {
      mode: RenderingMode;
      params?: undefined;
      query: QuerySchema;
    }
  ): QuerySchemaChain<ParamsOf<QuerySchema>, QuerySchema, NoFields>;
  config<ParamsSchema extends FurinSchema, QuerySchema extends FurinSchema>(
    options: ConfigFor<ParamsOf<ParamsSchema>> & {
      mode: RenderingMode;
      params: ParamsSchema;
      query: QuerySchema;
    }
  ): SchemaChain<
    ParamsOf<ParamsSchema>,
    ParamsOf<QuerySchema>,
    ParamsSchema,
    QuerySchema,
    NoFields
  >;
  config<ParamsSchema extends FurinSchema>(
    options: ConfigFor<ParamsOf<ParamsSchema>> & {
      mode: RenderingMode;
      params: ParamsSchema;
      query?: undefined;
    }
  ): SchemaChain<ParamsOf<ParamsSchema>, NoFields, ParamsSchema, undefined, NoFields>;
  config(
    options: ConfigFor<NoFields> & {
      mode: RenderingMode;
      params?: undefined;
      query?: undefined;
    }
  ): NoSchemaChain<NoFields, NoFields, NoFields>;
  config<ParamsSchema extends FurinSchema | undefined, QuerySchema extends FurinSchema | undefined>(
    options: DefineRouteConfig & {
      mode: RenderingMode;
      params?: ParamsSchema;
      query?: QuerySchema;
    }
  ) {
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
