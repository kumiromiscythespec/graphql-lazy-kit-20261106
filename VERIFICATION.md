# Verification

Verified on Node.js 24.22.1 on Windows, 6 November 2026.

- `npm test`: 15 passed, 0 failed. Includes real GraphQL query/mutation execution, SDL/introspection equivalence, strict generated-type tests, default argument behavior, fragment dependencies, CLI errors, plugin checks, and transport failures.
- `npm run example`: generated 10 files; the generated client passed a strict TypeScript compilation.
- `npm pack --ignore-scripts`: produced an installable CLI package. An isolated install generated and compiled a client and executed its query builder.
- `npm run benchmark`: actual example schema, six fragment definitions in five type modules, esbuild ESM splitting/minification.

| Raw JavaScript bytes | Lazy | Eager |
|---|---:|---:|
| Initial static import closure | 7,026 | 8,900 |
| All emitted chunks | 8,159 | 9,379 |

Initial bytes decreased by 1,874 (21.06%) for this fixture. The eager baseline exports the same query builder plus a statically preloaded catalog of the real fragments. These are uncompressed bytes, with no claim about network latency or all production schemas. Lazy loading adds asynchronous chunk requests.

Reproduce with the commands above. `benchmark-output/metrics.json` records the fresh measurement and comparison configuration.
