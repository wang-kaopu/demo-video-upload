// @ts-check

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [
      js.configs.recommended,
    ],
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
