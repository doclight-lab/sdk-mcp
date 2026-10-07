import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // .github/scripts holds node:test controllers, not vitest suites.
    exclude: [...configDefaults.exclude, ".github/**"],
    globals: false,
    environment: "node",
  },
})
