/**
 * New Relic agent configuration.
 *
 * See lib/config.defaults.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
exports.config = {
  /**
   * Array of application names. (Override with NEW_RELIC_APP_NAME)
   */
  app_name : ['localhost-guild'],
  /**
   * Your New Relic license key. (Override with NEW_RELIC_LICENSE_KEY)
   */
  license_key : '',
  logging : {
    /**
     * Level at which to log. 'trace' is most useful to New Relic when diagnosing
     * issues with the agent, 'info' and higher will impose the least overhead on
     * production applications.
     */
    level : 'info'
  }
};
