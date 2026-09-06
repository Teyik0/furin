import { createContext, createElement, type ReactNode, useContext } from "react";
import type { HeadOptions, MetaDescriptor } from "../client.ts";

export interface DocumentAssets {
  buildId: string | undefined;
  entryModule: string | undefined;
  faviconHref: string | undefined;
  staticMode: boolean;
  stylesheets: readonly string[];
}

export interface DocumentState {
  assets: DocumentAssets;
  dataJson: string | undefined;
  head: HeadOptions | undefined;
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

function renderMeta(meta: MetaDescriptor, index: number): ReactNode {
  if ("title" in meta) {
    return <title key={`title:${index}`}>{meta.title}</title>;
  }
  if ("script:ld+json" in meta) {
    return (
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is an explicit raw-head API and is escaped by the route author contract.
        dangerouslySetInnerHTML={{ __html: serializeJson(meta["script:ld+json"]) }}
        key={`json-ld:${index}`}
        type="application/ld+json"
      />
    );
  }
  if ("tagName" in meta) {
    const { tagName, ...attributes } = meta;
    return createElement(tagName, { ...attributes, key: `${tagName}:${index}` });
  }
  return createElement("meta", { ...meta, key: `meta:${index}` });
}

export function HeadContent(): ReactNode {
  const state = useContext(DocumentContext);
  if (state === null) {
    throw new Error("[furin] <HeadContent /> must be rendered inside the root layout.");
  }

  return (
    <>
      <meta charSet="utf-8" />
      <meta content="width=device-width, initial-scale=1.0" name="viewport" />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static framework bootstrap with no user-controlled input.
        dangerouslySetInnerHTML={{
          __html:
            'try{var __t=localStorage.getItem("furin-theme");document.documentElement.classList.add(__t==="light"?"light":"dark")}catch(e){document.documentElement.classList.add("dark")}',
        }}
      />
      {state.assets.buildId ? <meta content={state.assets.buildId} name="furin-build-id" /> : null}
      {state.assets.staticMode ? <meta content="static" name="furin-mode" /> : null}
      {state.assets.faviconHref ? <link href={state.assets.faviconHref} rel="icon" /> : null}
      {state.assets.stylesheets.map((href) => (
        <link crossOrigin="" href={href} key={href} rel="stylesheet" />
      ))}
      {state.head?.meta?.map(renderMeta)}
      {state.head?.links?.map((link, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: duplicate link descriptors are valid and their declared order is significant.
        <link key={`${link.rel}:${link.href}:${index}`} {...link} />
      ))}
      {state.head?.scripts?.map(({ children, ...attributes }, index) => (
        <script
          // biome-ignore lint/suspicious/noArrayIndexKey: duplicate inline scripts are valid and their declared order is significant.
          key={`script:${index}`}
          {...attributes}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HeadOptions scripts are an explicit raw HTML API.
          dangerouslySetInnerHTML={children === undefined ? undefined : { __html: children }}
        />
      ))}
      {state.head?.styles?.map(({ children, type }, index) => (
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HeadOptions styles are an explicit raw HTML API.
          dangerouslySetInnerHTML={{ __html: children }}
          // biome-ignore lint/suspicious/noArrayIndexKey: duplicate inline styles are valid and their declared order is significant.
          key={`style:${index}`}
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
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: value is escaped framework JSON.
        dangerouslySetInnerHTML={{ __html: serializeJson(state.head ?? {}) }}
        id="__FURIN_HEAD__"
        type="application/json"
      />
      {state.assets.entryModule === undefined ? null : (
        <script crossOrigin="" data-furin-entry="" src={state.assets.entryModule} type="module" />
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
