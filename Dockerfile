FROM node:20

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY src ./src
COPY tsconfig.json ./

RUN npm install
RUN npm run build

CMD ["node", "dist/index.js"] 