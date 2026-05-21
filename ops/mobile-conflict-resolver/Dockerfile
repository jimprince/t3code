FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq unzip \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && mkdir -p /usr/local/bun \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s -- bun-v1.3.11 \
  && ln -s /usr/local/bun/bin/bun /usr/local/bin/bun \
  && ln -s /usr/local/bun/bin/bunx /usr/local/bin/bunx \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 resolver \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin resolver

COPY scripts/mobile-conflict-resolver.sh /usr/local/bin/mobile-conflict-resolver
RUN chmod 0755 /usr/local/bin/mobile-conflict-resolver

USER 10001:10001
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/mobile-conflict-resolver"]
