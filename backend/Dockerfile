FROM node:18-alpine

WORKDIR /usr/src/app

# Tools for ani-cli (anime resolver)
RUN apk add --no-cache bash curl jq fzf aria2 ca-certificates git coreutils \
  && git clone "https://github.com/pystardust/ani-cli.git" /tmp/ani-cli \
  && cp /tmp/ani-cli/ani-cli /usr/local/bin/ani-cli \
  && chmod +x /usr/local/bin/ani-cli \
  && rm -rf /tmp/ani-cli \
  && curl -sL https://github.com/justchokingaround/lobster/raw/main/lobster.sh -o /usr/local/bin/lobster \
  && chmod +x /usr/local/bin/lobster

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/index.js"]
