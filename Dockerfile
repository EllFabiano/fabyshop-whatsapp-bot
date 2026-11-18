FROM node:20-slim

WORKDIR /app

# Instala as dependencias primeiro para cache do Docker
COPY package*.json ./
RUN npm install --omit=dev

# Copia os restantes ficheiros
COPY . .

# Koyeb usa a porta 8000 por defeito
ENV PORT=8000
EXPOSE 8000

CMD ["node", "server.js"]