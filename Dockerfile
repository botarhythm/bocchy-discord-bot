FROM node:20

WORKDIR /app

COPY package.json ./
COPY pnpm-lock.yaml ./
COPY src ./src
COPY tsconfig.json ./

RUN npm install -g pnpm
RUN pnpm install
RUN pnpm build

CMD ["node", "dist/index.js"] 