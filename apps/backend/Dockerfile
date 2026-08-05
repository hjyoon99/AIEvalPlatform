FROM node:22-alpine AS build

WORKDIR /app/apps/backend

COPY apps/backend/package.json ./
RUN npm install

COPY apps/backend ./
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app/apps/backend
ENV NODE_ENV=production

COPY --from=build /app/apps/backend ./

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:prod"]
