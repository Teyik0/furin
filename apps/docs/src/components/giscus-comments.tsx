import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import { getGiscusConfig, getGiscusTheme, getMissingGiscusConfigFields } from "@/lib/giscus";

const giscusConfig = getGiscusConfig();
const missingGiscusFields = getMissingGiscusConfigFields(giscusConfig);

export function GiscusComments() {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const container = ref.current;
    if (!container || missingGiscusFields.length > 0) {
      return;
    }

    container.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://giscus.app/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.setAttribute("data-repo", giscusConfig.repo as string);
    script.setAttribute("data-repo-id", giscusConfig.repoId as string);
    script.setAttribute("data-category", giscusConfig.category as string);
    script.setAttribute("data-category-id", giscusConfig.categoryId as string);
    script.setAttribute("data-mapping", giscusConfig.mapping);
    script.setAttribute("data-strict", giscusConfig.strict);
    script.setAttribute("data-reactions-enabled", giscusConfig.reactionsEnabled);
    script.setAttribute("data-emit-metadata", giscusConfig.emitMetadata);
    script.setAttribute("data-input-position", giscusConfig.inputPosition);
    script.setAttribute("data-lang", giscusConfig.lang);
    script.setAttribute("data-theme", getGiscusTheme(theme));

    container.append(script);

    return () => {
      container.innerHTML = "";
    };
  }, [theme]);

  return (
    <section className="mt-16 border-border border-t pt-8">
      <h2 className="mb-6 font-semibold text-lg">Comments</h2>
      {missingGiscusFields.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-800 text-sm dark:text-amber-200">
          Comments are unavailable: missing Giscus configuration.
        </div>
      ) : (
        <div ref={ref} />
      )}
    </section>
  );
}
