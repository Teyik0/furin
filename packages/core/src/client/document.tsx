import { createContext, createElement, type ReactNode, useContext } from "react";
import { preloadModule } from "react-dom";
import type { HeadOptions, MetaDescriptor } from "../client.ts";

export interface DocumentAssets {
  buildId: string | undefined;
  entryModule: string | undefined;
  extensionErrorFilterScript?: string;
  faviconHref: string | undefined;
  frameworkModules: readonly string[];
  /** Route chunks to `<link rel="modulepreload">` (production server renders only). */
  modulePreloads?: readonly string[];
  staticMode: boolean;
  stylesheets: readonly string[];
}

export interface DocumentState {
  assets: DocumentAssets;
  dataJson: string | undefined;
  head: HeadOptions | undefined;
  nonce?: string;
  routeFrames?: string;
  syncJson: string | undefined;
}

const DocumentContext = createContext<DocumentState | null>(null);

function serializeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function DocumentProvider({
  children,
  value,
}: {
  children?: ReactNode;
  value: DocumentState;
}): ReactNode {
  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocumentState(): DocumentState | null {
  return useContext(DocumentContext);
}

function renderMeta(meta: MetaDescriptor, key: string): ReactNode {
  if ("title" in meta) {
    return <title key={key}>{meta.title}</title>;
  }
  if ("script:ld+json" in meta) {
    return (
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is an explicit raw-head API and is escaped by the route author contract.
        dangerouslySetInnerHTML={{ __html: serializeJson(meta["script:ld+json"]) }}
        key={key}
        type="application/ld+json"
      />
    );
  }
  if ("tagName" in meta) {
    const { tagName, ...attributes } = meta;
    return createElement(tagName, { ...attributes, key });
  }
  return createElement("meta", { ...meta, key });
}

export function HeadContent(): ReactNode {
  const state = useContext(DocumentContext);
  if (state === null) {
    throw new Error("[furin] <HeadContent /> must be rendered inside the root layout.");
  }
  for (const href of state.assets.modulePreloads ?? []) {
    preloadModule(href, { as: "script", nonce: state.nonce });
  }
  const occurrences = new Map<string, number>();
  const descriptorKey = (descriptor: object): string => {
    const identity = JSON.stringify(descriptor);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
  };

  return (
    <>
      {state.assets.extensionErrorFilterScript === undefined ? null : (
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: framework-owned development script.
          dangerouslySetInnerHTML={{ __html: state.assets.extensionErrorFilterScript }}
          data-furin-extension-error-filter=""
          nonce={state.nonce}
        />
      )}
      <meta charSet="utf-8" data-furin-head="" />
      <meta content="width=device-width, initial-scale=1.0" name="viewport" />
      {state.assets.buildId ? <meta content={state.assets.buildId} name="furin-build-id" /> : null}
      {state.assets.staticMode ? <meta content="static" name="furin-mode" /> : null}
      {state.assets.faviconHref ? <link href={state.assets.faviconHref} rel="icon" /> : null}
      {state.assets.stylesheets.map((href) => (
        <link crossOrigin="" href={href} key={href} rel="stylesheet" />
      ))}
      {state.head?.meta?.map((meta) => renderMeta(meta, descriptorKey(meta)))}
      {state.head?.links?.map((link) => (
        <link key={descriptorKey(link)} {...link} />
      ))}
      {state.head?.scripts?.map(({ children, ...attributes }) => (
        <script
          key={descriptorKey({ children, ...attributes })}
          {...attributes}
          nonce={state.nonce ?? attributes.nonce}
        >
          {children}
        </script>
      ))}
      {state.head?.styles?.map(({ children, type }) => (
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HeadOptions styles are an explicit raw HTML API.
          dangerouslySetInnerHTML={{ __html: children }}
          key={descriptorKey({ children, type })}
          nonce={state.nonce}
          type={type}
        />
      ))}
    </>
  );
}

export function Scripts(): ReactNode {
  const state = useContext(DocumentContext);
  if (state === null) {
    throw new Error("[furin] <Scripts /> must be rendered inside the root layout.");
  }

  return (
    <>
      {state.syncJson === undefined ? null : (
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: value is escaped framework JSON.
          dangerouslySetInnerHTML={{ __html: state.syncJson }}
          id="__FURIN_SYNC__"
          type="application/json"
        />
      )}
      {state.dataJson === undefined ? null : (
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: value is escaped framework JSON.
          dangerouslySetInnerHTML={{ __html: state.dataJson }}
          id="__FURIN_DATA__"
          type="application/json"
        />
      )}
      {state.routeFrames === undefined ? null : (
        <template
          // biome-ignore lint/security/noDangerouslySetInnerHtml: route frames are escaped before insertion.
          dangerouslySetInnerHTML={{
            __html: state.routeFrames.replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
          }}
          data-furin-document-state=""
          id="__FURIN_ROUTE_FRAMES__"
        />
      )}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: value is escaped framework JSON.
        dangerouslySetInnerHTML={{ __html: serializeJson(state.head ?? {}) }}
        data-furin-scripts=""
        id="__FURIN_HEAD__"
        type="application/json"
      />
      {state.assets.frameworkModules.map((src) => (
        <script
          crossOrigin=""
          data-furin-framework-module=""
          key={src}
          nonce={state.nonce}
          src={src}
          type="module"
        />
      ))}
      {state.assets.entryModule === undefined ? null : (
        <script
          crossOrigin=""
          data-furin-entry=""
          nonce={state.nonce}
          src={state.assets.entryModule}
          type="module"
        />
      )}
    </>
  );
}

/** @internal Framework-owned last resort when the user root document throws. */
export function FurinDocumentFallback({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
