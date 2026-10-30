import { runHost } from "./host.ts";
import { runMcp } from "./mcp.ts";

const [cmd] = process.argv.slice(2);
if (cmd === "native-host") {
  await runHost({ input: process.stdin, output: process.stdout });
  process.exit(0);
} else if (cmd === "mcp") {
  await runMcp();
  process.exit(0);
} else {
  process.stderr.write("usage: webop native-host | webop mcp\n");
  process.exit(2);
}
