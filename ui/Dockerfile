FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
# apache2-utils for htpasswd (optional basic auth), openssl for a self-signed
# certificate when there is no real one to hand.
RUN apk add --no-cache apache2-utils openssl
COPY --from=build /app/dist /usr/share/nginx/html
COPY entrypoint.sh /docker-entrypoint-veditor.sh
RUN chmod +x /docker-entrypoint-veditor.sh
EXPOSE 80 443
ENTRYPOINT ["/docker-entrypoint-veditor.sh"]
