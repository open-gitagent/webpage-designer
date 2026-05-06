import { useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { MediaPanel } from "./components/MediaPanel";
import { useAgentSession } from "./lib/agentWs";
import type { ProjectMeta } from "./lib/types";

export default function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const reloadTimer = useRef<number | null>(null);

  const onFileChanged = (_relPath: string) => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => setReloadKey((k) => k + 1), 250);
  };

  const session = useAgentSession({ projectId: active, onFileChanged });

  const triggerBrandBook = () => {
    if (!active) return;
    session.send(BRAND_BOOK_PROMPT);
  };

  useEffect(() => {
    refreshProjects().then((list) => {
      if (list.length > 0 && !active) setActive(list[0].id);
    });
  }, []);

  async function refreshProjects() {
    const res = await fetch("/api/projects");
    const list = (await res.json()) as ProjectMeta[];
    setProjects(list);
    return list;
  }

  async function createProject() {
    const name = newName.trim() || "Untitled";
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const meta = (await res.json()) as ProjectMeta;
    setShowCreate(false);
    setNewName("");
    await refreshProjects();
    setActive(meta.id);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">d</span>
          <span>designer</span>
          <span className="descriptor">a brand-tier site forge</span>
        </div>
        <div className="tagline">
          Volume <span className="vol">i</span> · MMXXVI <br />
          built on gitclaw · powered by claude
        </div>
        <select
          className="proj-select"
          value={active ?? ""}
          onChange={(e) => setActive(e.target.value || null)}
          disabled={projects.length === 0}
        >
          {projects.length === 0 ? <option value="">no projects</option> : null}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.id}
            </option>
          ))}
        </select>
        <button className="btn-new" onClick={() => setShowCreate(true)}>
          + new project
        </button>
        <span className={`status ${session.connected ? "connected" : ""}`}>
          <span className="pip" />
          {session.connected ? "live" : "offline"}
        </span>
      </header>

      <MediaPanel
        projectId={active}
        onSystemMessage={session.pushSystem}
        onPromptAgent={session.send}
        onFileChanged={onFileChanged}
        onVoiceTaskStart={session.beginVoiceTask}
        onVoiceTaskEnd={session.endVoiceTask}
        onDesignerMessage={session.feedAgentMessage}
      />

      <Preview
        projectId={active}
        reloadKey={reloadKey}
        running={session.running}
        currentTool={session.currentTool}
        onBrandBook={triggerBrandBook}
      />

      <Chat session={session} disabled={!active} />

      {showCreate ? (
        <div className="modal-bg" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>new project</h2>
            <div className="sub">working title — editable later</div>
            <input
              type="text"
              value={newName}
              placeholder="working title…"
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createProject();
              }}
            />
            <div className="row">
              <button onClick={() => setShowCreate(false)}>cancel</button>
              <button onClick={createProject}>create</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const BRAND_BOOK_PROMPT = `Spawn a brand book that complements the existing website. **DO NOT** modify \`index.html\`, \`styles.css\`, or \`script.js\` — those belong to the live website and another agent may be touching them right now. Read \`index.html\` first to understand the brand voice and palette.

Then write FIVE new files in a single assistant turn as PARALLEL write_file calls:

- \`manifesto.html\` — the brand's voice in one strong page. Tagline, positioning sentence, hero photograph if available, a short narrative block.
- \`system.html\` — visual system. Color tokens (named, with hex), typography pairing (live specimen lines for display + body), motion principles, photography direction notes.
- \`gallery.html\` — mood / inspiration. 3-6 photographs that anchor the aesthetic. Asymmetric layout; never a 3xN card grid. Each photo with photographer attribution.
- \`application.html\` — the system applied in context: a sample homepage section, a product card, a callout. Same tokens, different page, proves the system works.
- \`brand-book.css\` — shared styles for the four pages. Do not import \`styles.css\`; the brand book is its own visual world. Use the same palette and fonts as the website to stay coherent.

Cross-link the four with a small persistent nav at the top of each: manifesto / system / gallery / application. Same nav on every page. Hairline-thin, lowercase, current page highlighted subtly.

Fire ALL FIVE write_file calls in PARALLEL in the same assistant turn. The user is watching the iframe; serialized writes feel slow.`;
