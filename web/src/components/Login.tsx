import { useState } from "react";

interface Props {
  onAuthed: () => void;
}

export function Login({ onAuthed }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      onAuthed();
    } catch (err: any) {
      setError(err?.message ?? "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="mark" />
          <span className="login-name">GitAgent</span>
          <span className="login-sub">brand designer</span>
        </div>
        <div className="login-tag">an uncommon growth tool</div>
        <label className="login-field">
          <span>username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="login-field">
          <span>password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error ? <div className="login-error">{error}</div> : null}
        <button type="submit" className="login-submit" disabled={busy || !username || !password}>
          {busy ? "signing in…" : "enter →"}
        </button>
      </form>
    </div>
  );
}
