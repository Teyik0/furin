// Child process of `furin build`: evaluates the server entry with furin() in
// discovery mode and writes the mounts it registers as JSON.
// Usage: bun discover-mounts-process.ts <serverEntry> <resultPath>
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { collectFurinRegistrations } from "../server/registrations.ts";
import { loadServerEntry } from "../server/server-entry.ts";

const [serverEntry, resultPath] = process.argv.slice(2) as [string, string];
// Same module transforms as the Elysia AOT evaluation of the built entry.
Bun.plugin(isomorphicTransformPlugin("server"));
const registrations = collectFurinRegistrations(true);
await loadServerEntry(() => import(serverEntry));
await Bun.write(resultPath, JSON.stringify(registrations));
process.exit(0);
