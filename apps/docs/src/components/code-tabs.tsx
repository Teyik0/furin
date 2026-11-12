import { useState } from "react";
import { COPY_ICON_PATH, COPY_ICON_RECT } from "./code-copy-icon-shape";

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
    <div className="not-prose workbench-code-window">
      <div className="workbench-code-bar">
        <fieldset aria-label="Code examples" className="workbench-code-tabs">
          {tabs.map((tab, i) => (
            <button
              aria-pressed={i === active}
              key={tab.props.title}
              onClick={() => setActive(i)}
              type="button"
            >
              {tab.props.title}
            </button>
          ))}
        </fieldset>
        {/* Copy handled by the delegated document listener (code-copy-bridge). */}
        <button aria-label="Copy code" data-code-copy="" type="button">
          <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <rect {...COPY_ICON_RECT} />
            <path d={COPY_ICON_PATH} />
          </svg>
        </button>
      </div>
      {tabs[active]}
    </div>
  );
}
