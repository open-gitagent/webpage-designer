import { useMemo } from "react";
import { Folder, Loader2 } from "lucide-react";

interface Props {
  projectId: string;
  files: string[]; // relative to site/, e.g. "assets/hero.jpg"
}

const IMG_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;

/**
 * Live "site/assets/" folder view shown over the iframe before index.html
 * has been touched. Each file_changed event for an image lands here as a
 * thumbnail with an entrance animation, so the user sees the build
 * happening in real time before the page itself draws in.
 */
export function AssetReel({ projectId, files }: Props) {
  const assets = useMemo(
    () =>
      files
        .filter((f) => IMG_RE.test(f))
        .filter((f, i, arr) => arr.indexOf(f) === i),
    [files],
  );
  const otherFiles = useMemo(
    () => files.filter((f) => !IMG_RE.test(f)),
    [files],
  );

  return (
    <div className="asset-reel" aria-hidden="true">
      <div className="reel-header">
        <Folder size={16} strokeWidth={1.75} />
        <span className="reel-path">site/assets/</span>
        <span className="reel-count">{assets.length} {assets.length === 1 ? "file" : "files"}</span>
        <span className="reel-status">
          <Loader2 size={12} strokeWidth={1.75} className="reel-spin" />
          composing
        </span>
      </div>

      <div className="reel-grid">
        {assets.length === 0 ? (
          <div className="reel-empty">
            <span className="reel-empty-pulse" />
            waiting for first asset…
          </div>
        ) : (
          assets.map((asset, idx) => {
            const name = asset.replace(/^assets\//, "");
            const url = `/preview/${projectId}/site/${asset}`;
            return (
              <div
                className="reel-tile"
                key={asset}
                style={{ animationDelay: `${Math.min(idx * 60, 600)}ms` }}
              >
                <div className="reel-thumb">
                  <img src={url} alt={name} loading="lazy" />
                </div>
                <span className="reel-name" title={name}>{name}</span>
              </div>
            );
          })
        )}
      </div>

      {otherFiles.length > 0 ? (
        <div className="reel-other">
          <span className="reel-other-label">other writes</span>
          {otherFiles.slice(-6).map((f) => (
            <span className="reel-chip" key={f}>{f}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
