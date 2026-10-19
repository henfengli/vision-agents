import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// 样式由 scripts/build.mjs 单独编译（tailwind），不经 JS 打包

import { App } from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
