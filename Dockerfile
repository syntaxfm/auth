# Local development image: runs Syntax Auth in its secret-free `local` mode on port 37960.
# Never deploy this image; production runs on Cloudflare Workers.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build once and serve the build with `vite preview`. Nobody edits code in this container, so a dev
# server's file watching would only cost memory, and `wrangler dev`'s esbuild watcher costs CPU even
# when idle. Both run the app in Node against Wrangler's local D1, as `vite dev` does.
RUN pnpm build
EXPOSE 37960
VOLUME /app/.wrangler
CMD ["sh", "-c", "pnpm d1:migrate:local && exec node_modules/.bin/vite preview --host 0.0.0.0 --port 37960 --strictPort"]
