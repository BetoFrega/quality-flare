// What the test runtime's CommonJS dependencies take from "util" (@sinonjs/fake-timers: promisify).
// The bundle is an ES module, where require("util") has nothing to call.
export { promisify } from "node:util";
