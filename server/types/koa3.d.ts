// tell typescript that ctx.response.back(url) exists
// new in koa v3 but @types/koa are old
declare module "koa" {
  interface Response {
    back(url: string): void;
  }
  interface Context {
    back(url: string): void;
  }
}

// This empty export makes the file a module instead of a script,
// which is required for declare module augmentation to work properly
export {};
