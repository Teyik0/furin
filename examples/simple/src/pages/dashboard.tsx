import { t } from "elysia";
import { createRoute } from "elysion/client";

const route = createRoute({
  query: t.Object({ visits: t.Number() }),
  loader: ({ query: { visits } }) => {
    const lastLogin = new Date().toLocaleDateString("fr-FR");

    return {
      user: {
        name: "Utilisateur Connecté",
        email: "user@example.com",
        role: "user",
      },
      stats: {
        visits,
        lastLogin,
      },
    };
  },
});

export default route.page({
  component: ({ user, stats }) => (
    <main
      style={{
        maxWidth: "800px",
        margin: "50px auto",
        padding: "20px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "30px",
        }}
      >
        <h1>Dashboard</h1>
      </div>

      <div
        style={{
          padding: "20px",
          background: "#f8f9fa",
          borderRadius: "8px",
          marginBottom: "20px",
        }}
      >
        <h2>Profil utilisateur</h2>
        <p>
          <strong>Nom:</strong> {user.name}
        </p>
        <p>
          <strong>Email:</strong> {user.email}
        </p>
        <p>
          <strong>Rôle:</strong> {user.role}
        </p>
      </div>

      <div
        style={{
          padding: "20px",
          background: "#e7f3ff",
          borderRadius: "8px",
          marginBottom: "20px",
        }}
      >
        <h2>Statistiques</h2>
        <p>
          <strong>Visites:</strong> {stats.visits}
        </p>
        <p>
          <strong>Dernière connexion:</strong> {stats.lastLogin}
        </p>
      </div>
    </main>
  ),
});
