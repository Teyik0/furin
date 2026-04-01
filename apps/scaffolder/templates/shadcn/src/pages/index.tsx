import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  component: ({ apiMessage, apiSource }) => (
    <section className="grid w-full gap-6 md:grid-cols-[1.3fr_0.9fr]">
      <Card className="border-slate-200/80 bg-white/90 shadow-slate-200/60 shadow-xl">
        <CardHeader>
          <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full bg-slate-950 px-3 py-1 font-medium text-[11px] text-white uppercase tracking-[0.24em]">
            <SparklesIcon className="size-3.5" />
            One process
          </div>
          <CardTitle className="text-3xl">Frontend rendered by Furin</CardTitle>
          <CardDescription className="max-w-xl text-base leading-7">
            This SSR page calls the local Elysia API route from its loader before rendering.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border bg-slate-950 p-4 text-slate-50">
            <p className="font-medium text-[11px] text-slate-400 uppercase tracking-[0.24em]">
              API says
            </p>
            <p className="mt-3 font-semibold text-2xl">{apiMessage}</p>
          </div>
          <div className="rounded-lg border bg-slate-50 p-4">
            <p className="font-medium text-[11px] text-slate-500 uppercase tracking-[0.24em]">
              Loader call
            </p>
            <p className="mt-3 font-mono text-[13px] text-slate-700">
              fetch(new URL("/api/hello", request.url))
            </p>
            <p className="mt-3 text-slate-600 text-sm">Source: {apiSource}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/90">
        <CardHeader>
          <CardTitle>shadcn/ui is ready</CardTitle>
          <CardDescription>
            Tailwind, tokens, and a small component set are already wired.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input placeholder="Your next API route" readOnly value="/api/users" />
          <div className="flex gap-3">
            <Button>Ship UI</Button>
            <Button variant="outline">Add route</Button>
          </div>
        </CardContent>
      </Card>
    </section>
  ),
});
