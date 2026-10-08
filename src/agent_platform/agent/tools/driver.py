"""run_code 子进程驱动脚本（DRIVER 常量）。

独立成文件而非内嵌字符串：可读、可 diff、可单独 review。
协议见 run_code.py 模块 docstring——本脚本是沙箱内一侧的实现。
"""

DRIVER = r'''
import json, sys

RPC_PREFIX = "\x00RPC "
_req_id = 0

def _call(name, *args, **kwargs):
    """桩函数统一入口：向 host 发 RPC，同步等待结果。"""
    global _req_id
    _req_id += 1
    sys.stdout.write(RPC_PREFIX + json.dumps(
        {"id": _req_id, "call": name,
         "args": list(args), "kwargs": kwargs}) + "\n")
    sys.stdout.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("host 连接中断")
        resp = json.loads(line)
        if resp.get("id") == _req_id:
            if "error" in resp:
                raise RuntimeError(f"{name}: {resp['error']}")
            return resp.get("result")

def _make_stub(name):
    def stub(*args, **kwargs):
        return _call(name, *args, **kwargs)
    stub.__name__ = name
    stub.__doc__ = "host 工具桩：%s" % name
    return stub

for _name in json.loads(sys.argv[2]):
    globals()[_name] = _make_stub(_name)

with open(sys.argv[1], encoding="utf-8") as _f:
    _code = _f.read()
exec(compile(_code, "<agent>", "exec"), globals())
'''
