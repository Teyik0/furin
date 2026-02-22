export interface DetectionResult {
  confidence: number;
  features: string[];
  isClient: boolean;
  warnings: string[];
}

export interface ModuleAnalysis {
  clientFeatures: string[];
  exports: { name: string; type: "server" | "client" }[];
  path: string;
  type: "server" | "client";
}

export interface ClientManifest {
  [moduleId: string]: {
    id: string;
    chunks: string[];
    name: string;
  };
}

export interface ClientReference {
  $$bundles: string[];
  $$id: string;
  $$name: string;
  $$typeof: symbol;
}

export const CLIENT_REFERENCE_SYMBOL = Symbol.for("react.client.reference");
