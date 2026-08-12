"""
diag_ssl.py — 在 Cloud Run 容器内诊断 SSL EOF 问题
运行方式：通过 sandbox-service /diag 端点触发

测试矩阵：
1. urllib.request.urlopen（当前方式）— 每次新连接
2. http.client.HTTPSConnection（连接复用）— 同一连接多次请求
3. http.client + 手动 TLS 握手计时
4. 对比：带 _SSL_CTX vs 默认 SSL context
5. 对比：stream=true vs stream=false
"""
import os, json, time, socket, ssl, sys
from datetime import datetime, timezone

API_KEY = os.environ.get("AI_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
BASE_URL = os.environ.get("AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
HOST = BASE_URL.split("//")[1].split("/")[0] if "//" in BASE_URL else "generativelanguage.googleapis.com"
MODEL = os.environ.get("AI_MODEL", "gemini-2.0-flash")

# IPv4 patch（和 runner.py 一致：在 syscall 级别强制 AF_INET）
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
    if family == 0:
        family = socket.AF_INET
    return _orig_getaddrinfo(host, port, family, type, proto, flags)
socket.getaddrinfo = _ipv4_only

SMALL_BODY = json.dumps({
    "model": MODEL,
    "messages": [{"role": "user", "content": "Say hello in 5 words"}],
    "max_tokens": 50,
    "stream": False,
}).encode()

STREAM_BODY = json.dumps({
    "model": MODEL,
    "messages": [{"role": "user", "content": "Say hello in 5 words"}],
    "max_tokens": 50,
    "stream": True,
}).encode()

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

results = []

def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    results.append(line)


def test_dns():
    """测试 DNS 解析"""
    log("=" * 60)
    log("TEST 1: DNS 解析")
    log("=" * 60)
    
    t0 = time.time()
    addrs = socket.getaddrinfo(HOST, 443, socket.AF_INET)
    elapsed = round((time.time() - t0) * 1000)
    ips = list(set(r[4][0] for r in addrs))
    log(f"  IPv4 地址数: {len(ips)}  耗时: {elapsed}ms")
    for ip in ips[:5]:
        log(f"    {ip}")
    
    # 也看看有没有 IPv6
    try:
        all_addrs = _orig_getaddrinfo(HOST, 443)
        ipv6 = [r for r in all_addrs if r[0] == socket.AF_INET6]
        log(f"  IPv6 地址数: {len(ipv6)} (已被 patch 过滤)")
    except:
        log(f"  IPv6: 无法解析")
    
    return ips[0] if ips else None


def test_tcp_tls(ip):
    """测试裸 TCP + TLS 握手速度"""
    log("")
    log("=" * 60)
    log("TEST 2: 裸 TCP + TLS 握手（无 HTTP）")
    log("=" * 60)
    
    for i in range(3):
        try:
            t0 = time.time()
            sock = socket.create_connection((ip, 443), timeout=10)
            t_tcp = time.time()
            
            ctx = ssl.create_default_context()
            ssock = ctx.wrap_socket(sock, server_hostname=HOST)
            t_tls = time.time()
            
            tcp_ms = round((t_tcp - t0) * 1000)
            tls_ms = round((t_tls - t_tcp) * 1000)
            
            proto = ssock.version()
            cipher = ssock.cipher()
            log(f"  [{i+1}] TCP={tcp_ms}ms  TLS={tls_ms}ms  proto={proto}  cipher={cipher[0] if cipher else '?'}")
            ssock.close()
        except Exception as e:
            log(f"  [{i+1}] 失败: {e}")


def test_urllib_single():
    """测试 urllib（当前方式）— 5 次连续请求"""
    log("")
    log("=" * 60)
    log("TEST 3: urllib.request.urlopen（当前 runner.py 方式）x5")
    log("=" * 60)
    
    import urllib.request
    ctx = ssl.create_default_context()
    
    for i in range(5):
        try:
            t0 = time.time()
            req = urllib.request.Request(
                f"{BASE_URL}/chat/completions",
                data=SMALL_BODY,
                headers=HEADERS,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                t_connected = time.time()
                body = r.read()
                t_done = time.time()
            
            connect_ms = round((t_connected - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  [{i+1}] connect={connect_ms}ms  total={total_ms}ms  status={r.status}  body={len(body)}b")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  [{i+1}] ❌ {elapsed}ms: {type(e).__name__}: {e}")
        
        time.sleep(0.2)  # 短暂间隔


def test_urllib_stream():
    """测试 urllib stream=True（和 runner.py 完全一样）"""
    log("")
    log("=" * 60)
    log("TEST 4: urllib + stream=True（runner.py 实际使用方式）x5")
    log("=" * 60)
    
    import urllib.request
    ctx = ssl.create_default_context()
    
    for i in range(5):
        try:
            t0 = time.time()
            req = urllib.request.Request(
                f"{BASE_URL}/chat/completions",
                data=STREAM_BODY,
                headers=HEADERS,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                t_connected = time.time()
                # 读第一行（模拟 SSE 首 token）
                first_line = r.readline()
                t_first = time.time()
                # 读完
                rest = r.read()
                t_done = time.time()
            
            connect_ms = round((t_connected - t0) * 1000)
            first_ms = round((t_first - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  [{i+1}] connect={connect_ms}ms  first_line={first_ms}ms  total={total_ms}ms  first={first_line[:60]}")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  [{i+1}] ❌ {elapsed}ms: {type(e).__name__}: {e}")
        
        time.sleep(0.2)


def test_http_client_reuse():
    """测试 http.client 连接复用 — 同一连接多次请求"""
    log("")
    log("=" * 60)
    log("TEST 5: http.client.HTTPSConnection 连接复用 x5")
    log("=" * 60)
    
    import http.client
    ctx = ssl.create_default_context()
    
    conn = http.client.HTTPSConnection(HOST, 443, timeout=30, context=ctx)
    
    for i in range(5):
        try:
            t0 = time.time()
            conn.request("POST", "/v1beta/openai/chat/completions",
                        body=SMALL_BODY,
                        headers=HEADERS)
            resp = conn.getresponse()
            t_connected = time.time()
            body = resp.read()
            t_done = time.time()
            
            connect_ms = round((t_connected - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  [{i+1}] response={connect_ms}ms  total={total_ms}ms  status={resp.status}  body={len(body)}b  reused=True")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  [{i+1}] ❌ {elapsed}ms: {type(e).__name__}: {e}")
            # 重建连接
            try: conn.close()
            except: pass
            conn = http.client.HTTPSConnection(HOST, 443, timeout=30, context=ctx)
        
        time.sleep(0.2)
    
    try: conn.close()
    except: pass


def test_http_client_new_each():
    """测试 http.client 每次新连接（对照组）"""
    log("")
    log("=" * 60)
    log("TEST 6: http.client 每次新连接 x5（对照 urllib）")
    log("=" * 60)
    
    import http.client
    ctx = ssl.create_default_context()
    
    for i in range(5):
        try:
            t0 = time.time()
            conn = http.client.HTTPSConnection(HOST, 443, timeout=30, context=ctx)
            conn.request("POST", "/v1beta/openai/chat/completions",
                        body=SMALL_BODY,
                        headers=HEADERS)
            resp = conn.getresponse()
            t_connected = time.time()
            body = resp.read()
            t_done = time.time()
            conn.close()
            
            connect_ms = round((t_connected - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  [{i+1}] response={connect_ms}ms  total={total_ms}ms  status={resp.status}  body={len(body)}b")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  [{i+1}] ❌ {elapsed}ms: {type(e).__name__}: {e}")
        
        time.sleep(0.2)


def test_large_body_stream():
    """测试大 body + stream（最接近 runner.py 实际负载）"""
    log("")
    log("=" * 60)
    log("TEST 7: 大 body + stream（模拟真实 skill 负载）")
    log("=" * 60)
    
    import urllib.request
    ctx = ssl.create_default_context()
    
    # 模拟带 tools + 长 system prompt 的请求（~15KB）
    big_body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. " * 200},
            {"role": "user", "content": "Summarize your capabilities in 3 sentences."},
        ],
        "max_tokens": 200,
        "stream": True,
        "tools": [
            {"type": "function", "function": {"name": "exec", "description": "Execute a shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
            {"type": "function", "function": {"name": "read_file", "description": "Read a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
            {"type": "function", "function": {"name": "write_file", "description": "Write a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
        ],
        "tool_choice": "auto",
    }).encode()
    
    log(f"  请求体大小: {len(big_body)} bytes")
    
    for i in range(3):
        try:
            t0 = time.time()
            req = urllib.request.Request(
                f"{BASE_URL}/chat/completions",
                data=big_body,
                headers=HEADERS,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                t_connected = time.time()
                first_line = r.readline()
                t_first = time.time()
                rest = r.read()
                t_done = time.time()
            
            connect_ms = round((t_connected - t0) * 1000)
            first_ms = round((t_first - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  [{i+1}] connect={connect_ms}ms  first={first_ms}ms  total={total_ms}ms")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  [{i+1}] ❌ {elapsed}ms: {type(e).__name__}: {e}")
        
        time.sleep(0.5)


def test_multi_turn_simulation():
    """TEST 8: 模拟真实 runner.py 的多轮对话（最接近 SSL EOF 场景）
    - max_tokens=32000（和 runner.py 一致）
    - 复杂 system prompt + 工具（逼 Gemini 长时间 thinking）
    - 轮间等 30-60 秒
    - stream=True
    """
    log("")
    log("=" * 60)
    log("TEST 8: 模拟 runner.py 多轮对话（max_tokens=32000, 间隔 30-60s）")
    log("=" * 60)
    
    import urllib.request
    ctx = ssl.create_default_context()
    
    # 复杂 system prompt（模拟真实 SKILL.md）
    system_prompt = """你是一位专业的 AI 营养师。你的任务是根据用户的健康数据制定个性化的饮食方案。

请严格按照以下步骤执行：
1. 首先使用 exec 命令检查用户的健康档案
2. 分析用户的 BMI、血压、血糖等指标  
3. 根据分析结果制定每周 7 天的详细饮食计划
4. 每餐需包含：食材、克重、烹饪方式、营养成分
5. 特别注意用户的过敏史和禁忌食物

你必须使用工具来验证你的建议是否符合最新的营养学指南。
每个建议都需要有科学依据支持。
请详细思考每一步，确保方案的安全性和有效性。
""" * 10  # ~5KB
    
    tools = [
        {"type": "function", "function": {"name": "exec", "description": "在沙箱中执行 shell 命令。可以执行任意 bash 命令来完成任务，包括文件操作、数据处理、网络请求等。注意：所有文件路径必须使用绝对路径。", "parameters": {"type": "object", "properties": {"command": {"type": "string", "description": "要执行的 bash 命令字符串"}}, "required": ["command"]}}},
        {"type": "function", "function": {"name": "read_file", "description": "读取指定路径的文件内容。支持文本文件和二进制文件。对于大文件会自动截断。", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "文件的绝对路径"}}, "required": ["path"]}}},
        {"type": "function", "function": {"name": "write_file", "description": "将内容写入指定路径的文件。如果文件不存在会自动创建，如果目录不存在也会自动创建目录。", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "文件的绝对路径"}, "content": {"type": "string", "description": "要写入的文件内容"}}, "required": ["path", "content"]}}},
        {"type": "function", "function": {"name": "web_search", "description": "使用 Tavily 搜索引擎搜索网络信息。返回搜索结果的摘要和链接。", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "搜索查询字符串"}, "max_results": {"type": "integer", "description": "最大返回结果数"}}, "required": ["query"]}}},
    ]
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "用户张先生，42岁男性，血压偏高（145/95mmHg），空腹血糖 6.8mmol/L，体重75kg，身高178cm，BMI 23.7。有轻度脂肪肝。过敏食物：虾蟹。请先检查他的健康档案，然后制定详细的个性化营养方案。"},
    ]
    
    for turn in range(4):
        body = json.dumps({
            "model": MODEL,
            "messages": messages,
            "max_tokens": 32000,
            "stream": True,
            "tools": tools,
            "tool_choice": "auto",
        }).encode()
        
        body_kb = round(len(body) / 1024, 1)
        log(f"\n  Turn {turn+1}: body={body_kb}KB  msgs={len(messages)}")
        
        try:
            t0 = time.time()
            req = urllib.request.Request(
                f"{BASE_URL}/chat/completions",
                data=body,
                headers=HEADERS,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
                t_connected = time.time()
                # 流式读完
                content = b""
                while True:
                    line = r.readline()
                    if not line:
                        break
                    content += line
                t_done = time.time()
            
            connect_ms = round((t_connected - t0) * 1000)
            total_ms = round((t_done - t0) * 1000)
            log(f"  Turn {turn+1}: ✅ connect={connect_ms}ms  total={total_ms}ms  response={len(content)}b")
        except Exception as e:
            elapsed = round((time.time() - t0) * 1000)
            log(f"  Turn {turn+1}: ❌ {elapsed}ms: {type(e).__name__}: {e}")
        
        # 模拟 AI 回复 + 工具执行结果
        messages.append({"role": "assistant", "content": f"Turn {turn+1} response " * 50})
        messages.append({"role": "user", "content": f"Tool output for turn {turn+1}: " + "x" * 2000})
        
        # 关键：模拟工具执行间隔（真实场景 30-60 秒）
        if turn < 3:
            wait = 30 + turn * 15  # 30s, 45s, 60s
            log(f"  等待 {wait}s（模拟真实工具执行间隔）...")
            time.sleep(wait)


def main():
    log("🔬 SSL 诊断开始")
    log(f"   HOST: {HOST}")
    log(f"   MODEL: {MODEL}")
    log(f"   API_KEY: {API_KEY[:8]}...{API_KEY[-4:]}" if API_KEY else "   ⚠️ 无 API_KEY!")
    log(f"   Python: {sys.version}")
    log(f"   OpenSSL: {ssl.OPENSSL_VERSION}")
    log("")
    
    ip = test_dns()
    if not ip:
        log("❌ DNS 失败，中止")
        return "\n".join(results)
    
    test_tcp_tls(ip)
    test_urllib_single()
    test_urllib_stream()
    test_http_client_reuse()
    test_http_client_new_each()
    test_large_body_stream()
    test_multi_turn_simulation()
    
    log("")
    log("=" * 60)
    log("🏁 诊断完成")
    log("=" * 60)
    
    return "\n".join(results)


if __name__ == "__main__":
    print(main())
