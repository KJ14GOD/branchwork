import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["**/dist/**", "**/dist-electron/**", "**/dist-renderer/**", "**/node_modules/**", "**/*.d.ts"] },
  {
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts"],
    ignores: ["**/dist/**", "**/dist-electron/**", "**/dist-renderer/**", "**/node_modules/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" }
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      "eqeqeq": "error",
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];
