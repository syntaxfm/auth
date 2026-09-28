# Local development image: runs Syntax Auth in its secret-free `local` mode on port 37960.
# Never deploy this image; production runs on Cloudflare Workers.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
EXPOSE 37960
VOLUME /app/.wrangler
CMD ["sh", "-c", "pnpm d1:migrate:local && exec node_modules/.bin/vite dev --host 0.0.0.0"]
