interface Props {
  running: boolean;
}

/**
 * Translucent skeleton overlay shown on top of the iframe while the agent
 * is mid-build. Reads as "page is being constructed" without hiding the
 * partial render underneath.
 */
export function BuildingOverlay({ running }: Props) {
  return (
    <div className={`building-overlay ${running ? "show" : ""}`} aria-hidden="true">
      <div className="bo-grid">
        <div className="bo-block bo-nav" />
        <div className="bo-block bo-hero-title" />
        <div className="bo-block bo-hero-sub" />
        <div className="bo-block bo-meta" />
        <div className="bo-row">
          <div className="bo-block bo-tile" />
          <div className="bo-block bo-tile" />
          <div className="bo-block bo-tile" />
        </div>
        <div className="bo-block bo-section" />
        <div className="bo-block bo-section bo-section-short" />
        <div className="bo-block bo-foot" />
      </div>
      <div className="bo-status">
        <span className="bo-pip" />
        composing
      </div>
    </div>
  );
}
