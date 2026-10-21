/** The pages of docs/, rendered to HTML by build/docs.ts. */
declare module "virtual:docs" {
	const pages: { slug: string; section: string; title: string; html: string }[];
	export default pages;
}

/** An image as a data: URL, inlined by Vite at build time. */
declare module "*.png?inline" {
	const dataUrl: string;
	export default dataUrl;
}
