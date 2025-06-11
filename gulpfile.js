const gulp = require('gulp')
const { src, dest, series, parallel } = gulp
const concat = require('gulp-concat')
const rev = require('gulp-rev')
const minifyCss = require('gulp-cssnano')
const uglifyJs = require('gulp-uglify')
const { deleteAsync } = require('del')
const vinylPaths = require('vinyl-paths')


function clean() {
    return deleteAsync(['dist/**/*'])
}

function copyFonts() {
    return src([
        'public/vendor/bootstrap/fonts/**',
        'public/vendor/font-awesome/fonts/**'
    ]).pipe(dest('dist/fonts'))
}

function buildCss () {
    const cssPaths = [
        'public/vendor/bootstrap/css/bootstrap.css',
        'public/vendor/bootstrap/css/bootstrap-theme.css',
        'public/vendor/font-awesome/css/font-awesome.css',
        'public/vendor/bootstrap-markdown/css/bootstrap-markdown.min.css',
        'public/css/bootstrap_overrides.css',
        'public/css/general.css'
    ]
    return src(cssPaths)
        .pipe(concat('all.css'))
        .pipe(minifyCss())
        .pipe(dest('dist'))
}

function buildJs() {
  const jsPaths = [
    'public/vendor/lodash-4.17.4.min.js',
    'public/vendor/jquery/jquery-2.1.3.min.js',
    'public/vendor/jquery-hotkeys/jquery.hotkeys.js',
    'public/vendor/markdown/markdown.js',
    'public/vendor/bootstrap-markdown/js/bootstrap-markdown.js',
    'public/vendor/jquery-appear/jquery.appear.js',
    'public/vendor/bootstrap/js/bootstrap.js',
    // 'public/vendor/js/bootstrap.js',
    // Symlinked to node_modules/autolinker
    'public/vendor/autolinker/dist/Autolinker.js',
    'public/vendor/xbbcode/xbbcode/bbcode.js', // Symlinked to server/bbcode.js
    // Don't bundle typeahead since it's just used on edit_topic.js right now
    // 'public/vendor/typeahead/typeahead.bundle.js',
    'public/js/bbcode_editor.js',
    // Draft Auto-save
    'public/js/store/index.js',
    // ago.js is symlinked
    'public/symlinks/ago.js'
  ]
  return src(jsPaths)
    .pipe(concat('all.js'))
    .pipe(uglifyJs())
    .pipe(dest('dist'))
}


const buildAssets = series(
    clean,
    parallel(copyFonts, buildCss, buildJs),
    manifest,
)

function manifest() {
    return src(['dist/all.css', 'dist/all.js'])
    .pipe(vinylPaths(deleteAsync))
    .pipe(rev())
    .pipe(dest('dist'))
    .pipe(rev.manifest())
    .pipe(dest('dist'))
}

exports.clean = clean
exports.copyFonts = copyFonts
exports.buildCss = buildCss
exports.buildJs = buildJs
exports.default = buildAssets
