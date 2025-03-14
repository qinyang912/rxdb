# Dev Mode

The dev-mode plugin adds many checks and validations to RxDB.
This ensures that you use the RxDB API properly and so the dev-mode plugin should always be used when
using RxDB in developement mode.

- Adds validation check for schemas, queries, ORM methods and document fields.
- Adds readable error messages.
- Ensures that `readonly` JavaScript objects are not accidentially mutated.

**IMPORTANT:**: The dev-mode plugin will increase your build size and decrease the performance. It must **always** be used in development. You should **never** use it in production.

```javascript
import { addRxPlugin } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
addRxPlugin(RxDBDevModePlugin);
```

## Usage with Node.js

```ts
async function createDb() {
    if (process.env.NODE_ENV !== "production") {
        await import('rxdb/plugins/dev-mode').then(
            module => addRxPlugin(module as any)
        );
    }

    const db = createRxDatabase( /* ... */ );
}
```


## Usage with Angular

```ts
import { isDevMode } from '@angular/core';

async function createDb() {
    if (isDevMode()){
        await import('rxdb/plugins/dev-mode').then(
            module => addRxPlugin(module as any)
        );
    }

    const db = createRxDatabase( /* ... */ );
    // ...
}

```



--------------------------------------------------------------------------------

If you are new to RxDB, you should continue [here](./rx-database.md)
