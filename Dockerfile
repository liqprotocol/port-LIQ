# Builder
FROM node:alpine3.14 as builder

RUN mkdir -p /app
WORKDIR /app

COPY . ./
RUN yarn install

# Runner
FROM node:alpine3.14

COPY --from=builder /app /app
WORKDIR /app

COPY entrypoint.sh /
ENTRYPOINT [ "/entrypoint.sh" ]
