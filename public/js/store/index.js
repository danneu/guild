
function Store (namespace) {
  this.namespace = namespace
  this.setTries = 0
}

//
// Static
//

Store.isSupported = function () {
  var key = 'test'
  try {
    localStorage.setItem(key, key)
    localStorage.removeItem(key)
    return true
  } catch (err) {
    return false
  }
}

//
// Private
//

Store.prototype._deserialize = function (str) {
  try {
    return JSON.parse(str)
  } catch (err) {
    return
  }
}

Store.prototype._serialize = function (value) {
  return JSON.stringify(value)
}

//
// Public
//

Store.prototype.remove = function (key) {
  if (!Store.isSupported()) return
  var key = this.namespace + '$' + key
  localStorage.removeItem(key)
  localStorage.removeItem(key + '$expires')
}

// Expires key if expired
// Returns value or undefined
Store.prototype.get = function (key) {
  if (!Store.isSupported()) return
  var key = this.namespace + '$' + key
  var expires = this._deserialize(localStorage.getItem(key + '$expires'))
    || Number.MAX_VALUE

  if (expires <= Date.now()) {
    this.remove(key)
    return
  }

  return this._deserialize(localStorage.getItem(key))
}

// Sets key and expiration
//
// ttl is in milliseconds (required)
Store.prototype.set = function (userKey, value, ttl) {
  if (!Store.isSupported()) return
  if (!_.isInteger(ttl)) {
    throw new Error('Store#set requires a ttl integer. key=' + key)
  }
  var key = this.namespace + '$' + userKey
  var expires = Date.now() + ttl

  try {
    localStorage.setItem(key, this._serialize(value))
    localStorage.setItem(key + '$expires', this._serialize(expires))
  } catch (err) {
    // If localStorage limit is reached, then clear store and try again
    // But only try once to avoid infinite loops if localStorage is filled
    // up by something else.
    if (/exceeded the quota/.test(err.message) && this.setTries === 0) {
      this.setTries += 1
      this.remove(userKey)
      this.set(userKey, value, ttl)
    } else {
      throw err
    }
  }
}

// Clears all keys maintain by this store
Store.prototype.clear = function () {
  var self = this
  this.keys().forEach(function (key) {
    self.remove(key)
  })
}

Store.prototype.keys = function () {
  if (!Store.isSupported()) return []
  var self = this
  var keys = []
  _.keys(localStorage).forEach(function (fullKey) {
    // Ignore localStorage keys not maintained by this Store instance
    // Ignore $expires keys
    if (_.startsWith(fullKey, self.namespace + '$') && !_.endsWith(fullKey, '$expires')) {
      var key = fullKey.replace(self.namespace + '$', '')
      keys.push(key)
    }
  })
  return keys
}

// Returns object of { key: value }
Store.prototype.dump = function () {
  if (!Store.isSupported()) return {}
  var self = this
  var o = {}
  this.keys().forEach(function (userKey) {
    o[userKey] = self.get(userKey)
  })
  return o
}

////////////////////////////////////////////////////////////

window.postDrafts = new Store('posts')
// TODO: Add pmDrafts
