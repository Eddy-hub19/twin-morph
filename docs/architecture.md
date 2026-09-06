# Twin Morph Architecture

## Stack

- Next.js
- TypeScript
- PixiJS
- React Query
- NestJS
- Socket.IO
- Prisma
- PostgreSQL (Neon)

---

## Layers

React
↓
Game Component
↓
Game Engine
↓
Scene
↓
Systems
↓
Entities
↓
Renderer

---

## Project Structure

app/
components/
game/
services/
types/

---

## Rules

- React не управляет игрой
- Game Engine не зависит от React
- Один класс — одна ответственность
