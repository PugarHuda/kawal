import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendor agent-skill files installed into the project by Impeccable and
    // the Turso integration. Not ours to lint.
    ".claude/**",
    ".agents/**",
    // Separate projects with their own package.json: the Remotion demo film
    // and the Foundry contract. The root CI failed from 2026-09-07 on a
    // Remotion render loop that the React-hooks rules read as a component.
    "demo/**",
    "contracts/**",
  ]),
]);

export default eslintConfig;
