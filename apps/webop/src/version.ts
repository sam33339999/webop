import pkg from "../package.json" with { type: "json" };

/** webop's version (apps/webop/package.json); kept equal to the extension manifest version by a unit test. */
export const VERSION: string = pkg.version;
