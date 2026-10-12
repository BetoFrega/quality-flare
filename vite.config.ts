import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { testRuntime } from "./build/test-runtime.ts";

export default defineConfig({
	plugins: [testRuntime(), cloudflare()],
});
