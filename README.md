# Intergalactic Wars — Online Server

Отдельный Cloudflare Worker для подбора двух игроков и WebSocket-релея игровых событий. Существующий сайт игры этим проектом не заменяется.

## Эндпоинты

- `GET /health` — проверка доступности.
- `GET /ws?playerId=<unique-id>&rating=<number>` — WebSocket-подключение и подбор соперника.

## Локальный запуск

```bash
npm install
npm run dev
```

## Развёртывание

```bash
npx wrangler login
npm run deploy
```

После первого deploy Cloudflare создаст Durable Object namespace согласно миграции в `wrangler.toml`.

## Протокол

Сервер отправляет `waiting`, затем `matched` обоим участникам. В матче он пересылает ограниченный набор событий `input`, `action`, `snapshot`, `leave` и `ping` второму игроку. При отключении отправляет `opponent-disconnected`.

## Важное ограничение текущего этапа

Это только серверный транспорт и подбор. Он **не является авторитетным игровым сервером**: клиентские события пока пересылаются второму игроку, но сервер не рассчитывает физику, попадания, здоровье или победителя. Нельзя доверять клиентскому результату рейтингового матча.

HTML-клиент с WebSocket-интеграцией теперь находится в `public/index.html`. Текущий сервер пересылает игровые события между клиентами, но пока не является авторитетным: он не рассчитывает физику, попадания, здоровье или победителя.


## Telegram game Worker

The Telegram launch URL remains the existing Worker `orange-meadow-ad87`.
The static game build is stored at `public/index.html` and is deployed separately
from the matchmaking server.

For the Telegram game Worker, connect a Cloudflare Workers Builds project to this
repository and use this deploy command:

```bash
npx wrangler deploy --config wrangler-game.toml
```

Keep the existing matchmaking Worker project on its current command:

```bash
npx wrangler deploy
```

This keeps the game host and the WebSocket matchmaking server as separate Workers.
