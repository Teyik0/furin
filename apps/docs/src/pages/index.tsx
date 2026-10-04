import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import { HeroCodeWindow } from "@/components/hero-section";
import { ChimeCanvas } from "@/components/landing/chime-canvas";
import { CopyCommand } from "@/components/landing/copy-command";
import { LandingFont } from "@/components/landing/landing-font";
import { ModeCard } from "@/components/landing/modes-grid";
import { Reveal } from "@/components/landing/reveal";
import { StackReveal } from "@/components/landing/stack-reveal";
import { SyncDemo } from "@/components/landing/sync-demo";
import { highlighter } from "@/lib/highlight";
import { LandingServer, type LandingSlots } from "../components/landing/landing-server";
import { route as parentRoute } from "./root";

const FILES = {
  "pages/index.tsx": `import { defineRoute } from "@teyik0/furin"
import { route as rootRoute } from "./root"

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({
    message: "Hello from Furin!",
    renderedAt: Date.now(),
  }))
  .page(({ message, renderedAt }) => (
    <h1>{message} · {renderedAt}</h1>
  ))`,
  "pages/root.tsx": `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin"
import { Link } from "@teyik0/furin/link"
import "./styles/globals.css"

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/blog">Blog</Link>
        </nav>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  )
}

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <RootLayout>{children}</RootLayout>)`,
  "server.ts": `import { Elysia } from "elysia"
import { furin } from "@teyik0/furin"

export const port = Number(process.env.PORT ?? 3000)

const app = new Elysia()
  .use(await furin({ pagesDir: "./pages" }))

if (import.meta.main) {
  app.listen(port)
  console.log(\`Furin app running at http://localhost:\${app.server?.port}\`)
}

export default app`,
} as const;

type FileName = keyof typeof FILES;

// Abridged from examples/task-manager: src/api/modules/{boards,cards}/index.ts,
// src/lib/api.ts (client branch) and src/lib/card-mutations.ts (moveBoardCard).
const SYNC_SERVER = `// boards/index.ts
.get(
  "/boards/:boardId",
  { sync: { id: "board", scope: ({ params }) => ({ boardId: params.boardId }) } },
  ({ params, problem }) => { /* … getBoardData(params.boardId) */ }
)

// cards/index.ts
.patch("/cards/:id", {
  body: t.Object({ column: t.Optional(columnType), /* … */ }),
  sync: {
    invalidate: ({ params, responseValue }) => cardInvalidations(params.id, responseValue),
  },
}, ({ params, body, problem, mutation }) => mutation((tx) => { /* … */ }))`;

const SYNC_CLIENT = `// api.ts
createClient<Api>(window.location.origin, { retry: 2 }).api

// card-mutations.ts · moveBoardCard
return api.cards({ id: cardId }).patch(
  { column, position },
  {
    optimistic: (cache) =>
      cache.update(api.boards({ boardId }).get, (data) => ({
        ...data,
        cards: moveCard(data.cards, cardId, column, before)?.nextCards ?? data.cards,
      })),
  }
);`;

const landingSlots: LandingSlots = {
  ChimeCanvas: (props) => <ChimeCanvas {...props} />,
  CopyCommand: (props) => <CopyCommand {...props} />,
  LandingFont: () => <LandingFont />,
  HeroCodeWindow: (props) => <HeroCodeWindow {...props} />,
  ModeCard: (props) => <ModeCard {...props} />,
  Reveal: (props) => <Reveal {...props} />,
  StackReveal: (props) => <StackReveal {...props} />,
  Link: (props) => <Link {...props} />,
  SyncDemo: () => <SyncDemo />,
};

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const entries = Object.entries(FILES) as [FileName, string][];
    const lines = FILES["pages/index.tsx"].split("\n");
    const hintLine = lines.findIndex((line) => line.includes(".page(("));
    const hintSource = lines[hintLine];
    const data = {
      codeHtmlMap: Object.fromEntries(
        entries.map(([name, code]) => [name, highlighter.highlightToHtml(code, { lang: "tsx" })])
      ) as Record<FileName, string>,
      hintPosition:
        hintSource === undefined ? undefined : { column: hintSource.length, line: hintLine },
      syncClientHtml: highlighter.highlightToHtml(SYNC_CLIENT, { lang: "tsx" }),
      syncServerHtml: highlighter.highlightToHtml(SYNC_SERVER, { lang: "tsx" }),
    };
    return {
      content: await createCompositeComponent<LandingSlots>((slots) => (
        <LandingServer slots={slots} {...data} />
      )),
    };
  })
  .head(() => ({
    links: [{ href: "/", rel: "canonical" }],
    meta: [
      { title: "Furin — The React framework that rings fast" },
      {
        content:
          "Furin is a React meta-framework on Elysia and Bun: SSR, SSG and ISR per route, SPA navigation, end-to-end TypeScript inference, native HMR and single-binary compile.",
        name: "description",
      },
    ],
  }))
  .page(({ content }) => <CompositeComponent {...landingSlots} src={content} />);
