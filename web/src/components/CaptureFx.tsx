import { useEffect, useState } from "react";

interface Props {
  fireKey: number;
}

/**
 * Camera-capture overlay shown briefly on top of the live video.
 * Driven by an integer key that bumps on each capture.
 */
export function CaptureFx({ fireKey }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (fireKey === 0) return;
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 760);
    return () => window.clearTimeout(t);
  }, [fireKey]);

  if (!visible) return null;

  return (
    <div className="cam-capture-fx" key={fireKey} aria-hidden="true">
      <span className="cap-corner cap-tl" />
      <span className="cap-corner cap-tr" />
      <span className="cap-corner cap-bl" />
      <span className="cap-corner cap-br" />
      <span className="cap-scan" />
      <span className="cap-flash" />
      <span className="cap-stamp">captured</span>
    </div>
  );
}
