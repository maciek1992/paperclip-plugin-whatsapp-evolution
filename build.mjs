import { build } from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  loader: { ".sh": "text" },
};

await build({ ...common, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js", external: ["react", "react-dom"] });
await build({ ...common, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js", external: ["@paperclipai/plugin-sdk"] });
await build({ ...common, entryPoints: ["src/core.ts"], outfile: "dist/core.js" });
