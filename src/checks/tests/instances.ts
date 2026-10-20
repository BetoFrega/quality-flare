/**
 * Containers' instance types (https://developers.cloudflare.com/containers/platform-details/limits/), those a
 * container can start with (ContainerStartupOptions' `instance`: no "basic").
 */
export const INSTANCES = {
	lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
	"standard-1": { vcpu: 1 / 2, memoryGiB: 4, diskGB: 8 },
	"standard-2": { vcpu: 1, memoryGiB: 6, diskGB: 12 },
	"standard-3": { vcpu: 2, memoryGiB: 8, diskGB: 16 },
	"standard-4": { vcpu: 4, memoryGiB: 12, diskGB: 20 },
} as const;
export type InstanceType = keyof typeof INSTANCES;

/**
 * A run's instance type unless the config's `instance` picks another. A smaller one costs about the same: memory
 * is billed for the time it runs, and the same CPU takes longer.
 */
export const DEFAULT_INSTANCE: InstanceType = "standard-4";

/** The size of an instance type; runs recorded before the type was configurable ran on the default. */
export function instanceSize(name: string | null | undefined): (typeof INSTANCES)[InstanceType] {
	return INSTANCES[(name ?? DEFAULT_INSTANCE) as InstanceType] ?? INSTANCES[DEFAULT_INSTANCE];
}
