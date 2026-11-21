"use client";

import { useEffect, useRef, useState } from "react";

// Renders text clamped to `lines` lines. A "See more" / "See less" toggle is
// shown only when the text actually overflows the clamp, so short titles look
// exactly as before and very long ones (e.g. pasted command-bar instructions)
// stay readable without flooding the list.
export function ExpandableText({ text, lines = 3 }: { text: string; lines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => {
      // While collapsed the body is clamped, so scrollHeight exceeding
      // clientHeight means text is hidden. While expanded the toggle must
      // stay visible so the text can be collapsed again.
      setOverflowing(expanded || el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <span className="expandable-text">
      <span
        ref={textRef}
        className="expandable-text-body"
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {text}
      </span>
      {overflowing ? (
        <button type="button" className="see-more-button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "See less" : "See more"}
        </button>
      ) : null}
    </span>
  );
}
