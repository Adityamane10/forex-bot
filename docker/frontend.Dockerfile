FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
RUN npm install --no-audit --no-fund
COPY shared shared
COPY frontend frontend
RUN npm run build --workspace shared && npm run build --workspace frontend

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared shared
COPY --from=build /app/frontend/dist frontend/dist
WORKDIR /app/frontend
EXPOSE 4173
CMD ["npx", "vite", "preview", "--host", "--port", "4173"]
