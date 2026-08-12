FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Which port the desktop bundle's 📱 button points at. Vite inlines VITE_* at
# build time, so it has to be known here rather than at run time.
ARG VITE_PHONE_PORT=8081
ENV VITE_PHONE_PORT=$VITE_PHONE_PORT
RUN npm run build

FROM nginx:alpine
# apache2-utils for htpasswd (optional basic auth), openssl for a self-signed
# certificate when there is no real one to hand.
RUN apk add --no-cache apache2-utils openssl
COPY --from=build /app/dist /usr/share/nginx/html
COPY entrypoint.sh /docker-entrypoint-veditor.sh
RUN chmod +x /docker-entrypoint-veditor.sh
EXPOSE 80 443 8081
ENTRYPOINT ["/docker-entrypoint-veditor.sh"]
