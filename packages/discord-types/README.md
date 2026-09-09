# Discord types

`@equicord/discord-types` provides TypeScript declarations for Discord's webpack modules and const enums. It is used by Protonn Cord and can be used by other clients.

```sh
pnpm add -D @equicord/discord-types
```

The package supplies types; your client must provide the runtime module lookup:

```ts
import type { UserStore } from "@equicord/discord-types";

const userStore: UserStore = findStore("UserStore");
```

Import enums from the `/enums` entry point:

```ts
import { ApplicationCommandType } from "@equicord/discord-types/enums";

console.log(ApplicationCommandType.CHAT_INPUT); // 1
```

When contributing declarations, check them against current Discord behavior. [Discord Unofficial Documentation](https://docs.discord.food) is a useful API reference.

Licensed under [LGPL-3.0-or-later](./LICENSE). Inspired by Swishilicous' [discord-types](https://www.npmjs.com/package/discord-types).
