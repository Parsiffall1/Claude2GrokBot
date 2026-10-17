// Text modules bundled by wrangler ("rules" in wrangler.jsonc) and by the test shim.
declare module "*.py" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
