# Agent Brief — Реализация OpenCode Session Manager Plugin

## Инструкция для агента-исполнителя

Ты — исполнитель. Тебе передана спецификация плагина opencode. Твоя задача — реализовать его полностью, следуя `docs/SPEC.md` по шагам.

### Что читать

1. `README.md` — описание проекта, архитектура, схема БД, команды
2. `docs/SPEC.md` — пошаговый список задач с логикой, проверками и форматами вывода

### Порядок работы

1. Читать README.md полностью — понять контекст, архитектуру, схему БД
2. Читать docs/SPEC.md полностью — понять все задачи
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

Скелет для этого плагина — один файл, экспортирует функцию, возвращает хуки + `tool`:

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const SessionManagerPlugin: Plugin = async ({ client, $ }) => {
  // $ — Bun shell для вызова opencode CLI (см. след. раздел)
  // client — opencode SDK для client.app.log({ body: {...} })

  return {
    tool: {
      sm_pin: tool({
        description: "Pin a session by id",
        args: { sessionId: tool.schema.string() },
        async execute(args, ctx) {
          // реализация (см. TODO Фаза 1)
          return `Pinned: ${args.sessionId}`
        },
      }),
      // ... sm_unpin, sm_list, sm_search, sm_backup, sm_restore,
      //     sm_full_backup, sm_cleanup, sm_cleanup_backups, sm_settings, sm_config
    },

    // Хуки подтверждены докой plugins (см. docs/CLI-CAPABILITIES.md «События»)
    "session.deleted": async (input, output) => {
      // убрать удалённую сессию из pinned-листа
    },
    "session.idle": async (input, output) => {
      // автоочистка + ротация бэкапов (если включены в настройках, с debounce 1ч)
    },
  }
}
```

**Важно про UX:** `tool.*` — это custom tools, которые **вызывает сама модель**
(пользователь пишет «запинть сессию X» → агент вызывает `sm_pin`). Это НЕ слеш-команды,
которые пользователь набирает вручную. Если нужны именно слеш-команды — отдельная
механика opencode Commands (вне scope MVP).

### Вызов opencode CLI из плагина

Единственный способ вызывать CLI изнутри плагина — **Bun shell `$`** из контекста плагина
(НЕ `child_process.execSync`, НЕ `Bun.sql`):

```typescript
export const SessionManagerPlugin: Plugin = async ({ $, client }) => {
  // $ — это Bun shell: https://bun.com/docs/runtime/shell
  const res = await $`opencode session list --format json`
  const raw = res.stdout.toString()
  const sessions = JSON.parse(raw)
  return { tool: { /* ... */ } }
}
```

### Доступ к БД opencode

**Правило:** все операции с данными сессий идут через CLI (`opencode session list`,
`opencode export`, `opencode import`, `opencode session delete`). Прямой SQL — только
read-only (`opencode db "<SELECT>" --format json`) и **только** когда CLI не отдаёт
нужное поле (например, `time_archived`). Write-операций (INSERT/UPDATE/DELETE) по SQL —
никогда; удаление сессии делается через `opencode session delete <id>`.

Сверяйся с `docs/CLI-CAPABILITIES.md` — это источник истины по доступным командам.

### ⚠️ Шум в stdout opencode

На машине пользователя первая строка stdout содержит `[page-assist] CLI mode ...`.
Поэтому JSON парсить «как есть» нельзя — нужно найти первый `{`/`[`:

```typescript
function parseJson(stdout: string): unknown {
  const start = stdout.search(/[\[{]/)
  return JSON.parse(start >= 0 ? stdout.slice(start) : stdout)
}
```

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
- Обработка ошибок: try/catch вокруг всех операций с ФС и CLI
- **Удаление сессий — только `opencode session delete`** (после бэкапа). Прямой write-SQL запрещён.
- **Бэкапы ротируются осторожно**: удаляются только stale re-exportable
  (сессия ещё жива в БД и не pinned). Pinned-бэкапы и orphaned-бэкапы
  (сессии уже нет в БД) — защищены навсегда.
- JSDoc для каждого tool

### Git

После реализации ВСЕХ фаз:
1. `git add ~/.config/opencode/plugins/session-manager.ts`
2. Скопировать `session-manager.ts` в репозиторий проекта
3. `git add . && git commit -m "feat: implement session-manager plugin"`
4. `git push`

НЕ коммитить `session-manager.json` и бэкапы.
