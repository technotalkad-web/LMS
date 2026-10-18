import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Files/dirs we never want linted.
    // - .next, out, build, .open-next: build artifacts
    // - supabase/functions: Deno runtime, has its own toolchain
    // - lib/alds/bundles: generated ALDS rules bundles (hashed, never edited;
    //   scripts/build-alds-rules.mjs, ADR 0005 step 9)
    // - *.tmp / *.clean: dev scratch
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      ".open-next/**",
      "next-env.d.ts",
      "supabase/functions/**",
      "lib/alds/bundles/**",
      "**/*.tmp",
      "**/*.clean",
      "**/*.new",
    ],
  },
  {
    // Playwright fixtures use a `use` callback that ESLint mistakes for
    // React's `use` hook. Disable react-hooks/rules-of-hooks for tests.
    files: ["tests/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
];

export default eslintConfig;
