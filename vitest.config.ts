import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserInstanceOption } from "vitest/node";

const browserInstances: BrowserInstanceOption[] = [{ browser: "chromium" }];

if (process.platform === "darwin") {
  browserInstances.push({ browser: "webkit" });
}

if (process.platform !== "win32") {
  // Firefox tests keep timing out on Windows CI runners due to
  // https://github.com/microsoft/playwright/issues/34586
  browserInstances.push({ browser: "firefox" });
}

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["verbose"] : ["default"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["lcov", "text"],
    },
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.git/**", "vendor/**"],
          alias: {
            "#crc32": "/src/crc-node.ts",
          },
        },
      },
      {
        optimizeDeps: {
          exclude: ["execa", "node:zlib", "zlib"],
        },
        test: {
          name: "browser",
          include: ["test/browser.test.ts"],
          exclude: ["**/node_modules/**", "**/.git/**", "vendor/**"],
          alias: {
            "#crc32": "/src/crc-browser.ts",
          },
          browser: {
            ui: false,
            screenshotFailures: false,
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: browserInstances,
          },
        },
      },
    ],
  },
});
