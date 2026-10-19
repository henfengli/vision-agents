#!/usr/bin/env node
/**
 * 前端构建：esbuild（TS/TSX 打包）+ Tailwind v4 compile API（按源码里出现的
 * class 生成 CSS）。不引入 vite——依赖少、构建快、产物确定。
 *
 *   node scripts/build.mjs build     生产构建 → src/agent_platform/webui/dist（带 hash）
 *   node scripts/build.mjs dev       开发：监听 + 本地服务 :5173，/v1 代理到后端
 *   node scripts/build.mjs dev --mock   开发：mock 数据，不需要后端
 *   node scripts/build.mjs preview   单文件预览（mock + hash 路由，JS/CSS 内联）→ dist-preview/index.html
 *
 * 环境变量：AGENT_API（dev 代理目标，默认 http://127.0.0.1:8100）、PORT（默认 5173）
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { compile } from "tailwindcss";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const PROD_OUT = path.resolve(ROOT, "../src/agent_platform/webui/dist");
const PREVIEW_OUT = path.join(ROOT, "dist-preview");
const DEV_OUT = path.join(ROOT, ".dev");

const mode = process.argv[2] || "build";
const mock = process.argv.includes("--mock") || mode === "preview";
const router = mode === "preview" ? "hash" : "history";

// ———————— CSS：扫源码收集候选 class → tailwind compile ————————

function listFiles(dir, exts) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((e) => ent.name.endsWith(e))) out.push(p);
  }
  return out;
}

function candidates() {
  const set = new Set();
  for (const f of listFiles(SRC, [".ts", ".tsx"])) {
    const text = fs.readFileSync(f, "utf8");
    for (const tok of text.split(/[\s"'`]+/)) {
      if (!tok || tok.length > 120) continue;
      set.add(tok);
      const trimmed = tok.replace(/^[({[,;]+/, "").replace(/[)}\],;:.]+$/, "");
      if (trimmed && trimmed !== tok) set.add(trimmed);
    }
  }
  return [...set];
}

const twBase = path.dirname(fileURLToPath(import.meta.resolve("tailwindcss/package.json")));

async function buildCss() {
  const entry = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
  const compiler = await compile(entry, {
    base: SRC,
    loadStylesheet: async (id, base) => {
      let file;
      if (id === "tailwindcss") file = path.join(twBase, "index.css");
      else if (id.startsWith("tailwindcss/")) file = path.join(twBase, id.slice(12) + (id.endsWith(".css") ? "" : ".css"));
      else file = path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  return compiler.build(candidates());
}

// ———————— JS ————————

function esbuildOptions(extra = {}) {
  return {
    entryPoints: [path.join(SRC, "main.tsx")],
    bundle: true,
    format: "esm",
    target: ["es2022", "chrome111", "safari16"],
    jsx: "automatic",
    loader: { ".svg": "text" },
    define: {
      __MOCK__: JSON.stringify(mock),
      __ROUTER__: JSON.stringify(router),
      "process.env.NODE_ENV": JSON.stringify(mode === "dev" ? "development" : "production"),
    },
    logLevel: "warning",
    legalComments: "none",
    ...extra,
  };
}

function html({ js, css, inline = false }) {
  const tpl = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const style = inline ? `<style>${css}</style>` : `<link rel="stylesheet" href="${css}">`;
  // 内联时转义会被 HTML 解析器误读的序列（</script、<!--）；字符串与正则里 \x3C 等价于 <
  const script = inline
    ? `<script type="module">${js.replace(/<\/(script)/gi, "\\x3C/$1").replace(/<!--/g, "\\x3C!--")}</script>`
    : `<script type="module" src="${js}"></script>`;
  let out = tpl.replace("<!--STYLE-->", () => style).replace("<!--SCRIPT-->", () => script);
  if (inline) {
    const icon = fs.readFileSync(path.join(ROOT, "public/favicon.svg"), "utf8");
    out = out.replace('href="/favicon.svg"', `href="data:image/svg+xml,${encodeURIComponent(icon)}"`);
  }
  return out;
}

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

async function buildProd() {
  const result = await esbuild.build(esbuildOptions({ write: false, minify: true, sourcemap: false }));
  const js = Buffer.from(result.outputFiles[0].contents);
  const css = Buffer.from(await buildCss());
  fs.rmSync(PROD_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROD_OUT, "assets"), { recursive: true });
  const jsName = `assets/app-${hash(js)}.js`;
  const cssName = `assets/app-${hash(css)}.css`;
  fs.writeFileSync(path.join(PROD_OUT, jsName), js);
  fs.writeFileSync(path.join(PROD_OUT, cssName), css);
  fs.writeFileSync(path.join(PROD_OUT, "index.html"), html({ js: "/" + jsName, css: "/" + cssName }));
  fs.copyFileSync(path.join(ROOT, "public/favicon.svg"), path.join(PROD_OUT, "favicon.svg"));
  console.log(`built → ${path.relative(process.cwd(), PROD_OUT)}  js ${(js.length / 1024).toFixed(0)}KB  css ${(css.length / 1024).toFixed(0)}KB`);
}

async function buildPreview() {
  const result = await esbuild.build(esbuildOptions({ write: false, minify: true }));
  const js = result.outputFiles[0].text;
  const css = await buildCss();
  fs.mkdirSync(PREVIEW_OUT, { recursive: true });
  const out = path.join(PREVIEW_OUT, "index.html");
  const full = html({ js, css, inline: true });
  fs.writeFileSync(out, full);
  // 片段版（无 doctype/html/head/body）：给外层会套文档骨架的托管环境用
  // 按模板里的固定分界切（内联 JS 里可能出现 </head> 之类的字串，不能用正则贪婪匹配）
  const split = full.indexOf("</head>\n<body>");
  const head = full.slice(full.indexOf("<head>") + 6, split).replace(/<meta charset[^>]*>\s*/, "").replace(/<meta name="viewport"[^>]*>\s*/, "");
  const body = full.slice(split + "</head>\n<body>".length, full.lastIndexOf("</body>"));
  fs.writeFileSync(path.join(PREVIEW_OUT, "artifact.html"), head.trim() + "\n" + body.trim() + "\n");
  console.log(`preview → ${path.relative(process.cwd(), out)}  ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
}

async function dev() {
  fs.mkdirSync(DEV_OUT, { recursive: true });
  const writeCss = async () => fs.writeFileSync(path.join(DEV_OUT, "app.css"), await buildCss());
  await writeCss();
  fs.writeFileSync(path.join(DEV_OUT, "index.html"), html({ js: "/app.js", css: "/app.css" }));
  const ctx = await esbuild.context(esbuildOptions({
    outfile: path.join(DEV_OUT, "app.js"), sourcemap: "inline",
    plugins: [{ name: "css", setup(b) { b.onEnd(() => writeCss().catch((e) => console.error(e.message))); } }],
  }));
  await ctx.watch();
  const api = new URL(process.env.AGENT_API || "http://127.0.0.1:8100");
  const port = Number(process.env.PORT || 5173);
  http.createServer((req, res) => {
    if (!mock && (req.url.startsWith("/v1/") || req.url.startsWith("/auth/"))) {
      const up = http.request({ host: api.hostname, port: api.port, path: req.url, method: req.method, headers: req.headers },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
      req.pipe(up);
      return;
    }
    const file = path.join(DEV_OUT, decodeURIComponent(req.url.split("?")[0]));
    if (file.startsWith(DEV_OUT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] || "text/html";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      fs.createReadStream(path.join(DEV_OUT, "index.html")).pipe(res);
    }
  }).listen(port, () => console.log(`dev → http://127.0.0.1:${port}${mock ? "  (mock 数据)" : `  (/v1 → ${api.origin})`}`));
}

const run = { build: buildProd, preview: buildPreview, dev }[mode];
if (!run) {
  console.error(`未知模式 ${mode}（build | dev | preview）`);
  process.exit(1);
}
await run();
