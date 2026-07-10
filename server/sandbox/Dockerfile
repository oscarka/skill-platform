FROM node:20-slim

# 一次性装好所有工具（包含 procps/iproute2/lsof 等 Reflect 需要的命令）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl wget jq bash coreutils \
    procps iproute2 lsof \
    && rm -rf /var/lib/apt/lists/*

# python3 软链接
RUN ln -sf /usr/bin/python3 /usr/bin/python

# pip 常用包
RUN pip3 install --no-cache-dir requests httpx 2>/dev/null || true

WORKDIR /workspace
RUN useradd -m -u 1001 sandbox && chown -R sandbox:sandbox /workspace
USER sandbox
CMD ["bash"]
