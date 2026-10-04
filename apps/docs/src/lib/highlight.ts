import { createHighlighter } from "@tanstack/highlight/core";
import { json } from "@tanstack/highlight/languages/json";
import { nginx } from "@tanstack/highlight/languages/nginx";
import { shell } from "@tanstack/highlight/languages/shell";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";

export const highlighter = createHighlighter({ languages: [json, nginx, shell, toml, ts, tsx] });
