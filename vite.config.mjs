import { defineConfig, loadEnv, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";

const reactSourcePattern = /[\\/]src[\\/].*\.js$/;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const browserEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith("REACT_APP_"))
  );

  return {
    base: "./",
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
