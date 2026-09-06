# Network

Реализовано: `server/` (NestJS) + `game/network/` и `hooks/useGameSocket.ts` (Next.js) + `shared/game-protocol.ts` (общие типы). Напарник в co-op виден в игре как настоящий второй `Worm`/`Ant` (см. "Рендер напарника" ниже) — не отдельный "призрак"-объект.

## Запуск

```bash
npm run server:install   # один раз
npm run dev:server       # NestJS, порт 3001
npm run dev               # Next.js, порт 3000 — в отдельном терминале
```

Клиенту нужен `NEXT_PUBLIC_SOCKET_URL` (см. `.env.local.example`), по
умолчанию `http://localhost:3001`.

## Деплой (прод)

- **Фронтенд** — Vercel, `https://twin-morph.vercel.app`. `NEXT_PUBLIC_SOCKET_URL`
  берётся из закоммиченного `.env.production` (не секрет — публичный URL,
  нужен браузеру напрямую), Vercel подхватывает его сам при билде.
- **Сервер** — Render, `https://twin-morph.onrender.com`. Деплоится из
  `render.yaml` (New → Blueprint в Render, указать этот репозиторий) —
  `rootDir: server`, `FRONTEND_URL` уже прописан на адрес Vercel. Без
  блюпринта — то же самое руками: Root Directory `server`, Build Command
  `npm install && npm run build`, Start Command `npm run start`, переменная
  `FRONTEND_URL=https://twin-morph.vercel.app` (см. `server/.env.example`).
  `PORT` подставляет сам Render, ничего указывать не нужно.

## Режимы

- **Single Player** — `GameNetworkStore.startSolo()`. К серверу вообще не
  подключается — сеть не нужна и не требуется.
- **Co-op (2 игрока)** — `GameNetworkStore.startCoop(roomId?)`. Подключается через
  `GameSocket` (singleton `socket.io-client`); без `roomId` сервер сам находит
  свободную комнату или создаёт новую (максимум 2 игрока), с `roomId` —
  присоединяется именно к ней (см. "Подключение по ссылке").

Выбор режима — `components/Game/ModeSelect.tsx`, подключён в `app/page.tsx`.

## Подключение к комнате по ссылке

После входа в co-op текущий URL получает `?room=<id>` (см.
`ModeSelect.setRoomInUrl`) — это и есть ссылка-приглашение, её можно
скопировать кнопкой в `RoomStatusBadge`, пока комната не заполнена. Если
открыть игру по такой ссылке, `ModeSelect` видит параметр `room` в адресе и
сразу предлагает присоединиться именно к этой комнате (кнопка
"Присоединиться"), а не искать любую свободную — при этом на сервере
`RoomService.joinRoom(sessionId, roomId)` сначала пробует именно её и только
если она уже заполнена/не существует — откатывается к обычному автопоиску.

## Рендер напарника (реальный второй Worm/Ant)

`GameScene.syncNetwork()` вызывается первой строкой в `update()` (работает
независимо от состояния локального игрока — метаморфозы, смерти и т.п.):

1. Шлёт текущую позицию + форму локального игрока через
   `GameNetworkStore.reportLocalPose(x, y, form)` — **не** генерик
   `stepPlayerState`, а уже честно посчитанная своим `Worm`/`Ant` позиция
   (с учётом стен/копания/травы, которые процедурны и у каждого клиента
   свои — сервер их не знает и не может пересчитать заново).
2. Для каждого игрока из `GameNetworkStore.getRemotePlayerStates()` —
   заводит/двигает/удаляет `remoteEntities`: **тот же класс** (`Worm` или
   `Ant`), что и у локального игрока, просто управляемый не `InputManager`, а
   методом `setRemotePosition()` (двигает + проигрывает анимацию ходьбы по
   факту смещения между кадрами, без своей физики/столкновений). Когда
   напарник у себя проходит метаморфозу (`form` меняется на `"ant"` в
   снапшоте) — его сущность здесь пересоздаётся `Worm → Ant` мгновенно, без
   кат-сцены с зумом (камера в этой сцене одна и следит только за нашим
   игроком).
3. Remote-сущности исключены из обычного per-entity `update()`-цикла
   (`isRemoteEntity()`, та же оговорка, что и у `GuardWorm`) — иначе они
   проходили бы обычную физику/столкновения и, например, спавнясь в (0,0) до
   первого снапшота, могли тут же "умереть" от стены на этом месте (ровно
   так нашёлся баг при первой проверке).

Сервер в этой части — не физический авторитет, а доверенный ретранслятор
(`GameService.setPose`): держит последнюю присланную клиентом позу и
рассылает её остальным в комнате раз в тик (см. комментарий в самом файле).
Старый generic-путь (`playerInput`/`stepPlayerState`/reconciliation) оставлен
нетронутым как переиспользуемая инфраструктура, но реальным движением игры
сейчас не пользуется.

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
| Сервер | `server/src/game/game.gateway.ts` | Socket.IO хендлеры (`joinRoom`, `playerPose`, ...) |
| Сервер | `server/src/game/room.service.ts` | Комнаты, sessionId, reconnect, cleanup |
| Сервер | `server/src/game/game.service.ts` | Состояние игроков (pose-relay + generic-инфра) |
| Сервер | `server/src/game/game-loop.service.ts` | Тик 20 Гц, рассылка снапшотов |
| Клиент | `game/network/GameSocket.ts` | Singleton `socket.io-client` + sessionId |
| Клиент | `game/network/GameNetworkStore.ts` | `reportLocalPose`, remote interpolation, solo/co-op |
| Клиент | `hooks/useGameSocket.ts` | React-обвязка (`useSyncExternalStore`) |
| Клиент | `components/Game/ModeSelect.tsx` | Выбор режима + подключение по ссылке |
| Клиент | `components/Game/RoomStatusBadge.tsx` | Статус комнаты + копирование ссылки |
| Клиент | `game/scenes/GameScene.ts` | `syncNetwork()`/`upsertRemoteEntity()` — рендер напарника |

## Известное ограничение (сознательно, следующий шаг)

Уровень (стены/звёзды/враги) генерируется процедурно и независимо на КАЖДОМ
клиенте — не по общему seed'у. Оба игрока видят друг друга и оба честно
проходят копание → метаморфозу → бег муравья, но если они окажутся на разных
уровнях/сегментах, их координаты перестают визуально соответствовать одному
и тому же месту в мире друг друга. Чтобы карта была по-настоящему общей,
нужен детерминированный сид уровня, разосланный сервером при старте комнаты,
и синхронизация самих переходов между уровнями — это отдельная, более
крупная работа поверх уже готового сетевого слоя.
