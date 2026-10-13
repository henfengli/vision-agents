/* 相对时间（JS 版）：抽屉/时间线等「fetch 后客户端渲染」处与模板 ts 宏
   同一口径——刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD，悬停出
   绝对时间。服务端 SSR 仍用 base.py 的 reltime 过滤器，两边规则保持一致，
   改口径要同时改两处（本文件只服务客户端渲染）。 */
window.TS = (function () {
  function parse(t) {
    if (!t) return null;
    var d = t instanceof Date ? t : new Date(String(t).replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function abs(t) {
    var d = parse(t);
    if (!d) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" +
           pad(d.getDate()) + " " + pad(d.getHours()) + ":" +
           pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function rel(t) {
    var d = parse(t);
    if (!d) return "-";
    var secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (secs < 90) return "刚刚";
    if (secs < 3600) return Math.floor(secs / 60) + " 分钟前";
    if (secs < 86400) return Math.floor(secs / 3600) + " 小时前";
    if (secs < 7 * 86400) return Math.floor(secs / 86400) + " 天前";
    return abs(t).slice(0, 10);
  }

  /* 与模板 ts 宏同构：<span class="ts" title=绝对>相对</span> */
  function span(t) {
    if (!t) return "-";
    return '<span class="ts" title="' + abs(t) + '">' + rel(t) + "</span>";
  }

  /* 毫秒 → 人类可读时长（820ms / 2.3s / 3.2 min / 1.2 h），同 dur 过滤器 */
  function dur(ms) {
    if (ms === null || ms === undefined || ms === "") return "-";
    ms = parseInt(ms, 10);
    if (isNaN(ms)) return "-";
    if (ms < 1000) return ms + "ms";
    var secs = ms / 1000;
    if (secs < 60) return secs.toFixed(1) + "s";
    if (secs < 3600) return (secs / 60).toFixed(1) + " min";
    return (secs / 3600).toFixed(1) + " h";
  }

  return { rel: rel, abs: abs, span: span, dur: dur };
})();
