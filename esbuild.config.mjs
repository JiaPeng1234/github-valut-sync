import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import dotenv from "dotenv";

const prod = process.argv[2] === "production";

// Load .env into process.env (existing env vars, e.g. CI secrets, win).
dotenv.config();

const clientId = process.env.CLIENT_ID ?? "";

if (prod && !clientId) {
  console.error(
    "\nERROR: CLIENT_ID is not set. Create a .env file (see .env.example) " +
      "or export CLIENT_ID before running a production build.\n"
  );
  process.exit(1);
}

esbuild.build({
  banner: { js: "/* obsidian-multisync */" },
  entryPoints: ["src/main.ts"],
  define: {
    "process.env.CLIENT_ID": JSON.stringify(clientId),
  },
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});
