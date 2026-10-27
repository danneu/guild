// tell typescript that ctx.response.back(url) exists
// new in koa v3 but @types/koa are old
declare module "koa" {
  interface Response {
    back(url: string): void;
  }
  interface Context {
    back(url: string): void;
    // server/middleware/flash.ts. A route sets a Flash; a page reads back
    // what the cookie held.
    get flash(): any;
    set flash(val: import("../middleware/flash").Flash);
  }
}

declare module "@koa/router" {
  interface RouterContext {
    back(url: string): void;
  }
}

// This empty export makes the file a module instead of a script,
// which is required for declare module augmentation to work properly
export {};
