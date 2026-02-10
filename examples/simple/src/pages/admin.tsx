import { t } from "elysia";
import { page } from "elysion";

export default page(Admin, {
  // Active les macros isAdmin (qui hérite de isAuthenticated)
  loader: {
    isAdmin: true,
    handler: () => {
      // Liste des utilisateurs pour l'admin
      const users = [
        { id: "1", name: "John Doe", email: "user@example.com", role: "user" },
        { id: "2", name: "Admin", email: "admin@example.com", role: "admin" },
      ];

      return {
        user: {
          name: "Administrateur",
          email: "admin@example.com",
          role: "admin",
        },
        users,
      };
    },
  },

  // Action POST pour créer un nouvel utilisateur
  action: {
    body: t.Object({
      name: t.String(),
      email: t.String(),
      role: t.Union([t.Literal("user"), t.Literal("admin")]),
    }),
    isAdmin: true,
    handler: ({ body }) => {
      // Simule la création d'un utilisateur
      const newUser = {
        id: Math.random().toString(36).substring(7),
        name: body.name,
        email: body.email,
        role: body.role,
      };

      // Dans une vraie app, on sauverait en DB ici
      console.log("Nouvel utilisateur créé:", newUser);

      return {
        success: true,
        message: `Utilisateur ${body.name} créé avec succès`,
        user: newUser,
      };
    },
  },
});

function Admin({ user, users }) {
  return (
    <main
      style={{
        maxWidth: "1000px",
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
        <h1>Panel Admin</h1>
        <div>
          <span style={{ marginRight: "15px" }}>
            Connecté en tant que: <strong>{user.name}</strong>
          </span>
          <a
            href="/dashboard"
            style={{
              padding: "8px 15px",
              background: "#6c757d",
              color: "white",
              textDecoration: "none",
              borderRadius: "4px",
              marginRight: "10px",
            }}
          >
            Dashboard
          </a>
          <a
            href="/"
            style={{
              padding: "8px 15px",
              background: "#dc3545",
              color: "white",
              textDecoration: "none",
              borderRadius: "4px",
            }}
          >
            Déconnexion
          </a>
        </div>
      </div>

      <div
        style={{
          padding: "20px",
          background: "#d1ecf1",
          borderRadius: "8px",
          marginBottom: "30px",
        }}
      >
        <h2>🔒 Zone sécurisée</h2>
        <p>
          Cette page utilise les macros <code>isAdmin</code> qui:
        </p>
        <ul>
          <li>Vérifie que vous êtes authentifié (hérite de isAuthenticated)</li>
          <li>Vérifie que vous avez le rôle "admin"</li>
          <li>Retourne 403 Forbidden si ce n'est pas le cas</li>
        </ul>
      </div>

      <h2>Liste des utilisateurs</h2>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: "20px",
          marginBottom: "30px",
        }}
      >
        <thead>
          <tr style={{ background: "#f8f9fa" }}>
            <th
              style={{
                padding: "12px",
                textAlign: "left",
                border: "1px solid #dee2e6",
              }}
            >
              ID
            </th>
            <th
              style={{
                padding: "12px",
                textAlign: "left",
                border: "1px solid #dee2e6",
              }}
            >
              Nom
            </th>
            <th
              style={{
                padding: "12px",
                textAlign: "left",
                border: "1px solid #dee2e6",
              }}
            >
              Email
            </th>
            <th
              style={{
                padding: "12px",
                textAlign: "left",
                border: "1px solid #dee2e6",
              }}
            >
              Rôle
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>
                {u.id}
              </td>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>
                {u.name}
              </td>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>
                {u.email}
              </td>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    background: u.role === "admin" ? "#dc3545" : "#007bff",
                    color: "white",
                    fontSize: "12px",
                  }}
                >
                  {u.role}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div
        style={{
          padding: "20px",
          background: "#fff3cd",
          borderRadius: "8px",
          fontSize: "14px",
        }}
      >
        <h3>💡 Exemple d'action POST</h3>
        <p>
          Cette page définit aussi une <strong>action POST</strong> accessible
          sur le même chemin:
        </p>
        <pre
          style={{
            background: "#f8f9fa",
            padding: "10px",
            borderRadius: "4px",
            overflow: "auto",
          }}
        >
          {`POST /admin
Body: { name: string, email: string, role: "user" | "admin" }

// L'action utilise aussi la macro isAdmin pour la sécurité`}
        </pre>
      </div>
    </main>
  );
}
