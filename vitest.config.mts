import { defineConfig } from "vitest/config";

export default defineConfig({
  // Lee los `paths` de tsconfig.json, así `@/*` resuelve igual que en TypeScript y Next.
  resolve: { tsconfigPaths: true },
  test: { include: ["tests/**/*.test.ts"] },
});
