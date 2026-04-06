import { route } from "./root";

interface HelloPayload {
  message: string;
  source: string;
}

export default route.page({
  loader: async ({ request }) => {
    const response = await fetch(new URL("/api/hello", request.url));
    const payload = (await response.json()) as HelloPayload;

    return {
      apiMessage: payload.message,
      apiSource: payload.source,
    };
  },
  head: () => ({
    meta: [{ title: "My Furin App" }],
  }),
  component: ({ apiMessage, apiSource }) => (
    <section className="w-full rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-2xl shadow-slate-950/40 backdrop-blur">
      <div className="mb-6 inline-flex rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 font-medium text-emerald-200 text-xs uppercase tracking-[0.24em]">
        One process
      </div>
      <h1 className="max-w-2xl font-semibold text-4xl text-white tracking-tight">
        Frontend rendered by Furin
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-slate-300 leading-8">
        This page is server-rendered. Its loader calls the local Elysia API route before the HTML is
        sent to the browser.
      </p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-5">
          <p className="font-medium text-slate-400 text-sm uppercase tracking-[0.2em]">API says</p>
          <p className="mt-3 font-semibold text-2xl text-white">{apiMessage}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-5">
          <p className="font-medium text-slate-400 text-sm uppercase tracking-[0.2em]">
            Loaded via
          </p>
          <p className="mt-3 font-mono text-cyan-200 text-sm">
            fetch(new URL("/api/hello", request.url))
          </p>
          <p className="mt-3 text-slate-300">Source: {apiSource}</p>
        </div>
      </div>
    </section>
  ),
});
