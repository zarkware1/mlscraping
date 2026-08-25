# Imagem oficial do Playwright já vem com Chromium + todas as libs de
# sistema necessárias (nss, atk, etc.) — instalar isso via Nixpacks é
# instável, a imagem oficial evita esse problema inteiro.
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
