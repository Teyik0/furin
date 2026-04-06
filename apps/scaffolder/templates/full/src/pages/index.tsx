import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { route } from "./root";

export default route.page({
  loader: async ({ request }) => {
    const base = new URL(request.url).origin;
    const res = await fetch(`${base}/api/hello`);
    return (await res.json()) as { message: string; source: string };
  },
  component: ({ message, source }) => {
    return (
      <div className="w-full space-y-8">
        <div className="space-y-2">
          <h1 className="font-bold text-4xl tracking-tight">Welcome to Furin</h1>
          <p className="text-lg text-muted-foreground">
            A React meta-framework built on Elysia + Bun.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>API Response</CardTitle>
            <CardDescription>Live data from your Elysia backend</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md bg-muted p-4 font-mono text-sm">
              <p>
                <span className="text-muted-foreground">message:</span> {message}
              </p>
              <p>
                <span className="text-muted-foreground">source:</span> {source}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>shadcn/ui Components</CardTitle>
            <CardDescription>Ready-to-use accessible components</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Input className="max-w-xs" placeholder="Type something..." />
            <Button>Get started</Button>
            <Button variant="outline">Read the docs</Button>
          </CardContent>
        </Card>
      </div>
    );
  },
});
