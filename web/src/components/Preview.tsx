import { useEffect, useRef, useState } from "react";
import type { CurrentTool } from "../lib/agentWs";
import { BuildingOverlay } from "./BuildingOverlay";

interface Props {
  projectId: string | null;
  reloadKey: number;
  running: boolean;
  currentTool: CurrentTool | null;
  onBrandBook: () => void;
}

const BLANK = "about:blank";

type Viewport = "fit" | "desktop" | "tablet" | "mobile";
const VIEWPORTS: { id: Viewport; label: string; w: string }[] = [
  { id: "fit", label: "fit", w: "—" },
  { id: "tablet", label: "820", w: "820" },
  { id: "mobile", label: "390", w: "390" },
];

export function Preview({ projectId, reloadKey, running, currentTool, onBrandBook }: Props) {
  // Two iframe buffers; the visible one is `front`, the offscreen one preloads next.
  const [src0, setSrc0] = useState(BLANK);
  const [src1, setSrc1] = useState(BLANK);
  const [front, setFront] = useState<0 | 1>(0);
  const pendingBuf = useRef<0 | 1 | null>(null);

  // Page tabs (any .html file in site/)
  const [files, setFiles] = useState<string[]>(["index.html"]);
  const [activeFile, setActiveFile] = useState<string>("index.html");

  // Responsive viewport
  const [viewport, setViewport] = useState<Viewport>("fit");

  const previewUrl = projectId
    ? `/preview/${projectId}/site/${activeFile}?_=${reloadKey}`
    : BLANK;

  // Load file list whenever the project changes or any file changes on disk.
  useEffect(() => {
    if (!projectId) {
      setFiles(["index.html"]);
      setActiveFile("index.html");
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${projectId}/site-files`)
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((data: { files: string[] }) => {
        if (cancelled) return;
        const list = data.files?.length ? data.files : ["index.html"];
        setFiles(list);
        setActiveFile((prev) => (list.includes(prev) ? prev : list[0]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  // Cross-fade buffer swap on every URL change.
  useEffect(() => {
    if (!projectId) {
      setSrc0(BLANK);
      setSrc1(BLANK);
      setFront(0);
      return;
    }
    const next: 0 | 1 = front === 0 ? 1 : 0;
    pendingBuf.current = next;
    if (next === 0) setSrc0(previewUrl);
    else setSrc1(previewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reloadKey, activeFile]);

  const onLoadFor = (buf: 0 | 1) => () => {
    if (pendingBuf.current === buf) {
      setFront(buf);
      pendingBuf.current = null;
    }
  };

  return (
    <div className="panel-preview">
      <div className="preview-bar">
        <span className="label">preview</span>
        <span className="url">{projectId ? `/preview/${projectId}/site/${activeFile}` : "no project"}</span>
        {projectId ? (
          <a href={previewUrl} target="_blank" rel="noreferrer">
            open in new tab ↗
          </a>
        ) : null}
      </div>

      {projectId && files.length > 0 ? (
        <div className="page-tabs">
          <div className="tabs-list">
            {files.map((f) => {
              const stem = f.replace(/\.html$/, "");
              return (
                <button
                  key={f}
                  className={`tab ${f === activeFile ? "active" : ""}`}
                  onClick={() => setActiveFile(f)}
                >
                  {stem || f}
                </button>
              );
            })}
          </div>
          <div className="vp-toggle">
            <button
              className="vp-btn brand-book-btn"
              onClick={onBrandBook}
              disabled={!projectId}
              title="Spawn a parallel agent to generate a 4-page brand book alongside your site"
            >
              + brand book
            </button>
            <span className="vp-sep" />
            {VIEWPORTS.map((v) => (
              <button
                key={v.id}
                className={`vp-btn ${viewport === v.id ? "active" : ""}`}
                onClick={() => setViewport(v.id)}
                title={v.id === "fit" ? "Fit to pane" : `${v.w}px wide`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="iframe-host" data-viewport={viewport}>
        <div className="viewport-frame">
          <iframe
            src={src0}
            title="preview-a"
            onLoad={onLoadFor(0)}
            className={front === 0 ? "front" : "back"}
          />
          <iframe
            src={src1}
            title="preview-b"
            onLoad={onLoadFor(1)}
            className={front === 1 ? "front" : "back"}
          />
          <BuildingOverlay running={running} />
        </div>
        {running && currentTool ? (
          <div className="preview-chip">
            <span className="pip" />
            {currentTool.name === "write_file"
              ? `writing ${currentTool.summary}`
              : currentTool.name === "edit_file"
                ? `editing ${currentTool.summary}`
                : `${currentTool.name} ${currentTool.summary}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
