import { useEffect, useRef, useState } from "react";
import type { CurrentTool } from "../lib/agentWs";

interface Props {
  projectId: string | null;
  reloadKey: number;
  running: boolean;
  currentTool: CurrentTool | null;
}

const BLANK = "about:blank";

export function Preview({ projectId, reloadKey, running, currentTool }: Props) {
  // Two buffers; the visible one is `front`, the offscreen one preloads next.
  const [src0, setSrc0] = useState(BLANK);
  const [src1, setSrc1] = useState(BLANK);
  const [front, setFront] = useState<0 | 1>(0);
  const pendingBuf = useRef<0 | 1 | null>(null);

  const previewUrl = projectId ? `/preview/${projectId}/site/index.html?_=${reloadKey}` : BLANK;

  useEffect(() => {
    if (!projectId) {
      setSrc0(BLANK);
      setSrc1(BLANK);
      setFront(0);
      return;
    }
    // Load the new URL into the back buffer; the onLoad handler will swap.
    const next: 0 | 1 = front === 0 ? 1 : 0;
    pendingBuf.current = next;
    if (next === 0) setSrc0(previewUrl);
    else setSrc1(previewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reloadKey]);

  const onLoadFor = (buf: 0 | 1) => () => {
    // Only swap if this load corresponds to a pending swap request.
    if (pendingBuf.current === buf) {
      setFront(buf);
      pendingBuf.current = null;
    }
  };

  return (
    <div className="panel-preview">
      <div className="preview-bar">
        <span className="label">preview</span>
        <span className="url">{projectId ? `/preview/${projectId}/site/` : "no project"}</span>
        {projectId ? (
          <a href={previewUrl} target="_blank" rel="noreferrer">
            open in new tab ↗
          </a>
        ) : null}
      </div>
      <div className="iframe-host">
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
