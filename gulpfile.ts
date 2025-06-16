import gulp from "gulp";
const { src, dest, series, parallel } = gulp;
import concat from "gulp-concat";
import rev from "gulp-rev";
import minifyCss from "gulp-cssnano";
import uglifyJs from "gulp-uglify";
import { deleteAsync } from "del";
import vinylPaths from "vinyl-paths";

// Important: Keep in sync with views/layouts/master.html

function clean() {
  return deleteAsync(["dist/**/*"]);
}

function copyFonts() {
  return src(
    ["public/vendor/bootstrap/fonts/**", "public/vendor/font-awesome/fonts/**"],
    {
      // Don't decode as utf-8; keep as binary
      encoding: false,
    },
  ).pipe(dest("dist/fonts"));
}

function copyVendorDeps() {
  return src([
    "node_modules/autolinker/dist/autolinker.min.js",
    "node_modules/lodash/lodash.min.js",
  ]).pipe(dest("public/vendor/"));
}

async function copyServerFiles() {
  await src("server/bbcode.js").pipe(dest("public/vendor/xbbcode/xbbcode/"));
  await src("server/ago.js").pipe(dest("public/js/"));
}

function buildCss() {
  const cssPaths = [
    "public/vendor/bootstrap/css/bootstrap.css",
    "public/vendor/bootstrap/css/bootstrap-theme.css",
    "public/vendor/font-awesome/css/font-awesome.css",
    "public/vendor/bootstrap-markdown/css/bootstrap-markdown.min.css",
    "public/css/bootstrap_overrides.css",
    "public/css/general.css",
  ];
  return src(cssPaths)
    .pipe(concat("all.css"))
    .pipe(minifyCss())
    .pipe(dest("dist"));
}

function buildJs() {
  const jsPaths = [
    "public/vendor/lodash.min.js",
    "public/vendor/jquery/jquery-2.1.3.min.js",
    "public/vendor/jquery-hotkeys/jquery.hotkeys.js",
    "public/vendor/markdown/markdown.js",
    "public/vendor/bootstrap-markdown/js/bootstrap-markdown.js",
    "public/vendor/jquery-appear/jquery.appear.js",
    "public/vendor/bootstrap/js/bootstrap.js",
    // 'public/vendor/js/bootstrap.js',
    "public/vendor/autolinker.min.js",
    "public/vendor/xbbcode/xbbcode/bbcode.js", // Copied from server/bbcode.js
    // Don't bundle typeahead since it's just used on edit_topic.js right now
    // 'public/vendor/typeahead/typeahead.bundle.js',
    "public/js/bbcode_editor.js",
    // Draft Auto-save
    "public/js/store/index.js",
    // ago.js is copied from server/ago.js
    "public/js/ago.js",
  ];
  return src(jsPaths)
    .pipe(concat("all.js"))
    .pipe(uglifyJs())
    .pipe(dest("dist"));
}

const buildAssets = series(
  clean,
  parallel(copyVendorDeps, copyServerFiles),
  parallel(copyFonts, buildCss, buildJs),
  manifest,
);

function manifest() {
  return src(["dist/all.css", "dist/all.js"])
    .pipe(vinylPaths(deleteAsync))
    .pipe(rev())
    .pipe(dest("dist"))
    .pipe(rev.manifest())
    .pipe(dest("dist"));
}

export { clean, copyFonts, copyVendorDeps, copyServerFiles, buildCss, buildJs };
export default buildAssets;
