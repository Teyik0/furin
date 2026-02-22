import type { DetectionResult } from "./types";

const HOOK_PATTERN = /\buse[A-Z][a-zA-Z]+(?:<[^>]+>)?\s*\(/g;
const EVENT_HANDLER_PATTERN = /\son[A-Z][a-zA-Z]+\s*=/g;
const BROWSER_API_PATTERN = /\b(window|document|localStorage|sessionStorage|navigator)\b/g;
const EVENT_PROP_PATTERN = /\bon[A-Z]\w+\s*=\s*\{/g;
const STRING_EVENT_PATTERN = /\bon[A-Z]\w+\s*=\s*["'][^"']*["']/g;
const HOOK_GENERIC_RE = /(?:<[^>]+>)?\($/;
const EVENT_EQUALS_RE = /=$/;

export function detectClientFeatures(code: string): DetectionResult {
  const features: string[] = [];
  const warnings: string[] = [];
  let confidence = 1.0;

  if (!code || code.trim().length === 0) {
    return {
      isClient: false,
      features: [],
      warnings: [],
      confidence: 1.0,
    };
  }

  const hooks = code.match(HOOK_PATTERN);
  if (hooks) {
    features.push(...hooks.map((h) => h.trim().replace(HOOK_GENERIC_RE, "")));
  }

  const events = code.match(EVENT_HANDLER_PATTERN);
  if (events) {
    features.push(...events.map((e) => e.trim().replace(EVENT_EQUALS_RE, "")));
  }

  const browserAPIs = code.match(BROWSER_API_PATTERN);
  if (browserAPIs) {
    features.push(...new Set(browserAPIs));
    confidence = 0.9;
  }

  const eventProps = code.match(EVENT_PROP_PATTERN);
  if (eventProps) {
    features.push("event-prop-passed");
  }

  const stringEvents = code.match(STRING_EVENT_PATTERN);
  if (stringEvents) {
    for (const match of stringEvents) {
      const propName = match.split("=")[0]?.trim() ?? match;
      warnings.push(
        `Prop "${propName}" looks like an event but has a string value. ` +
          "This component will be treated as client. If intentional, ignore this warning."
      );
    }
    confidence = Math.min(confidence, 0.8);
  }

  const uniqueFeatures = [...new Set(features)];

  return {
    isClient: uniqueFeatures.length > 0,
    features: uniqueFeatures,
    warnings,
    confidence,
  };
}
