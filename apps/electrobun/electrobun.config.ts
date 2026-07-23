import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Ambient Status Dashboard",
    identifier: "dev.ctse.status-dashboard",
    version: "0.1.0",
    description: "Ambient Herdr status in a desktop dashboard and menu bar runtime.",
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
      minify: true,
      sourcemap: "linked",
    },
    copy: {
      "../dashboard/dist/index.html": "views/dashboard/index.html",
      "../dashboard/dist/assets": "views/dashboard/assets",
    },
    buildFolder: ".electrobun/build",
    artifactFolder: ".electrobun/artifacts",
    targets: "current",
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      codesign: false,
      notarize: false,
    },
  },
} satisfies ElectrobunConfig;
