declare module "plantuml-encoder" {
  export function encode(diagramSource: string): string;
  export function decode(encoded: string): string;
  const _default: { encode: typeof encode; decode: typeof decode };
  export default _default;
}
