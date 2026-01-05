declare module "m3u8-parser" {
  export class Parser {
    manifest: unknown;
    push(input: string): void;
    end(): void;
  }
}

declare module "mux.js" {
  const muxjs: unknown;
  export default muxjs;
}
