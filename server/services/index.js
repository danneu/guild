
//
// Services are higher-level modules that glue together components
// so that routes don't have to.
//
// For example, routes shouldn't have to initialize an API client
// every single time. Instead it's better to centralize that sort of
// thing into a service function so that client initialization is
// implemeneted in one place.
//
// TODO: Move akismet spam-check here.
//

module.exports = {
  discord: require('./discord')
}
