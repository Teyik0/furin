import { page } from "elysion/react";
import { useState } from "react";
import "../../public/global.css";

export default page(() => {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const handleLogin = async (e: React.SubmitEvent) => {
    e.preventDefault();

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (data.success) {
        setMessage("Connecté ! Redirection...");
        setTimeout(() => {
          window.location.href = "/dashboard";
        }, 1000);
      } else {
        setMessage(data.error || "Erreur de connexion");
      }
    } catch {
      setMessage("Erreur réseau");
    }
  };

  return (
    <main
      style={{
        maxWidth: "400px",
        margin: "100px auto",
        padding: "20px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Bienvenue sur Elysion</h1>
      <p>Framework React + Elysia avec macros d'authentification</p>

      <form
        onSubmit={handleLogin}
        style={{
          marginTop: "30px",
          padding: "20px",
          border: "1px solid #ddd",
          borderRadius: "8px",
        }}
      >
        <h2>Connexion</h2>
        <div style={{ marginBottom: "15px" }}>
          <label htmlFor="email">Email:</label>
          <input
            id="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            required
            style={{
              width: "100%",
              padding: "8px",
              marginTop: "5px",
              border: "1px solid #ccc",
              borderRadius: "4px",
            }}
            type="email"
            value={email}
          />
        </div>
        <button
          style={{
            width: "100%",
            padding: "10px",
            background: "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
          type="submit"
        >
          Se connecter
        </button>
      </form>

      {message && (
        <div
          style={{
            marginTop: "15px",
            padding: "10px",
            background: message.includes("Connecté") ? "#d4edda" : "#f8d7da",
            color: message.includes("Connecté") ? "#155724" : "#721c24",
            borderRadius: "4px",
          }}
        >
          {message}
        </div>
      )}

      <div
        style={{
          marginTop: "30px",
          padding: "15px",
          background: "#f8f9fa",
          borderRadius: "8px",
          fontSize: "14px",
        }}
      >
        <strong>Utilisateurs de test:</strong>
        <ul style={{ marginTop: "10px" }}>
          <li>
            <code>user@example.com</code> - Utilisateur standard
          </li>
          <li>
            <code>admin@example.com</code> - Administrateur
          </li>
        </ul>
      </div>
    </main>
  );
});
