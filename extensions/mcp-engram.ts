// Historical compatibility shim (Spec 71). The single JS implementation lives
// in `./mcp-engram.mjs` so a plain Node consumer can import it from
// `node_modules` without a TypeScript stripping hook (Node 24 refuses TS under
// `node_modules`). Existing TypeScript consumers keep this `.ts` path; new code
// imports the `.mjs` directly.
export * from "./mcp-engram.mjs";
