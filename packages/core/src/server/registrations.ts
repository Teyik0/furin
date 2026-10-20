/** A `furin({ pagesDir, prefix })` call, as declared by the application. */
export interface FurinRegistration {
  /** pagesDir as declared (`src/pages` when omitted); relative to the project root. */
  readonly pagesDir: string;
  /** Normalized mount prefix (`""` for root). */
  readonly prefix: string;
}

// Shared through globalThis: the build installs the collector before
// evaluating the application, whichever copy of Furin it loads.
const REGISTRATIONS = Symbol.for("@teyik0/furin/registrations");

interface RegistrationCollector {
  /** True when the build only discovers mounts: furin() must not start a runtime. */
  readonly discover: boolean;
  readonly registrations: FurinRegistration[];
}

interface RegistrationGlobal {
  [REGISTRATIONS]?: RegistrationCollector;
}

/** Starts recording `furin()` calls in this process. */
export function collectFurinRegistrations(discover: boolean): FurinRegistration[] {
  const registrations: FurinRegistration[] = [];
  (globalThis as RegistrationGlobal)[REGISTRATIONS] = { discover, registrations };
  return registrations;
}

/**
 * Records a `furin()` call while a build evaluates the application. Returns
 * true when the build only discovers mounts.
 */
export function recordFurinRegistration(registration: FurinRegistration): boolean {
  const collector = (globalThis as RegistrationGlobal)[REGISTRATIONS];
  collector?.registrations.push(registration);
  return collector?.discover === true;
}
