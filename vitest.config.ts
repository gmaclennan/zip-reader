import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserInstanceOption } from "vitest/node";
import {
  listZipFiles,
  readFileAsBase64,
  getExpectedFilesData,
  loadFixtureOptionsCmd,
} from "./test/commands.js";

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
  server: {
    // Node 18 on Windows doesn't support listening on IPv6 ::1
    host: "127.0.0.1",
  },
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
          exclude: [
            "test/browser.test.ts",
            "**/node_modules/**",
            "**/.git/**",
            "vendor/**",
          ],
          alias: {
            "#crc32": "/src/crc-node.ts",
            "#deflate-raw": "/src/deflate-raw-node.ts",
          },
        },
      },
      {
        optimizeDeps: {
          exclude: ["execa", "node:zlib", "zlib", "node:stream"],
        },
        test: {
          name: "browser",
          include: ["test/zip-reader.test.ts", "test/edge-cases.test.ts"],
          exclude: ["**/node_modules/**", "**/.git/**", "vendor/**"],
          alias: {
            "#crc32": "/src/crc-browser.ts",
            "#deflate-raw": "/src/deflate-raw-browser.ts",
          },
          browser: {
            ui: false,
            screenshotFailures: false,
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: browserInstances,
            commands: {
              listZipFiles,
              readFileAsBase64,
              getExpectedFilesData,
              loadFixtureOptionsCmd,
            },
          },
        },
      },
    ],
  },
});
