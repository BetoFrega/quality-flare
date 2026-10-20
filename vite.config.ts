import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { docs } from "./build/docs.ts";
import { testRuntime } from "./build/test-runtime.ts";

export default defineConfig({
	plugins: [testRuntime(), docs(), cloudflare()],
});
