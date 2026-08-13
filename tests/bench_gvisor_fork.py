#!/usr/bin/env python3
"""
独立测试：在 Cloud Run gVisor 上对比 fork vs 持久 shell 的性能
部署到 Cloud Run 后访问 / 即可看结果
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, uuid, threading, time, json, os

class PersistentShell:
    """预 fork 的 /bin/sh 进程"""
    def __init__(self):
        self._proc = None
        self._lock = threading.Lock()
        self._start()
    
    def _start(self):
        try:
            if self._proc and self._proc.poll() is None:
                self._proc.kill()
        except: pass
        self._proc = subprocess.Popen(
            ["/bin/sh"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
        )
    
    def exec(self, command, workdir="/tmp", timeout=30):
        marker = f"__DONE_{uuid.uuid4().hex[:8]}__"
        script = (
            f"cd {workdir} 2>/dev/null\n"
            f"( {command} ) 2>/tmp/_se$$.txt\n"
            f"_x=$?\n"
            f"echo '{marker}'\n"
            f"cat /tmp/_se$$.txt 2>/dev/null\n"
            f"echo '{marker}'\n"
            f"echo $_x\n"
            f"echo '{marker}_END'\n"
            f"rm -f /tmp/_se$$.txt\n"
        )
        
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            self._proc.stdin.write(script.encode())
            self._proc.stdin.flush()
            
            output_lines = []
            deadline = time.time() + timeout
            while time.time() < deadline:
                line = self._proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="replace").rstrip("\n")
                if decoded == f"{marker}_END":
                    break
                output_lines.append(decoded)
        
        full = "\n".join(output_lines)
        parts = full.split(marker)
        if len(parts) >= 3:
            return parts[0].rstrip("\n"), parts[1].strip("\n"), int(parts[2].strip()) if parts[2].strip().lstrip("-").isdigit() else -1
        return full, "", -1


# 预 fork shell
SHELL = PersistentShell()


def run_fork_test(command):
    """每次 fork 新进程"""
    t0 = time.time()
    proc = subprocess.Popen(
        ["/bin/sh", "-c", command],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        close_fds=True, start_new_session=True,
    )
    stdout, stderr = proc.communicate(timeout=60)
    t1 = time.time()
    return {
        "method": "fork",
        "command": command[:80],
        "ms": round((t1 - t0) * 1000),
        "exit": proc.returncode,
        "stdout_len": len(stdout),
    }


def run_shell_test(command):
    """用持久 shell"""
    t0 = time.time()
    stdout, stderr, rc = SHELL.exec(command)
    t1 = time.time()
    return {
        "method": "persistent_shell",
        "command": command[:80],
        "ms": round((t1 - t0) * 1000),
        "exit": rc,
        "stdout_len": len(stdout),
    }


COMMANDS = [
    "echo hello",
    "ls -la /tmp",
    "cat /etc/hostname",
    "python3 -c 'print(2+2)'",
    "python3 -c 'import json; print(json.dumps({\"a\":1}))'",
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        results = []
        
        # 跑 fork 测试
        for cmd in COMMANDS:
            results.append(run_fork_test(cmd))
        
        # 跑持久 shell 测试
        for cmd in COMMANDS:
            results.append(run_shell_test(cmd))
        
        # 格式化输出
        output = "=== gVisor fork vs persistent shell benchmark ===\n\n"
        output += f"{'Method':<20} {'Command':<50} {'Time(ms)':>10}\n"
        output += "-" * 82 + "\n"
        
        fork_total = 0
        shell_total = 0
        for r in results:
            output += f"{r['method']:<20} {r['command']:<50} {r['ms']:>10}\n"
            if r['method'] == 'fork':
                fork_total += r['ms']
            else:
                shell_total += r['ms']
        
        output += "-" * 82 + "\n"
        output += f"{'fork TOTAL':<20} {'':50} {fork_total:>10}\n"
        output += f"{'shell TOTAL':<20} {'':50} {shell_total:>10}\n"
        output += f"\nSpeedup: {fork_total / max(shell_total, 1):.1f}x\n"
        
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(output.encode())


port = int(os.environ.get("PORT", 8080))
print(f"Starting benchmark server on :{port}")
HTTPServer(("", port), Handler).serve_forever()
