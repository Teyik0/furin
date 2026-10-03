import { expect, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server";
import { DocumentProvider, HeadContent } from "../../../src/client/document.tsx";

test("inline head scripts cannot close their script element and inject HTML", async () => {
  const stream = await renderToReadableStream(
    <DocumentProvider
      value={{
        assets: {
          buildId: undefined,
          entryModule: undefined,
          faviconHref: undefined,
          frameworkModules: [],
          staticMode: false,
          stylesheets: [],
        },
        dataJson: undefined,
        head: {
          scripts: [{ children: 'window.message = "</script><img src=x onerror=alert(1)>";' }],
        },
        syncJson: undefined,
      }}
    >
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body />
      </html>
    </DocumentProvider>
  );
  const html = await new Response(stream).text();
  expect(html).not.toContain("</script><img");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(html).toContain("window.message");
});
