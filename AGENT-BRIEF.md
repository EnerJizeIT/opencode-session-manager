# Agent Brief — Реализация OpenCode Session Manager Plugin

## Инструкция для агента-исполнителя

Ты — исполнитель. Тебе передана спецификация плагина opencode. Твоя задача — реализовать его полностью, следуя TODO.md по шагам.

### Что читать

1. `README.md` — описание проекта, архитектура, схема БД, команды
2. `TODO.md` — пошаговый список задач с логикой, проверками и форматами вывода

### Порядок работы

1. Читать README.md полностью — понять контекст, архитектуру, схему БД
2. Читать TODO.md полностью — понять все задачи
3. Выполнять задачи строго по порядку: Фаза 0 → 1 → 2 → 3 → 4
4. После каждой фазы — проверить, что всё работает (см. «Проверка» в каждом пункте)
5. Только после успешного прохождения всех фаз — делать git commit

### Где писать код

Файл плагина: `~/.config/opencode/plugins/session-manager.ts`

Это единый файл. Не разбивать на модули — весь код в одном файле.

### Ссылки на документацию opencode

- Плагины: https://opencode.ai/docs/plugins/
- Custom tools в плагинах: раздел "Custom tools" на странице плагинов
- Event hooks: `session.created`, `session.deleted`, `session.idle`
- CLI: `opencode db path`, `opencode db "<query>" --format json`, `opencode import <file>`

### Пример структуры плагина (из документации opencode)

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    tool: {
      mytool: tool({
        description: "Description of what this tool does",
        args: {
          foo: tool.schema.string(),
        },
        async execute(args, context) {
          return `Result: ${args.foo}`
        },
      }),
    },
    "session.created": async (input, output) => {
      // handle session creation
    },
    "session.deleted": async (input, output) => {
      // handle session deletion
    },
    "session.idle": async (input, output) => {
      // handle session idle
    },
  }
}
```

### Работа с БД

Для запросов к БД использовать одну из стратегий:

**Стратегия A (рекомендуется):** Вызов `opencode db` через Bun shell:
```typescript
const result = await $`opencode db "SELECT id, title FROM session LIMIT 5" --format json`
const rows = JSON.parse(result.stdout.toString())
```

**Стратегия B:** Прямое подключение через Bun.sql:
```typescript
import { sql } from "bun"
const dbPath = process.env.HOME + "/.local/share/opencode/opencode.db"
const db = await sql.open(dbPath)
const rows = await db.queryAll("SELECT id, title FROM session LIMIT 5")
```

Если Bun.sql не доступен или вызывает ошибки — переключиться на Стратегию A.

### Работа с файловой системой

Использовать Bun.file / Bun.write или Node.js fs/promises:
```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs"
import { join, homedir } from "path"
```

### Важные правила

- НЕ менять схему БД opencode
- НЕ трогать встроенные команды opencode
- Все данные плагина — во внешних файлах (`session-manager.json`, `backups/`)
- Атомарная запись state: писать в `.tmp`, потом rename
- Обработка ошибок: try/catch вокруг всех операций с ФС и БД
- JSDoc для каждого tool

### Git

После реализации ВСЕХ фаз:
1. `git add ~/.config/opencode/plugins/session-manager.ts`
2. Скопировать `session-manager.ts` в репозиторий проекта
3. `git add . && git commit -m "feat: implement session-manager plugin"`
4. `git push`

НЕ коммитить `session-manager.json` и бэкапы.
