const gulp = require('gulp')
const concat = require('gulp-concat')
const rev = require('gulp-rev')
const minifyCss = require('gulp-cssnano')
const uglifyJs = require('gulp-uglify')
const del = require('del')
const vinylPaths = require('vinyl-paths')

gulp.task('reset-dist', () => {
  return del(['dist/**/*'])
})

gulp.task('copy-fonts:bootstrap', ['reset-dist'], () => {
  return gulp.src(['public/vendor/bootstrap/fonts/**'], {
    base: 'public/vendor/bootstrap'
  })
    .pipe(gulp.dest('dist'))
})

gulp.task('copy-fonts:font-awesome', ['reset-dist'], () => {
  return gulp.src(['public/vendor/font-awesome/fonts/**'], {
    base: 'public/vendor/font-awesome'
  })
    .pipe(gulp.dest('dist'))
})

gulp.task('copy-fonts', ['copy-fonts:bootstrap', 'copy-fonts:font-awesome'])


gulp.task('build-css', ['copy-fonts'], () => {
  const cssPaths = [
    'public/vendor/bootstrap/css/bootstrap.css',
    'public/vendor/bootstrap/css/bootstrap-theme.css',
    'public/vendor/font-awesome/css/font-awesome.css',
    'public/vendor/bootstrap-markdown/css/bootstrap-markdown.min.css',
    'public/css/bootstrap_overrides.css',
    'public/css/general.css'
  ]
  return gulp.src(cssPaths)
      .pipe(concat('all.css'))
      .pipe(minifyCss())
      .pipe(gulp.dest('dist'))
})

gulp.task('build-js', () => {
  const jsPaths = [
    'public/vendor/lodash-4.17.4.min.js',
    'public/vendor/jquery/jquery-2.1.3.min.js',
    'public/vendor/jquery-hotkeys/jquery.hotkeys.js',
    'public/vendor/markdown/markdown.js',
    'public/vendor/bootstrap-markdown/js/bootstrap-markdown.js',
    'public/vendor/jquery-appear/jquery.appear.js',
    'public/vendor/bootstrap/js/bootstrap.js',
    'public/vendor/js/bootstrap.js',
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
  return gulp.src(jsPaths)
    .pipe(concat('all.js'))
    .pipe(uglifyJs())
    .pipe(gulp.dest('dist'))
})

gulp.task('build-chat-js', () => {
  const paths = [
    'public/js/chat.js'
  ]
  return gulp.src(paths)
    .pipe(concat('chat.js'))
    .pipe(uglifyJs())
    .pipe(gulp.dest('dist'))
})

gulp.task('build-assets', [
  'reset-dist',
  'build-css', 'build-js', 'build-chat-js'
], () => {
  return gulp.src(['dist/all.css', 'dist/all.js', 'dist/chat.js'])
  .pipe(vinylPaths(del))
  .pipe(rev())
  .pipe(gulp.dest('dist'))
  .pipe(rev.manifest())
  .pipe(gulp.dest('dist'))
})
