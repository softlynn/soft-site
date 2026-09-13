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
