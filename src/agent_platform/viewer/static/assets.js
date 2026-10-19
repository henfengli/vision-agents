/* 资产库页交互：列表筛选 + 抽屉（登记/编辑文本资产、查看文件资产内容与清单）。
   数据/写操作全部走 /v1/assets/*（与外部调用方同一套 API，同源 cookie 鉴权）。
   文件资产正文不入库——抽屉里逐个文件在线查看（走 /v1/assets/{id}/file）。 */
(function () {
  "use strict";
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c];
    });
  };
  var ST = window.ASSETS;
  var drawer = document.getElementById("asset-drawer");
  var scrim = document.getElementById("asset-scrim");
  var curId = null, curCard = null, isCreate = false, dirty = false;
  var KIND_NAMES = {procedure: "方法", script: "脚本", query: "查询", baseline: "基线"};

  function post(url, body, msgEl, done) {
    fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body || {})})
      .then(function (r) { return r.json().then(function (d) { return {ok: r.ok, d: d}; }); })
      .then(function (res) {
        if (!res.ok || res.d.ok === false) {
          if (msgEl) { msgEl.textContent = res.d.error || ("HTTP 错误"); msgEl.style.color = "#b91c1c"; }
          return;
        }
        dirty = false;
        if (msgEl) { msgEl.textContent = "已保存"; msgEl.style.color = "#047857"; }
        setTimeout(function () { location.reload(); }, 500);
        if (done) done(res.d);
      })
      .catch(function () { if (msgEl) { msgEl.textContent = "网络错误"; msgEl.style.color = "#b91c1c"; } });
  }

  function setPills(a) {
    var pills = document.getElementById("ad-pills");
    var h = a.valid_to
      ? '<span class="pill pill-queued">已过期</span>'
      : '<span class="pill pill-success">生效中</span>';
    if (a.feedback_score) {
      h += '<span class="pill ' + (a.feedback_score > 0 ? "pill-success" : "pill-failed") + '">反馈 ' +
        (a.feedback_score > 0 ? "+" : "") + a.feedback_score + "</span>";
    }
    if (a.path) h += '<span class="pill pill-queued">文件资产</span>';
    pills.innerHTML = h;
  }

  function renderFiles(id, files) {
    var sec = document.getElementById("ad-files-sec"), box = document.getElementById("ad-files");
    if (!files || !files.length) { sec.hidden = true; box.innerHTML = ""; return; }
    sec.hidden = false;
    box.innerHTML = files.map(function (f) {
      return '<div class="ad-file" data-rel="' + esc(f.name) + '">' +
        '<span class="ad-file-name">' + esc(f.name) + "</span>" +
        '<span class="ad-file-size">' + (f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB") + "</span></div>";
    }).join("") + '<pre class="ad-file-view" id="ad-file-view" hidden></pre>';
    box.querySelectorAll(".ad-file").forEach(function (el) {
      el.addEventListener("click", function () {
        var view = document.getElementById("ad-file-view");
        view.hidden = false;
        view.textContent = "加载中…";
        fetch("/v1/assets/" + id + "/file?path=" + encodeURIComponent(el.dataset.rel))
          .then(function (r) { return r.text(); })
          .then(function (t) { view.textContent = t; })
          .catch(function () { view.textContent = "加载失败"; });
      });
    });
  }

  function renderRevisions(id, revs) {
    var sec = document.getElementById("ad-revs-sec"), box = document.getElementById("ad-revs");
    if (!revs || !revs.length) { sec.hidden = true; box.innerHTML = ""; return; }
    sec.hidden = false;
    box.innerHTML = revs.map(function (r) {
      return '<div class="ad-file"><span class="ad-file-name mono">' + esc(r.ts) + "</span>" +
        '<span class="ad-file-size">' + r.files + " 文件 · " + (r.bytes / 1024).toFixed(1) + " KB</span>" +
        '<button class="ver-rb ad-rev-rb" data-ts="' + esc(r.ts) + '">回滚到此版</button></div>';
    }).join("");
    box.querySelectorAll(".ad-rev-rb").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!confirm("回滚到 " + btn.dataset.ts + "？当前版会自动留档，可再回滚回来。")) return;
        fetch("/v1/assets/" + id + "/rollback/" + encodeURIComponent(btn.dataset.ts), {method: "POST"})
          .then(function (r) { return r.json().then(function (d) { return {ok: r.ok, d: d}; }); })
          .then(function (res) {
            var msg = document.getElementById("ad-msg");
            if (!res.ok) { msg.textContent = res.d.detail || "回滚失败"; msg.style.color = "#b91c1c"; return; }
            msg.textContent = "已回滚到 " + res.d.restored; msg.style.color = "#047857";
            refreshBody(id);  // 文件清单也随版本换了
          })
          .catch(function () {
            var msg = document.getElementById("ad-msg");
            msg.textContent = "网络错误"; msg.style.color = "#b91c1c";
          });
      });
    });
  }

  function renderContentHistory(id) {
    var sec = document.getElementById("ad-hist-sec"), box = document.getElementById("ad-hist");
    fetch("/v1/assets/" + id + "/history")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (hist) {
        if (!hist.length) { sec.hidden = true; box.innerHTML = ""; return; }
        sec.hidden = false;
        box.innerHTML = hist.map(function (h) {
          return '<div class="ad-file"><span class="ad-file-name mono">v' + h.version + "</span>" +
            '<span class="ad-file-size">' + esc(h.source || "") + " · " + TS.span(h.created_at) +
            " · " + (h.content || "").length + " 字" + (h.path ? " · 有文件载体" : "") + "</span>" +
            '<button class="ver-rb ad-hist-view" data-v="' + h.version + '">查看</button>' +
            '<button class="ver-rb ad-hist-rb" data-v="' + h.version + '">恢复此版</button></div>' +
            '<pre class="ad-file-view" data-vb="' + h.version + '" hidden>' +
            esc((h.summary ? "【说明】\n" + h.summary + "\n\n【内容】\n" : "") + (h.content || "")) + "</pre>";
        }).join("");
        box.querySelectorAll(".ad-hist-view").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var view = box.querySelector('[data-vb="' + btn.dataset.v + '"]');
            if (view) { view.hidden = !view.hidden; btn.textContent = view.hidden ? "查看" : "收起"; }
          });
        });
        box.querySelectorAll(".ad-hist-rb").forEach(function (btn) {
          btn.addEventListener("click", function () {
            if (!confirm("恢复到 v" + btn.dataset.v + "？当前内容会先自动留档，可再恢复回来。")) return;
            fetch("/v1/assets/" + id + "/history/" + btn.dataset.v + "/restore", {method: "POST"})
              .then(function (r) { return r.json().then(function (d) { return {ok: r.ok, d: d}; }); })
              .then(function (res) {
                var msg = document.getElementById("ad-msg");
                if (!res.ok) { msg.textContent = res.d.detail || "恢复失败"; msg.style.color = "#b91c1c"; return; }
                msg.textContent = "已恢复到 v" + btn.dataset.v; msg.style.color = "#047857";
                refreshBody(id);  // 文本字段与历史列表一并刷新
              })
              .catch(function () {
                var msg = document.getElementById("ad-msg");
                msg.textContent = "网络错误"; msg.style.color = "#b91c1c";
              });
          });
        });
      });
  }

  function refreshBody(id) {
    fetch("/v1/assets/" + id)
      .then(function (r) { return r.json(); })
      .then(function (a) {
        renderFiles(a.id, a.files); renderRevisions(a.id, a.revisions);
        // 恢复历史后，抽屉里的说明/内容字段也要换成当前值
        document.getElementById("ad-summary").value = a.summary;
        document.getElementById("ad-content").value = a.content;
        dirty = false;
        renderContentHistory(a.id);
      });
  }

  function openDetail(card) {
    isCreate = false; curId = card.dataset.id; curCard = card;
    document.getElementById("ad-create-fields").hidden = true;
    document.getElementById("ad-content").readOnly = false;
    document.getElementById("ad-expire").hidden = false;
    document.getElementById("ad-restore").hidden = false;
    fetch("/v1/assets/" + curId)
      .then(function (r) { return r.json(); })
      .then(function (a) {
        document.getElementById("ad-key").textContent = (KIND_NAMES[a.kind] || a.kind) + " · " + a.name;
        setPills(a);
        document.getElementById("ad-meta").innerHTML =
          "<span>" + esc(a.domain) + " / " + (a.task ? esc(a.task) : "域级通用") + "</span>" +
          "<span>复用 " + a.use_count + " 次</span>" +
          "<span>最近复用 " + (a.last_used_at ? TS.span(a.last_used_at) : "—") + "</span>" +
          (a.source_run ? '<span>来源 <a href="/runs/' + esc(a.source_run) + '">run</a></span>' : "") +
          "<span>登记于 " + TS.span(a.created_at) + "</span>";
        document.getElementById("ad-summary").value = a.summary;
        document.getElementById("ad-content").value = a.content;
        document.getElementById("ad-content").placeholder = a.path
          ? "文件类资产的说明文字（正文在文件里，不入库）" : "";
        document.getElementById("ad-msg").textContent = "";
        renderFiles(a.id, a.files);
        renderRevisions(a.id, a.revisions);
        renderContentHistory(a.id);
        drawer.classList.add("open"); scrim.classList.add("open");
      });
  }

  function openCreate() {
    isCreate = true; curId = null; curCard = null;
    document.getElementById("ad-key").textContent = "登记文本资产";
    document.getElementById("ad-pills").innerHTML = "";
    document.getElementById("ad-meta").innerHTML = "<span>文件类资产由运行中的 agent 通过 save_asset 收编；这里登记文本类（方法/查询/基线）。</span>";
    document.getElementById("ad-create-fields").hidden = false;
    document.getElementById("ad-summary").value = "";
    document.getElementById("ad-content").value = "";
    document.getElementById("ad-task").value = "";
    document.getElementById("ad-name").value = "";
    document.getElementById("ad-msg").textContent = "";
    document.getElementById("ad-expire").hidden = true;
    document.getElementById("ad-restore").hidden = true;
    document.getElementById("ad-files-sec").hidden = true;
    document.getElementById("ad-files").innerHTML = "";
    document.getElementById("ad-revs-sec").hidden = true;
    document.getElementById("ad-revs").innerHTML = "";
    document.getElementById("ad-hist-sec").hidden = true;
    document.getElementById("ad-hist").innerHTML = "";
    drawer.classList.add("open"); scrim.classList.add("open");
  }

  function closeDrawer() {
    if (dirty && !confirm("有未保存的修改，确定关闭？")) return;
    drawer.classList.remove("open"); scrim.classList.remove("open");
    dirty = false; curId = null; curCard = null;
  }

  document.querySelectorAll(".asset-card").forEach(function (c) {
    c.addEventListener("click", function () { openDetail(c); });
  });
  var addBtn = document.getElementById("asset-add");
  if (addBtn) addBtn.addEventListener("click", openCreate);
  document.getElementById("ad-close").addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
  });
  document.getElementById("ad-summary").addEventListener("input", function () { dirty = true; });
  document.getElementById("ad-content").addEventListener("input", function () { dirty = true; });
  window.addEventListener("beforeunload", function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  document.getElementById("ad-save").addEventListener("click", function () {
    var msg = document.getElementById("ad-msg");
    if (isCreate) {
      post("/v1/assets?env=" + encodeURIComponent(ST.env), {
        domain: document.getElementById("ad-domain").value,
        kind: document.getElementById("ad-kind").value,
        task: document.getElementById("ad-task").value.trim(),
        name: document.getElementById("ad-name").value.trim(),
        summary: document.getElementById("ad-summary").value.trim(),
        content: document.getElementById("ad-content").value
      }, msg);
      return;
    }
    if (!curId) return;
    post("/v1/assets/" + curId, {
      summary: document.getElementById("ad-summary").value.trim(),
      content: document.getElementById("ad-content").value
    }, msg);
  });
  document.getElementById("ad-expire").addEventListener("click", function () {
    if (curId && confirm("标记为过期？之后召回不再注入（可恢复）。"))
      post("/v1/assets/" + curId + "/expire", {}, document.getElementById("ad-msg"));
  });
  document.getElementById("ad-restore").addEventListener("click", function () {
    if (curId) post("/v1/assets/" + curId + "/restore", {}, document.getElementById("ad-msg"));
  });
})();
