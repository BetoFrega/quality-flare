import { CONTAINER_PRICES } from "./checks/tests/container.ts";
import type { ContainerUsage } from "./metrics.ts";

/** What containers use, in the units Containers is billed in (https://developers.cloudflare.com/containers/pricing/). */
export interface ContainerResources {
	/** Provisioned memory × time running. */
	memoryGiBs: number;
	/** CPU actually used. */
	vcpuS: number;
	/** Provisioned disk × time running. */
	diskGBs: number;
}

/** Monthly allowances of the Workers Paid plan: 25 GiB-hours, 375 vCPU-minutes, 200 GB-hours. */
export const CONTAINER_INCLUDED: ContainerResources = { memoryGiBs: 25 * 3600, vcpuS: 375 * 60, diskGBs: 200 * 3600 };

/** At list price, before the monthly allowances. */
export function containerCost(r: ContainerResources): number {
	return r.memoryGiBs * CONTAINER_PRICES.memoryGiBs + r.vcpuS * CONTAINER_PRICES.vcpuS + r.diskGBs * CONTAINER_PRICES.diskGBs;
}

/** A month's cost past the allowances, as if nothing else on the account used containers. */
export function containerOverage(r: ContainerResources): number {
	const over = (k: keyof ContainerResources) => Math.max(0, r[k] - CONTAINER_INCLUDED[k]);
	return containerCost({ memoryGiBs: over("memoryGiBs"), vcpuS: over("vcpuS"), diskGBs: over("diskGBs") });
}

/** The resources of Container tests runs, summed. */
export function boxResources(u: Pick<ContainerUsage, "memoryGiBs" | "diskGBs" | "cpuUs">): ContainerResources {
	return { memoryGiBs: u.memoryGiBs, vcpuS: u.cpuUs / 1_000_000, diskGBs: u.diskGBs };
}
