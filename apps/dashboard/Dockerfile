FROM node:22-alpine AS build

WORKDIR /app/apps/dashboard

COPY apps/dashboard/package.json ./
RUN npm install

COPY apps/dashboard ./
ARG VITE_API_URL=http://localhost:3000/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine

COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 80
