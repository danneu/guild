var gulp = require('gulp');
var concat = require('gulp-concat');
var rev = require('gulp-rev');
var minifyCSS = require('gulp-minify-css');
var uglifyJS = require('gulp-uglify');

gulp.task('copy-fonts', function() {
  var fontPaths = [
    './public/vendor/bootstrap/fonts/**',
    './public/vendor/font-awesome/fonts/**'
  ];
  gulp.src(fontPaths)
      .pipe(gulp.dest('./dist/fonts/'));
});

gulp.task('build-css', ['copy-fonts'], function() {
  var cssPaths = [
    './public/vendor/bootstrap/css/bootstrap.css',
    './public/vendor/bootstrap/css/bootstrap-theme.css',
    './public/vendor/font-awesome/css/font-awesome.css',
    './public/vendor/bootstrap-markdown/css/bootstrap-markdown.min.css',
    './public/css/bootstrap_overrides.css',
    './public/css/general.css'
  ];
  gulp.src(cssPaths)
      .pipe(concat('all.css'))
      .pipe(minifyCSS())
      .pipe(gulp.dest('./dist/'));
});

gulp.task('build-js', function() {
  var jsPaths = [
    'public/vendor/jquery/jquery-2.1.3.min.js',
    'public/vendor/jquery-hotkeys/jquery.hotkeys.js',
    'public/vendor/timeago/jquery.timeago.js',
    'public/vendor/markdown/markdown.js',
    'public/vendor/bootstrap-markdown/js/bootstrap-markdown.js',
    'public/vendor/jquery-appear/jquery.appear.js',
    'public/vendor/bootstrap/js/bootstrap.js',
    'public/vendor/xbbcode/xbbcode/bbcode.js', // Symlinked to server/bbcode.js
    'public/js/bbcode_editor.js'
  ];
  gulp.src(jsPaths)
      .pipe(concat('all.js'))
      .pipe(uglifyJS())
      .pipe(gulp.dest('./dist/'));
});

//
// Note: I usually have to run `gulp build-assets` twice for it
// to work. Need to look into why.
//
gulp.task('build-assets', ['build-css', 'build-js'], function() {
  gulp.src(['dist/all.css', 'dist/all.js'])
  .pipe(rev())
  .pipe(gulp.dest('dist'))
  .pipe(rev.manifest())
  .pipe(gulp.dest('dist'));
});
