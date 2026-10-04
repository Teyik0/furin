import { type ReactNode, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import { CompositeComponent, createCompositeComponent } from "../../../src/rsc.tsx";

const src = await createCompositeComponent<{ Action: () => ReactNode }>(({ Action }) => {
  async function Section() {
    await Promise.resolve();
    return (
      <section>
        <Action />
      </section>
    );
  }
  return (
    <main>
      <Suspense fallback={null}>
        <Section />
      </Suspense>
    </main>
  );
});
const stream = await renderToReadableStream(
  <CompositeComponent Action={() => <button type="button">Loaded section</button>} src={src} />
);
console.log(await new Response(stream).text());
