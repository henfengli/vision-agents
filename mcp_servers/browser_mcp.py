"""浏览器 MCP server（FastMCP，stdio）：网页自动化工具集。

用途：看板/配置中心等内网网页的冒烟检查、页面取证、口径核对截图。
交互模型参考 Microsoft playwright-mcp：不给模型甩截图坐标，而是把页面
序列化成**可访问性快照**（role + name + ref 的文本树），模型按 ref 操作
元素——token 省一个量级，也不会点错位置。

运行：python mcp_servers/browser_mcp.py
配置：agent-platform 的 settings.mcp_servers = {"browser": {"transport": "stdio",
      "command": "python", "args": ["mcp_servers/browser_mcp.py"]}}
环境变量：BROWSER_HEADLESS=1（默认无头）/ BROWSER_SHOT_DIR（截图落盘目录）

设计要点：
- 状态在进程内：单浏览器单上下文多标签页（stdio server 天然单会话）
- 快照时给可交互元素打 data-ap-ref 属性（e1/e2/…），动作工具按 ref 定位；
  DOM 变化后旧 ref 失效，返回新快照是各动作工具的默认行为
- 动作工具返回新快照：模型不用额外调一次 snapshot 就能看到操作结果
- 页面错误（ref 失效/超时）返回文本说明而非抛异常——让模型自己恢复
"""

from __future__ import annotations

import os
import time

_HEADLESS = os.environ.get("BROWSER_HEADLESS", "1") != "0"
_SHOT_DIR = os.environ.get("BROWSER_SHOT_DIR", "/var/lib/agent-platform/scratch")
_SNAPSHOT_LIMIT = 6000          # 快照文本上限，超长截断（模型上下文保护）
_DEFAULT_TIMEOUT_MS = 5000

# 快照生成脚本：遍历可见元素，可交互/语义元素打 ref 并输出缩进文本树。
# 输出形如：  link "报表中心" [ref=e3]
_SNAPSHOT_JS = r"""
() => {
  const REF = "data-ap-ref";
  document.querySelectorAll(`[${REF}]`).forEach(el => el.removeAttribute(REF));
  const lines = [];
  let n = 0;
  const roleOf = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "submit" || ty === "button") return "button";
      return "textbox";
    }
    if (/^h[1-6]$/.test(t)) return "heading";
    const r = el.getAttribute("role");
    if (r && ["link","button","checkbox","radio","combobox","textbox",
              "heading","tab","menuitem","option","switch"].includes(r)) return r;
    return null;
  };
  const nameOf = (el) => {
    const pick = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return pick(el.getAttribute("aria-label")) || pick(el.innerText) ||
           pick(el.getAttribute("placeholder")) || pick(el.getAttribute("value")) ||
           pick(el.getAttribute("alt")) || pick(el.getAttribute("title"));
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const walk = (el, depth) => {
    if (depth > 20 || !visible(el)) return;
    const role = roleOf(el);
    if (role) {
      const ref = "e" + (++n);
      el.setAttribute(REF, ref);
      lines.push(`${"  ".repeat(depth)}${role} "${nameOf(el)}" [ref=${ref}]`);
      depth++;
    }
    for (const child of el.children) walk(child, depth);
  };
  if (document.body) walk(document.body, 0);
  return lines.join("\n");
}
"""


class _Session:
    """进程内浏览器状态：延迟启动，browser_close 后归零。"""

    def __init__(self):
        self.pw = None
        self.browser = None
        self.context = None
        self.active = 0

    async def page(self):
        if self.context is None or self.active >= len(self.context.pages):
            await self._launch()
        return self.context.pages[self.active]

    async def _launch(self):
        from playwright.async_api import async_playwright  # 延迟导入
        if self.pw is None:
            self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(
            headless=_HEADLESS, args=["--no-sandbox"])
        self.context = await self.browser.new_context(
            viewport={"width": 1280, "height": 720},
            ignore_https_errors=True)          # 内网自签证书
        await self.context.new_page()
        self.active = 0

    async def reset(self):
        if self.browser is not None:
            await self.browser.close()
        if self.pw is not None:
            await self.pw.stop()
        self.__init__()


_S = _Session()


# ==================== 内部工具 ====================

async def _snapshot_of(page) -> str:
    text = await page.evaluate(_SNAPSHOT_JS)
    if not text:
        return f"（{page.url} 无可交互元素）"
    if len(text) > _SNAPSHOT_LIMIT:
        text = text[:_SNAPSHOT_LIMIT] + "\n…[快照过长已截断，用 browser_evaluate 精读]"
    return f"页面：{page.url}\n{text}"


def _by_ref(page, ref: str):
    return page.locator(f'[data-ap-ref="{ref}"]')


async def _act(coro_factory) -> str:
    """动作工具公共骨架：执行 → 失败给文本 → 成功回新快照。"""
    try:
        page = await _S.page()
        await coro_factory(page)
        return await _snapshot_of(page)
    except Exception as e:  # noqa: BLE001 —— 错误交给模型恢复（重快照/换 ref）
        return f"操作失败：{str(e)[:300]}（提示：DOM 可能已变化，先 browser_snapshot 拿新 ref）"


# ==================== 工具（FastMCP 注册在 main()） ====================

async def browser_navigate(url: str) -> str:
    """打开 URL（当前标签页），返回页面可访问性快照。"""
    async def go(page):
        await page.goto(url, wait_until="domcontentloaded",
                        timeout=_DEFAULT_TIMEOUT_MS * 6)
    return await _act(go)


async def browser_snapshot() -> str:
    """拿当前页面的可访问性快照（操作前先看这个拿 ref）。"""
    return await _snapshot_of(await _S.page())


async def browser_click(ref: str) -> str:
    """按 ref 点击元素（如 e3），返回操作后的新快照。"""
    return await _act(lambda p: _by_ref(p, ref).click(
        timeout=_DEFAULT_TIMEOUT_MS))


async def browser_type(ref: str, text: str, submit: bool = False) -> str:
    """按 ref 向输入框填入文本（先清空）；submit=True 时按回车提交。"""
    async def do(page):
        loc = _by_ref(page, ref)
        await loc.fill(text, timeout=_DEFAULT_TIMEOUT_MS)
        if submit:
            await loc.press("Enter")
    return await _act(do)


async def browser_press_key(key: str) -> str:
    """按键（Enter/Tab/Escape/ArrowDown…），返回新快照。"""
    return await _act(lambda p: p.keyboard.press(key))


async def browser_go_back() -> str:
    """后退一页，返回新快照。"""
    return await _act(lambda p: p.go_back(timeout=_DEFAULT_TIMEOUT_MS))


async def browser_wait_for(text: str = "", timeout_ms: int = 5000) -> str:
    """等待：给了 text 等它出现在页面上，否则固定等 timeout_ms 毫秒。"""
    try:
        page = await _S.page()
        if text:
            await page.get_by_text(text, exact=False).first.wait_for(
                state="visible", timeout=timeout_ms)
        else:
            await page.wait_for_timeout(timeout_ms)
        return await _snapshot_of(page)
    except Exception as e:  # noqa: BLE001
        return f"等待超时：{str(e)[:200]}"


async def browser_evaluate(expression: str) -> str:
    """在当前页面执行 JS 表达式并返回结果（精读页面数据用，截断 2000 字）。"""
    try:
        result = await (await _S.page()).evaluate(expression)
        text = result if isinstance(result, str) else repr(result)
        return text[:2000]
    except Exception as e:  # noqa: BLE001
        return f"执行失败：{str(e)[:300]}"


async def browser_screenshot(full_page: bool = False) -> str:
    """截图存到 BROWSER_SHOT_DIR，返回文件路径（可用 read_file 查看）。"""
    os.makedirs(_SHOT_DIR, exist_ok=True)
    path = os.path.join(_SHOT_DIR, f"shot-{int(time.time() * 1000)}.png")
    await (await _S.page()).screenshot(path=path, full_page=full_page)
    return path


async def browser_tabs(action: str, index: int | None = None) -> str:
    """标签页管理：action = list / new / select / close（select/close 带 index）。"""
    ctx = (await _S.page()).context
    if action == "list":
        return "\n".join(
            f"{'*' if i == _S.active else ' '} [{i}] {p.url}"
            for i, p in enumerate(ctx.pages))
    if action == "new":
        await ctx.new_page()
        _S.active = len(ctx.pages) - 1
    elif action == "select" and index is not None:
        _S.active = index
    elif action == "close" and index is not None:
        await ctx.pages[index].close()
        _S.active = max(0, min(_S.active, len(ctx.pages) - 1))
    else:
        return f"未知标签页操作：{action}（list/new/select/close）"
    return await _snapshot_of(await _S.page())


async def browser_close() -> str:
    """关闭浏览器并释放全部状态（任务结束调它）。"""
    await _S.reset()
    return "浏览器已关闭"


_TOOLS = (browser_navigate, browser_snapshot, browser_click, browser_type,
          browser_press_key, browser_go_back, browser_wait_for,
          browser_evaluate, browser_screenshot, browser_tabs, browser_close)


def build_server():
    """装配 FastMCP 实例（延迟导入：工具逻辑不依赖 mcp 包，可直接单测）。"""
    from fastmcp import FastMCP
    server = FastMCP("browser")
    for fn in _TOOLS:
        server.tool(fn)
    return server


if __name__ == "__main__":
    build_server().run()
