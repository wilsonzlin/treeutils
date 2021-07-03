const fs = require("fs");

for (const f of fs.readdirSync("js")) {
  fs.writeFileSync(
    `js/${f}`,
    `#!/usr/bin/env node\n${fs.readFileSync(`js/${f}`)}`
  );
  fs.chmodSync(`js/${f}`, 0o555);
}
