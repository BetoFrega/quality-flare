# Image of the "Container tests" check (src/checks/tests/container.ts): Node.js with git, Git LFS,
# npm, pnpm and yarn. Each run starts a fresh container whose entrypoint is qf-run.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git git-lfs ca-certificates \
	&& git lfs install --system \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --global corepack@0.36.0 \
	&& corepack enable pnpm yarn

COPY qf-run.sh /usr/local/bin/qf-run
RUN chmod +x /usr/local/bin/qf-run

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/qf-run"]
