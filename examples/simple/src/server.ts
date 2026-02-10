import { Elysia, t } from "elysia";
import { elysion } from "elysion";

// Mock database d'utilisateurs
const users = new Map([
  ["user1-token", { id: "1", email: "user@example.com", name: "John Doe", role: "user" }],
  ["admin-token", { id: "2", email: "admin@example.com", name: "Admin", role: "admin" }],
]);

// Type pour les utilisateurs
interface User {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
}

// Plugin avec macros d'authentification
const authPlugin = new Elysia({ name: "auth" })
  .macro("isAuthenticated", {
    resolve({ cookie: { session } }) {
      const token = session?.value;

      if (!token || typeof token !== "string") {
        return { user: null as User | null, isAuthenticated: false };
      }

      const user = users.get(token);

      if (!user) {
        return { user: null as User | null, isAuthenticated: false };
      }

      return { user, isAuthenticated: true };
    },
  })
  .macro("isAdmin", {
    isAuthenticated: true,
    resolve: ({ user, isAuthenticated, status }) => {
      if (!(isAuthenticated && user)) {
        return status(401, "Unauthorized");
      }

      if (user.role !== "admin") {
        return status(403, "Forbidden");
      }

      return { isAdmin: true };
    },
  });

const app = new Elysia()
  .use(authPlugin)
  .use(
    await elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
        staticLimit: 1024,
        alwaysStatic: process.env.NODE_ENV === "production",
      },
    })
  )
  .post(
    "/api/login",
    ({ body, cookie: { session } }) => {
      const { email } = body as { email: string };

      // Trouve l'utilisateur par email
      const user = Array.from(users.entries()).find(([_, u]) => u.email === email);

      if (!user) {
        return { success: false, error: "Utilisateur non trouvé" };
      }

      const [token] = user;

      // Crée le cookie de session (syntaxe native Elysia)
      if (session) {
        session.value = token;
        session.httpOnly = true;
        session.maxAge = 7 * 86_400; // 7 jours
        session.path = "/";
      }

      return { success: true };
    },
    {
      body: t.Object({
        email: t.String(),
      }),
    }
  )
  .post("/api/logout", ({ cookie: { session } }) => {
    // Supprime le cookie en l'expirant
    if (session) {
      session.value = "";
      session.maxAge = 0;
    }
    return { success: true };
  })
  .listen(3000);

console.log(`\n🦊 elysion running at http://localhost:${app.server?.port}`);
console.log("\nUsers disponibles:");
console.log("- user@example.com (role: user)");
console.log("- admin@example.com (role: admin)");
