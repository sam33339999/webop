import { runHost } from "./host.ts";

const [cmd] = process.argv.slice(2);
if (cmd === "native-host") {
  await runHost({ input: process.stdin, output: process.stdout });
  process.exit(0);
} else {
  process.stderr.write("usage: webop native-host\n");
  process.exit(2);
}
