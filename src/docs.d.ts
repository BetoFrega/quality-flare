/** The pages of docs/, rendered to HTML by build/docs.ts. */
declare module "virtual:docs" {
	const pages: { slug: string; title: string; html: string }[];
	export default pages;
}
