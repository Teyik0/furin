/** A `furin({ pagesDir, prefix })` call, as declared by the application. */
export interface FurinRegistration {
  /** pagesDir as declared (`src/pages` when omitted); relative to the project root. */
  readonly pagesDir: string;
  /** Normalized mount prefix (`""` for root). */
  readonly prefix: string;
}

// Shared through globalThis: the build's Elysia AOT worker installs the list
// before evaluating the application, whichever copy of Furin it loads.
const REGISTRATIONS = Symbol.for("@teyik0/furin/registrations");

interface RegistrationGlobal {
  [REGISTRATIONS]?: FurinRegistration[];
}

/** Starts recording `furin()` calls in this process. */
export function collectFurinRegistrations(): FurinRegistration[] {
  const registrations: FurinRegistration[] = [];
  (globalThis as RegistrationGlobal)[REGISTRATIONS] = registrations;
  return registrations;
}

/** Records a `furin()` call while a build evaluates the application. */
export function recordFurinRegistration(registration: FurinRegistration): void {
  (globalThis as RegistrationGlobal)[REGISTRATIONS]?.push(registration);
}
