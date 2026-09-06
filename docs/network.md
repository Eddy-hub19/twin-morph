# Network

Реализовано: `server/` (NestJS) + `game/network/` и `hooks/useGameSocket.ts` (Next.js) + `shared/game-protocol.ts` (общие типы).

## Запуск

```bash
npm run server:install   # один раз
npm run dev:server       # NestJS, порт 3001
npm run dev               # Next.js, порт 3000 — в отдельном терминале
```

Клиенту нужен `NEXT_PUBLIC_GAME_SERVER_URL` (см. `.env.local.example`), по
умолчанию `http://localhost:3001`.

## Режимы

- **Single Player** — `GameNetworkStore.startSolo()`. К серверу вообще не
  подключается: локальная симуляция через `stepPlayerState` (та же чистая
  функция, что использует и сервер) — сеть не нужна и не требуется.
- **Co-op (2 игрока)** — `GameNetworkStore.startCoop()`. Подключается через
  `GameSocket` (singleton `socket.io-client`), автоматически создаёт/находит
  комнату (максимум 2 игрока), дальше сервер авторитетен.

Выбор режима — `components/Game/ModeSelect.tsx`, подключён в `app/page.tsx`.

## Поток данных (co-op)

```
InputManager (аналоговый вектор)
        │
        ▼
GameNetworkStore.update(dt, {dx,dy})
        │  ├─ local prediction: stepPlayerState() применяется СРАЗУ
        │  └─ playerInput -> Socket.IO -> GameGateway -> GameService.queueInput()
        ▼
GameLoopService (тик 20 Гц)
        │  GameService.tickRoom(): stepPlayerState() по последнему инпуту
        │  каждого игрока — это и есть "server authoritative state"
        ▼
stateSnapshot -> оба клиента в комнате
        │
        ├─ свой игрок: reconciliation (обрезаем pendingInputs по
        │   lastProcessedSeq, переигрываем остаток поверх снапшота)
        └─ чужой игрок: remote interpolation (буфер из 2 последних
            снапшотов, линейная интерполяция с задержкой в 1 тик)
```

## Reconnect / disconnect cleanup

Клиент хранит `sessionId` в `localStorage` (`GameSocket.getSessionId()`).
При обрыве связи `socket.io-client` сам переподключает транспорт
(`reconnection: true`), а `GameNetworkStore` при событии `connect` заново
шлёт `joinRoom` с тем же `sessionId` — `RoomService.joinRoom()` узнаёт
игрока и возвращает его в ту же комнату с той же позицией, а не создаёт
нового. Если игрок не вернулся за `RECONNECT_GRACE_MS` (30с), его
вычищает `RoomService.sweepStaleDisconnects()` (вызывается из
`GameLoopService` каждый тик) — и комната удаляется, если опустела.

## Файлы

| Слой | Файл | Роль |
|---|---|---|
| Общее | `shared/game-protocol.ts` | Типы событий/payload'ов, `stepPlayerState` |
| Сервер | `server/src/game/game.gateway.ts` | Socket.IO хендлеры (`joinRoom`, `playerInput`, ...) |
| Сервер | `server/src/game/room.service.ts` | Комнаты, sessionId, reconnect, cleanup |
| Сервер | `server/src/game/game.service.ts` | Авторитетное состояние игроков |
| Сервер | `server/src/game/game-loop.service.ts` | Тик 20 Гц, рассылка снапшотов |
| Клиент | `game/network/GameSocket.ts` | Singleton `socket.io-client` + sessionId |
| Клиент | `game/network/GameNetworkStore.ts` | Prediction/reconciliation/interpolation, solo/co-op |
| Клиент | `hooks/useGameSocket.ts` | React-обвязка (`useSyncExternalStore`) |
| Клиент | `components/Game/ModeSelect.tsx` | Экран выбора режима |

## Не сделано (сознательно, вне рамок этой задачи)

Сеть синхронизирует общую позицию/форму/уровень, но **не** прорисовывает
второго игрока внутри `GameScene` (нет второго Worm/Ant на экране, не
синхронизированы стены/копание/звёзды/враги — вся эта механика в игре
пока полностью локальна для активного `GameScene`). Чтобы реально видеть
напарника и общий мир, `GameScene.update()` нужно завести на
`GameNetworkStore.getRemotePlayerStates()` и рендерить по сущности на
каждого — протокол и стор для этого уже готовы, дальше это отдельная
(немаленькая) работа по самой сцене.
