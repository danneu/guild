// Koa deps
var app = require('koa')();
app.poweredBy = false;
app.use(require('koa-static')('public'));
app.use(require('koa-logger')());
app.use(require('koa-body')());
app.use(require('koa-methodoverride')('_method'));
var route = require('koa-route');
var views = require('koa-views');
// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:index');
var assert = require('better-assert');
// 1st party
// ...

// Configure templating system to use `swig`
// and to find view files in `view` directory
app.use(views('../../views', {
  default: 'html',  // Default extension is .html
  cache: (process.env.NODE_ENV === 'production' ? 'memory' : undefined), // consolidate bug hack
  map: { html: 'swig' }
}));

app.use(route.get('/', function* () {
  this.body = 'Hello world';
}));

app.listen(3000);
console.log('Listening on 3000');
