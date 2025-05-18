FROM node:20

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY src ./src
COPY tsconfig.json ./
COPY bot_logic.yaml ./
COPY bocchy-character.yaml ./

RUN npm install --production=false
RUN npm run build || (echo 'build failed' && find /app -type f && ls -l /app/dist || true && ls -l /app/dist/services || true && cat /app/npm-debug.log || true)
RUN ls -l dist || true
RUN ls -l dist/services || true

CMD ["node", "dist/index.js"] 