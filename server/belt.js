// 3rd party
var promissory = require('promissory');
var assert = require('better-assert');
var _bcrypt = require('bcryptjs');

////////////////////////////////////////////////////////////
// Authentication
////////////////////////////////////////////////////////////

// Wrap bcryptjs with Promises
var bcrypt = {
  // Sig: hash(password, salt)
  hash: promissory(_bcrypt.hash),
  // Sig: compare(rawPassword, hashedPassword)
  compare: promissory(_bcrypt.compare)
};

// String (Text) -> String (Hex)
exports.hashPassword = hashPassword;
function* hashPassword(password) {
  return yield bcrypt.hash(password, 4);
}

// String -> String -> Bool
exports.checkPassword = checkPassword;
function* checkPassword(password, digest) {
  return yield bcrypt.compare(password, digest);
}

////////////////////////////////////////////////////////////

// String -> Bool
exports.isValidUuid = function(uuid) {
  var regexp = /^[a-f0-9]{8}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{12}$/;
  return regexp.test(uuid);
};
