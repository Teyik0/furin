import { CompositeComponent, type CompositeComponentSource } from "@teyik0/furin/rsc";
import { CodeTab, CodeTabs } from "./code-tabs";
import { MdxLink } from "./doc-page";

export interface DocContentSlots {
  CodeTab: typeof CodeTab;
  CodeTabs: typeof CodeTabs;
  Link: typeof MdxLink;
}

export function DocContent({ src }: { src: CompositeComponentSource<DocContentSlots> }) {
  return (
    <CompositeComponent
      CodeTab={(props) => <CodeTab {...props} />}
      CodeTabs={(props) => <CodeTabs {...props} />}
      Link={(props) => <MdxLink {...props} />}
      src={src}
    />
  );
}
