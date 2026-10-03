import type { Context, Elysia } from "elysia";
import { createContext } from "elysia/context";
import { installMutationHandlers } from "./mutation-handler.ts";

const applications = new WeakMap<object, Elysia>();
const boundApplications = new WeakSet<Elysia>();

/** Bind the final application's models, guards and normalization to native request contexts. */
export function bindSyncValidation(app: Elysia): void {
  installMutationHandlers(app);
  if (boundApplications.has(app)) {
    return;
  }
  boundApplications.add(app);
  // Elysia shares its empty Context class; a decoration gives each app its own class.
  app.decorate("_furinSyncValidation", true);
  app.wrap((fetch) => {
    applications.set(createContext(app), app);
    return fetch;
  });
  app.setup((root) => {
    applications.set(createContext(root), root);
  });
}

export function syncValidationApp(context: Context): Elysia {
  const app = applications.get(context.constructor);
  if (!app) {
    throw new Error(
      "[furin] Install furinSync on the final Elysia application, or mount furin({ sync }), before using mutation()."
    );
  }
  return app;
}
