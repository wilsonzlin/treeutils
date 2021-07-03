const fs = require("fs");

fs.mkdirSync("bin", { recursive: true });
for (const f of fs.readdirSync("js")) {
  if (!f.endsWith(".js")) {
    continue;
  }
  fs.writeFileSync(
    `bin/${f.slice(0, -3)}`,
    `#!/usr/bin/env node\n${fs.readFileSync(`js/${f}`)}`,
    { mode: 0o555 }
  );
}
