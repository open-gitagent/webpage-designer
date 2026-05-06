import { useEffect, useMemo, useRef, useState } from "react";
import type { CurrentTool } from "../lib/agentWs";
import { BuildingOverlay } from "./BuildingOverlay";
import { AssetReel } from "./AssetReel";

interface Props {
  projectId: string | null;
  reloadKey: number;
  running: boolean;
  currentTool: CurrentTool | null;
  onBrandBook: () => void;
  showShimmer: boolean;
  runFiles: string[];
}

const BLANK = "about:blank";

type Viewport = "fit" | "desktop" | "tablet" | "mobile";
const VIEWPORTS: { id: Viewport; label: string; w: string }[] = [
  { id: "fit", label: "fit", w: "—" },
  { id: "tablet", label: "820", w: "820" },
  { id: "mobile", label: "390", w: "390" },
];

export function Preview({
  projectId,
  reloadKey,
  running,
  currentTool,
  onBrandBook,
  showShimmer,
  runFiles,
}: Props) {
  const indexTouchedThisRun = useMemo(
    () => runFiles.some((f) => f === "index.html" || f.endsWith("/index.html")),
    [runFiles],
  );
  const showAssetReel = !!projectId && running && !indexTouchedThisRun;

  // Two iframe buffers; the visible one is `front`, the offscreen one preloads next.
  const [src0, setSrc0] = useState(BLANK);
  const [src1, setSrc1] = useState(BLANK);
  const [front, setFront] = useState<0 | 1>(0);
  // Tracks which buffer is awaiting onLoad. Tagged with a navigation
  // sequence number so a late onLoad from a cancelled load can't swap
  // us to a stale URL.
  const pending = useRef<{ buf: 0 | 1; nav: number } | null>(null);
  // Monotonic navigation counter. Bumped on every effect run, embedded
  // in the iframe URL, so that revisiting the same file (or rapid-fire
  // tab clicks) always produces a unique URL — without this, React
  // sees identical src props, the iframe never re-loads, onLoad never
  // fires, and the front buffer stays stuck on the old page.
  const navRef = useRef(0);

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

  // Cross-fade buffer swap on every navigation. The nav counter in
  // the URL guarantees iframe reload + onLoad fire even when the
  // logical URL (project / file / reloadKey) hasn't changed.
  useEffect(() => {
    if (!projectId) {
      setSrc0(BLANK);
      setSrc1(BLANK);
      setFront(0);
      pending.current = null;
      return;
    }
    navRef.current += 1;
    const nav = navRef.current;
    const url = `/preview/${projectId}/site/${activeFile}?_=${reloadKey}&n=${nav}`;
    const next: 0 | 1 = front === 0 ? 1 : 0;
    pending.current = { buf: next, nav };
    if (next === 0) setSrc0(url);
    else setSrc1(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reloadKey, activeFile]);

  const onLoadFor = (buf: 0 | 1) => () => {
    const p = pending.current;
    if (!p || p.buf !== buf) return;
    // Only swap if this onLoad is for the most recent navigation.
    // A stale onLoad (from a cancelled src change racing with a new
    // one) would otherwise flip us back to the wrong page.
    if (p.nav !== navRef.current) return;
    setFront(buf);
    pending.current = null;
  };

  return (
    <div className="panel-preview">
      <div className="preview-bar">
        <div className="tabs-list">
          {projectId && files.length > 0 ? (
            files.map((f) => {
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
            })
          ) : (
            <span className="bar-placeholder">no project</span>
          )}
        </div>
        <div className="bar-actions">
          <button
            className="vp-btn brand-book-btn"
            onClick={onBrandBook}
            disabled={!projectId}
            title="Spawn a parallel agent to generate a 4-page brand book"
          >
            + brand book
          </button>
          <span className="vp-sep" />
          <div className="vp-toggle">
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
          {projectId ? (
            <>
              <span className="vp-sep" />
              <a
                className="bar-link"
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                title={`open ${activeFile} in new tab`}
              >
                open ↗
              </a>
            </>
          ) : null}
        </div>
      </div>

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
          <BuildingOverlay running={running && showShimmer && !showAssetReel} />
          {showAssetReel && projectId ? (
            <AssetReel projectId={projectId} files={runFiles} />
          ) : null}
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
