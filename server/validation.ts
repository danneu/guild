"use strict";
// 3rd party
import _ from "lodash";
// import createDebug from 'debug'
// const debug = createDebug('app:validation')
import { Validator } from "koa-bouncer";
// 1st party

////////////////////////////////////////////////////////////
// Util ////////////////////////////////////////////////////
////////////////////////////////////////////////////////////

// Collapses 2+ spaces into 1
// Ex: 'a   b   c' -> 'a b c'
// function collapseSpaces(str: string) {
//     return str.replace(/\s{2,}/g, ' ')
// }

// // Removes any whitespace in the string
// function removeWhitespace(str: string) {
//     return str.replace(/\s/g, '')
// }

////////////////////////////////////////////////////////////
// Custom koa-validate validators //////////////////////////
////////////////////////////////////////////////////////////

Validator.addMethod("notEq", function (otherVal, tip) {
  this.checkPred((val) => val !== otherVal, tip);
  return this;
});
