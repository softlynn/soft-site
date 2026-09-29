import { defineConfig, loadEnv, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const reactSourcePattern = /[\\/]src[\\/].*\.js$/;
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const browserEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("REACT_APP_"))
  );

  return {
    root: projectRoot,
    base: "./",
    optimizeDeps: {
      entries: ["index.html"],
      rolldownOptions: { moduleTypes: { ".js": "jsx" } },
    },
    plugins: [
      {
        name: "soft-site-offline-editor",
        enforce: "pre",
        transform(code, id) {
          if (!/[\\/]@puckeditor[\\/]core[\\/].*\.css(?:\?.*)?$/.test(id)) return null;
          // The local editor must load when external font services are blocked.
          // Puck already supplies a system-font fallback for Inter.
          return code.replace(/@import\s+["']https:\/\/rsms\.me\/inter\/inter\.css["'];?\s*/g, "");
        },
      },
      {
        name: "soft-site-jsx",
        enforce: "pre",
        async transform(code, id) {
          if (!reactSourcePattern.test(id)) return null;
          return transformWithOxc(code, id, { lang: "jsx" });
        },
      },
      react({
        include: /\.[jt]sx?$/,
      }),
    ],
    define: {
      "process.env": JSON.stringify({
        ...browserEnv,
        NODE_ENV: mode === "production" ? "production" : "development",
        PUBLIC_URL: "",
      }),
    },
    build: {
      outDir: "build",
      sourcemap: false,
      chunkSizeWarningLimit: 750,
    },
    server: {
      host: "127.0.0.1",
    },
  };
});
