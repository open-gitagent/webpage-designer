import { useEffect, useRef, useState } from "react";
import type { useAgentSession } from "../lib/agentWs";

interface Props {
  session: ReturnType<typeof useAgentSession>;
  disabled: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  user: "you",
  assistant: "designer",
  tool: "tool",
  system: "system",
};

export function Chat({ session, disabled }: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.items.length, session.items[session.items.length - 1]?.text]);

  function submit() {
    const text = draft.trim();
    if (!text || disabled || session.running) return;
    session.send(text);
    setDraft("");
  }

  const ghostText = session.currentTool
    ? `${session.activity} — ${session.currentTool.name} ${session.currentTool.summary}`
    : session.activity;

  return (
    <div className="panel-chat">
      <div className="messages" ref={scrollRef}>
        {session.items.length === 0 ? (
          <div className="welcome">
            <div className="lead">Tell me what you want to build.</div>
            Describe a brand, a vibe, a single page. I'll commit to a direction and ship a first cut. <br />
            Try: <em>"a brutalist landing for a new espresso brand called Crude — raw concrete tones, monumental serif type, asymmetric grid."</em>
          </div>
        ) : null}
        {session.items.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role !== "system" ? <span className="label">{ROLE_LABEL[m.role] ?? m.role}</span> : null}
            {m.text}
            {m.meta ? <span className="label" style={{ marginTop: "0.5rem" }}>{m.meta}</span> : null}
          </div>
        ))}
        {session.running ? (
          <div className="ghost-row">
            <span className="ghost-label">designer</span>
            <span className="ghost-activity">
              {ghostText}
              <span className="dots">
                <i></i>
                <i></i>
                <i></i>
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="composer">
        <div className="composer-input">
          <textarea
            placeholder={disabled ? "select or create a project to begin…" : "describe a change…"}
            value={draft}
            disabled={disabled || session.running}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="actions">
            {session.running ? (
              <button className="stop" onClick={session.abort}>stop</button>
            ) : (
              <button className="send" onClick={submit} disabled={disabled || !draft.trim()}>
                send →
              </button>
            )}
          </div>
        </div>
        <div className="toolbar">
          <span>⌘ + return</span>
          {session.running ? <span className="live">designing</span> : null}
          {session.connected ? null : <span>· disconnected</span>}
        </div>
      </div>
    </div>
  );
}
