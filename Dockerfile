FROM node:20

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY src ./src
COPY tsconfig.json ./

RUN npm install
RUN npm run build || (echo 'build failed' && ls -l dist && ls -l dist/services && cat dist/*.js && cat dist/services/*.js)
RUN ls -l dist || true
RUN ls -l dist/services || true

CMD ["node", "dist/index.js"] 