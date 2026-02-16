import { createRoute } from "elysion/client";

const route = createRoute({
  loader: () => {
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
});

export default route.page({
  component: ({ user, users }) => (
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
        <span>
          Connecté en tant que: <strong>{user.name}</strong>
        </span>
      </div>

      <h2>Liste des utilisateurs</h2>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginTop: "20px",
        }}
      >
        <thead>
          <tr style={{ background: "#f8f9fa" }}>
            <th style={{ padding: "12px", textAlign: "left", border: "1px solid #dee2e6" }}>ID</th>
            <th style={{ padding: "12px", textAlign: "left", border: "1px solid #dee2e6" }}>Nom</th>
            <th style={{ padding: "12px", textAlign: "left", border: "1px solid #dee2e6" }}>
              Email
            </th>
            <th style={{ padding: "12px", textAlign: "left", border: "1px solid #dee2e6" }}>
              Rôle
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>{u.id}</td>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>{u.name}</td>
              <td style={{ padding: "12px", border: "1px solid #dee2e6" }}>{u.email}</td>
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
    </main>
  ),
});
