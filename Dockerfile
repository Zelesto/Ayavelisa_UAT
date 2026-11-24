FROM node:22-alpine
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
RUN pnpm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "pnpm run db:push && pnpm start"]
