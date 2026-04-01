import { useState } from "react";

interface CodeTabProps {
  children: React.ReactNode;
  title: string;
}

export function CodeTab({ children }: CodeTabProps) {
  return <>{children}</>;
}

interface CodeTabsProps {
  children: React.ReactNode;
}

export function CodeTabs({ children }: CodeTabsProps) {
  const [active, setActive] = useState(0);

  const tabs = (Array.isArray(children) ? children : [children]).filter(
    (child): child is React.ReactElement<CodeTabProps> =>
      // biome-ignore lint/suspicious/noExplicitAny: dynamic children check
      child !== null && typeof child === "object" && (child as any).type === CodeTab
  );

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border border-slate-700/50 shadow-black/20 shadow-lg">
      {/* Title bar with dots + tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#161b22",
          borderBottom: "1px solid rgba(99,102,241,0.15)",
        }}
      >
        {/* macOS dots */}
        <div style={{ display: "flex", gap: 6, padding: "10px 16px", flexShrink: 0 }}>
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "9999px",
              background: "rgba(239,68,68,0.8)",
            }}
          />
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "9999px",
              background: "rgba(234,179,8,0.8)",
            }}
          />
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "9999px",
              background: "rgba(34,197,94,0.8)",
            }}
          />
        </div>

        {/* File tabs */}
        <div style={{ display: "flex", borderLeft: "1px solid rgba(99,102,241,0.15)" }}>
          {tabs.map((tab, i) => (
            <button
              key={tab.props.title}
              onClick={() => setActive(i)}
              style={{
                padding: "8px 16px",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: i === active ? "#e2e8f0" : "#64748b",
                background: i === active ? "rgba(255,255,255,0.05)" : "transparent",
                borderRight: "1px solid rgba(99,102,241,0.15)",
                borderBottom: i === active ? "1px solid #161b22" : "none",
                cursor: "pointer",
                transition: "color 0.15s",
              }}
              type="button"
            >
              {tab.props.title}
            </button>
          ))}
        </div>
      </div>

      {/* Active tab content */}
      {tabs[active]}
    </div>
  );
}
