import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { getHelloPayload } from "@/api/hello";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { route as parentRoute } from "./root";

export const route = defineRoute()
  .config({ layout: parentRoute })
  .loader(() => getHelloPayload())
  .page(({ data: { message, source } }) => (
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
          <Button asChild variant="outline">
            <Link rel="noopener noreferrer" target="_blank" to="https://teyik0.github.io/furin/">
              Read the docs
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  ));
