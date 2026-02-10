import { t } from "elysia";
import { page } from "elysion/react";

export default page(Dashboard, {
  query: t.Object({
    visits: t.Optional(t.Number()),
  }),
  loader: {
    isAuthenticated: true,
    handler: ({ query }) => {
      const lastLogin = new Date().toLocaleDateString("fr-FR");

      return {
        user: {
          name: "Utilisateur Connecté",
          email: "user@example.com",
          role: "user",
        },
        stats: {
          visits: query.visits,
          lastLogin,
        },
      };
    },
  },
});

function Dashboard({ user, stats }) {
  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/";
  };

  return (
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
        <button
          onClick={handleLogout}
          style={{
            padding: "10px 20px",
            background: "#dc3545",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
          type="button"
        >
          Déconnexion
        </button>
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

      <div
        style={{
          padding: "15px",
          background: "#fff3cd",
          borderRadius: "8px",
          fontSize: "14px",
        }}
      >
        <strong>💡 Info:</strong> Cette page utilise la macro <code>isAuthenticated</code> définie dans server.ts. Si vous n'êtes pas
        connecté, vous serez redirigé vers la page de login.
      </div>

      <div style={{ marginTop: "20px" }}>
        <a
          href="/admin"
          style={{
            display: "inline-block",
            padding: "10px 20px",
            background: "#28a745",
            color: "white",
            textDecoration: "none",
            borderRadius: "4px",
            marginRight: "10px",
          }}
        >
          Aller à l'Admin (nécessite droits admin)
        </a>
      </div>
    </main>
  );
}
