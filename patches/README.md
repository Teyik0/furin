These Bun patches retain the existing dependency APIs until upstream publishes compatible fixes. `bun install --frozen-lockfile` applies them automatically. Run `bun test packages/core/tests/runtime/dependency-security.test.ts` to verify the mitigations and compatibility.

- `braces@3.0.3`: limits parser and AST walker nesting to 128, following the mitigation recommended in [upstream issue #70](https://github.com/micromatch/braces/issues/70). Ordinary glob expansion is unchanged. Excessive nesting raises `SyntaxError` before exhausting the call stack.
- `deepmerge-ts@7.1.5`: detects active recursive record pairs in both merge pipelines and rejects circular graphs with an explicit error. This preserves version 7's Map behavior and public types; [version 8](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0) changes both. Custom merge functions and shared acyclic graphs remain supported.
- `postcss-selector-parser@6.0.10`: backports the three Set membership changes from [upstream commit 62b1917](https://github.com/postcss/postcss-selector-parser/commit/62b191792df0a0bc56062e5a875bc74aae2a51cd), preserving the version pinned by Tailwind Typography.

`bun audit` checks package versions, so it still reports these three advisories despite the patches. The versions are intentionally unchanged; this is not an advisory suppression or a claim of an upstream release.
