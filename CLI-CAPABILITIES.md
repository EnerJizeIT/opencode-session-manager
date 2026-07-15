# CLI-CAPABILITIES — реальные возможности opencode CLI

> Снято с `opencode v1.17.20` на машине пользователя.
> Источник истины для README/TODO. Всё, что расходится с этим файлом, — ошибка спеки.

## Команды (подтверждены `--help`)

| Команда | Статус | Что делает | Флаги |
|---|---|---|---|
| `opencode session list` | ✅ | Список сессий | `--format json\|tsv` |
| `opencode session delete <id>` | ✅ | **Жёсткое** удаление сессии (каскадно message/part) | — |
| `opencode session archive` | ❌ | **НЕ существует** | — |
| `opencode export [sessionID]` | ✅ | Экспорт сессии в JSON на stdout | `--sanitize` |
| `opencode import <file>` | ✅ | Импорт из JSON-файла или share URL | — |
| `opencode db "<sql>"` | ✅ | Read-only SQL (можно и write, но см. решения) | `--format json\|tsv` |
| `opencode db path` | ✅ | Путь к БД | — |
| `opencode plugin <module>` | ✅ | Установка npm-плагина | `-g`, `-f` |

## Вывод `opencode session list --format json`

Массив объектов с полями:
```json
{ "id": "ses_...", "title": "...", "updated": 1784137363992,
  "created": 1784136679716, "projectId": "global", "directory": "/home/..." }
```
- Времена — **unix ms**.
- `time_archived` в выдаче **отсутствует** (есть только в БД).
- Поля названы `updated`/`created` (не `time_updated`, как в БД).

## Вывод `opencode export <id>` (формат бэкапа)

```json
{
  "info": { "id", "slug", "projectID", "directory", "path", "title",
            "agent", "model", "version", "summary", "cost", "tokens",
            "time": { "created", "updated" } },
  "messages": [ { "info": {...}, "parts": [ {"type","text"} ] } ]
}
```
Это **родной round-trip формат** `opencode import`. Бэкап = просто `opencode export <id> > ses_XXX.json`.

## ⚠️ Вывод `opencode` CLI загрязнён

Первая строка stdout у пользователя:
```
[page-assist] CLI mode — skipping WS server and page tools (serve mode only)
```
→ Любой парсинг JSON должен **искать первый `{`/`[`**, а не `JSON.parse` «как есть». (Заметка: внутри TUI/плагина контекста этого может не быть, но устойчивость нужна.)

## Плагины (подтверждено докой + проверено)

- **Локальные `.ts`/`.js` в `~/.config/opencode/plugins/`** — автозагрузка при старте. ✅ Спека верна.
- **npm в `opencode.json: { "plugin": [...] }`** — альтернатива.
- Контекст плагина: `{ project, client, $, directory, worktree }`.
  - `$` — **Bun shell** (идиоматичный способ дёргать CLI, а не `child_process.execSync`).
  - `client` — opencode SDK (`client.app.log(...)`).
- Импорт типов: `import type { Plugin } from "@opencode-ai/plugin"` и `import { tool } from "@opencode-ai/plugin"` (или подроут `@opencode-ai/plugin/tool`).

## События (подтверждено докой plugins)

Доступны хуки сессий:
`session.created`, `session.deleted`, `session.updated`, `session.idle`,
`session.compacted`, `session.diff`, `session.error`, `session.status`.

→ **`session.idle` существует** — автоочистка реализуема (TODO 3.4).
→ **`session.deleted` существует** — автоуборка из pinned-листа реализуема.

## Схема БД (подтверждено `sqlite_master`)

`session` имеет колонки (важные): `id`, `project_id`, `slug`, `directory`, `path`,
`title`, `version`, `metadata`, `cost`, `tokens_*`, `agent`, `model`,
`time_created`, `time_updated`, `time_compacting`, **`time_archived`** (nullable).

`message`/`part` — FK с `ON DELETE CASCADE`. Удаление session чистит всё.

## Вывод: что из спеки неверно

1. **Нет `opencode session archive`** — Фаза 3 (cleanup) в текущем виде нереализуема.
2. **AGENT-BRIEF предлагает `child_process.execSync` + `Bun.sql`** — устарело; в плагине есть `$` (Bun shell) и `opencode` CLI.
3. **`opencode import`** реально есть и работает с файлом — `RESTORE.md` корректен.
4. **Поля времени в `session list`** названы `created`/`updated`, а не `time_*` — фикс в TODO.
5. **`time_archived` не возвращается CLI** — фильтр «уже архивирована» возможен только через `opencode db`.

## Найдено при dogfooding (верификация плагина)

6. **⚠️ `opencode run` (headless) НЕ регистрирует custom plugin tools.** Проверено: даже
   минимальный плагин из официальной доки (`hello_test` из https://opencode.ai/docs/plugins/)
   недоступен агенту в `opencode run --agent general` — модель видит только встроенные
   tools (bash/edit/grep/read/…). Плагин-модуль при этом грузится (top-level код
   выполняется,видно по `[page-assist]`-шуму), но tools в headless-режиме не подключаются.
   → **Вывод:** функционально проверить plugin tools через `opencode run` нельзя — только
   через интерактивный TUI. Для CI/верификации awf полагаемся на `bun build` + структурные
   проверки + code review. Реальная проверка вызова tool — вручную в TUI.
7. **Паттерн экспорта плагина** (вопреки опасениям) — `export const X: Plugin = async (ctx) => ({tool:{...}})`
   с `import { type Plugin, tool } from "@opencode-ai/plugin"`. Это **правильный** паттерн
   (подтверждено докой). `export default` тоже работает (стиль `page-assist.ts`), но не обязателен.
8. **Деплой:** opencode грузит локальные `.ts` из `~/.config/opencode/plugins/` (real file).
   Надёжность symlink'а для автозагрузки не подтверждена — используем **copy** как метод деплоя.
